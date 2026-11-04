// notify_run.js —— Actions 用的数据健康巡检 + 告警入口
// 检查项：
//   1) 价格数据停更：meta.json.generatedAt 距现在超过 45 分钟（Actions 每 15 分钟一轮，超时即异常）
//   2) 事件数据停更：events.meta.json.updatedAt 距现在超过 2 小时（事件每小时一轮）
//   3) 数据校验未过：meta.sourceHealth.validation 有非 ok 项
//   4) 事件源全停：events.meta.sources 无新鲜源（fresh=0）
// 全部正常则不发消息（避免无消息=好消息的骚扰）。任何异常 → notify.alert（企业微信/Server酱）。
// 跨轮节流：异常状态经 data/.alert-state.json 持久化（随数据提交）——
//   首次异常立即发；持续异常每 3 小时发一条汇总；恢复后重置。
// 用法：node tools/notify_run.js check
const fs = require("fs");
const path = require("path");
const https = require("https");
const notify = require("./notify");

const DATA = path.resolve(__dirname, "..", "data");
// 【C42 根治「数据更新异常」误报】唯一可信真源 = GH Pages（由 GitHub Actions 每 15 分钟生成并推送）。
//   本脚本以 GH Pages 为准判新鲜度；本地 data/ 仅作「GH Pages 不可达」时的兜底，
//   彻底消除「读本地冻结副本（workspace / 某临时副本）误报『数据更新异常』」的伪告警
//   （此前本地 data/ 卡在 11-03 09:46，干跑就报『价格数据已 891 分钟未更新』）。
//   与 check_platform.js 同一口径，从源头统一判据。
const GH_PAGES_CANON = "https://zsyong2026.github.io/metal-price-monitor/data";

// 【阈值口径（按实测校准）】GitHub Actions 的 schedule 虽写 */15，但低活跃仓库会被排队合并，
//   实测真实触发间隔为 52~81 分钟（2026-11-03/04 连续 22 轮 schedule 的 created_at 差值），
//   并非 15 分钟。
//   故价格陈旧阈值取 120 分钟（原 90 分钟仅比实测最大值多 9 分钟余量，
//   Actions 稍有排队就会误报「数据更新异常」—— 用户此前被这类误报反复打扰）；
//   事件陈旧阈值取 240 分钟（事件源本身按更慢节奏更新）。
//   真正细粒度的异常由 check_platform.js 的「平台同步失败 / 平台落后真源」覆盖。
const PRICE_STALE_MIN = 120;  // 价格真源：Actions 实测 52~81 分钟一轮，留足排队余量
const EVENT_STALE_MIN = 240;  // 事件：事件源本身按更慢节奏更新
// 【C44】真源读取的重试确认：单次网络抖动不应直接判「数据异常」。
const CANON_RETRY = 2;
const CANON_RETRY_GAP_MS = 2500;
const REPEAT_ALERT_MS = 3 * 60 * 60 * 1000; // 持续异常：3 小时一条汇总
const STATE_FILE = path.join(DATA, ".alert-state.json");
const TIMEOUT_MS = 15000;

// GH Pages 真源读取（与 check_platform.js 同口径：非 2xx 一律按不可达，避免把网关错误体当成功解析）
// 【C43】与平台侧同源的隐患加固：req 先声明再引用（避免 TDZ）+ 统一 settle 出口 + 超时清定时器。
function getJSON(url) {
  return new Promise((resolve) => {
    let req = null;
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; clearTimeout(t); resolve(v); };
    const t = setTimeout(() => { try { if (req) req.destroy(); } catch (e) { /* ignore */ } done(null); }, TIMEOUT_MS);
    try {
      req = https.get(url, { headers: { "User-Agent": "metals-notify/1.0" } }, (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) { done(null); return; }
          try { done(JSON.parse(body)); } catch (e) { done(null); }
        });
        res.on("error", () => done(null));
      });
      req.on("error", () => done(null));
    } catch (e) {
      done(null);
    }
  });
}

function readJSON(f) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf-8")); }
  catch (e) { return null; }
}
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")); }
  catch (e) { return { lastAlertAt: 0, lastOkAt: 0, streak: 0 }; }
}
function writeState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { /* 忽略 */ }
}

(async () => {
  const mode = process.argv[2] || "check";
  // 【C42】优先读 GH Pages 真源；本地 data/ 仅作不可达时的兜底（消除冻结副本误报）
  // 【C44·重试确认】真源读取偶发网络抖动会让单次读取失败，而真源是"最不该误报"的对象
  //   （它一挂全端受影响，误报代价高）。单次失败先重试（最多 CANON_RETRY 次），
  //   仍失败才走本地兜底 / 判异常。
  async function fetchCanon(file) {
    for (let i = 0; i <= CANON_RETRY; i++) {
      const j = await getJSON(GH_PAGES_CANON + "/" + file + "?_ts=" + Date.now());
      if (j) return j;
      if (i < CANON_RETRY) await new Promise((r) => setTimeout(r, CANON_RETRY_GAP_MS));
    }
    return null;
  }
  let meta = await fetchCanon("meta.json");
  if (!meta) { meta = readJSON("meta.json"); if (meta) console.warn("[notify] GH Pages 不可达，回退本地 data/ 副本判新鲜度"); }
  let evMeta = await fetchCanon("events.meta.json");
  if (!evMeta) { evMeta = readJSON("events.meta.json"); if (evMeta) console.warn("[notify] GH Pages 不可达，回退本地 events 副本"); }
  const problems = [];

  if (!meta) problems.push("价格 meta.json 缺失");
  else {
    const ageMin = meta.generatedAt ? (Date.now() - new Date(meta.generatedAt).getTime()) / 60000 : 9999;
    if (ageMin > PRICE_STALE_MIN) problems.push("价格数据已 " + Math.round(ageMin) + " 分钟未更新（阈值 " + PRICE_STALE_MIN + "）");
    const bad = Object.entries((meta.sourceHealth && meta.sourceHealth.validation) || {}).filter(([, v]) => v !== "ok");
    if (bad.length) problems.push("品种校验未过：" + bad.map(([k, v]) => k + "=" + v).join("、"));
  }

  if (!evMeta) problems.push("事件 events.meta.json 缺失");
  else {
    const ageMin = evMeta.updatedAt ? (Date.now() - new Date(evMeta.updatedAt).getTime()) / 60000 : 9999;
    if (ageMin > EVENT_STALE_MIN) problems.push("事件数据已 " + Math.round(ageMin) + " 分钟未更新（阈值 " + EVENT_STALE_MIN + "）");
    const fresh = (evMeta.sources || []).filter((s) => !s.stale).length;
    if (!fresh) problems.push("事件源全部停更（" + (evMeta.sources || []).map((s) => s.name).join("、") + "），新事件将无法入库");
  }

  if (mode === "check") {
    const now = Date.now();
    const st = readState();
    if (!problems.length) {
      writeState({ lastAlertAt: st.lastAlertAt, lastOkAt: now, streak: 0 });
      console.log("[notify] 数据健康：价格/事件均在预期周期内更新，校验通过，无需告警");
      process.exit(0);
    }
    // 异常：首次立即发；持续异常每 3 小时一条汇总
    const firstAfterOk = st.streak === 0 || now - st.lastAlertAt > REPEAT_ALERT_MS;
    writeState({ lastAlertAt: firstAfterOk ? now : st.lastAlertAt, lastOkAt: st.lastOkAt, streak: st.streak + 1 });
    if (!firstAfterOk) {
      console.log("[notify] 持续异常（第 " + (st.streak + 1) + " 轮），3 小时内已告警过，本轮静默");
      process.exit(0);
    }
    const detail = problems.map((p) => "- " + p).join("\n") +
      (st.streak > 0 ? "\n- 已持续异常 " + st.streak + " 轮" : "") +
      "\n\n仓库：metal-price-monitor（GitHub Actions 例行刷新）\n运行：" +
      (process.env.GITHUB_RUN_ID ? "https://github.com/zsyong2026/metal-price-monitor/actions/runs/" + process.env.GITHUB_RUN_ID : "本地");
    const r = await notify.alert("金属数据更新异常", detail, "data-health");
    console.log("[notify] 告警结果：" + JSON.stringify(r));
    process.exit(r.ok ? 0 : 2);
  }
})();
