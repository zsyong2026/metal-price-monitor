// notify_run.js —— Actions 用的数据健康巡检 + 告警入口
// 唯一严重告警来源：GH Pages 真源（GitHub Actions 每 ~1 小时自动生成并推送）是否停更。
//   真源一停，手机网页版 / 微信小程序 / 电脑网页版三端全受影响 → 才发严重提醒。
// 电脑网页版（平台只读代理）的降级不在此处告警（见 tools/check_platform.js），避免误报。
// 文案面向非技术用户：大白话说明「什么情况 / 影响谁 / 怎么办」。
// 跨轮节流：data/.alert-state.json 持久化（随数据提交）；首次立即发，持续异常每 3 小时一条汇总。
// 用法：node tools/notify_run.js check
const fs = require("fs");
const path = require("path");
const https = require("https");
const notify = require("./notify");

const DATA = path.resolve(__dirname, "..", "data");
// 唯一可信真源 = GH Pages（GitHub Actions 每 ~1 小时生成并推送）。本地 data/ 仅作兜底。
const GH_PAGES_CANON = "https://zsyong2026.github.io/metal-price-monitor/data";

// 节奏校准：GitHub Actions 的 schedule 虽写每 15 分钟，但低活跃仓库会被排队合并，
//   实测真实触发间隔约 52~81 分钟。价格阈值取 120 分钟留足余量（避免偶发排队误报）；
//   事件源本身更新更慢，取 240 分钟。
//   【2026-11-05】页面「最新价」已改为每 1 分钟直连实时现货（旁路），不影响本巡检：
//   这里判的仍是「真源数据是否停更」（三端曲线 / 事件 / 校验），阈值维持小时级，不要因为
//   看到「1 分钟」就把这里收紧，否则真源正常排队一次就会误报。
const PRICE_STALE_MIN = 120;  // 价格真源：实测约 1 小时一轮
const EVENT_STALE_MIN = 240;  // 事件：事件源本身更新更慢
// 真源读取偶发网络抖动不应直接判异常（它一挂全端受影响，误报代价高）→ 重试确认
const CANON_RETRY = 2;
const CANON_RETRY_GAP_MS = 2500;
const REPEAT_ALERT_MS = 3 * 60 * 60 * 1000; // 持续异常：3 小时一条汇总
const STATE_FILE = path.join(DATA, ".alert-state.json");
const TIMEOUT_MS = 15000;

// GH Pages 真源读取（非 2xx 一律按不可达，避免把网关错误体当成功解析）
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

// 把分钟数友好地表达（≥60 分钟用「小时」）
function friendlyAge(min) {
  if (min >= 60) {
    const h = Math.round((min / 60) * 10) / 10;
    return h + " 小时";
  }
  return Math.round(min) + " 分钟";
}

(async () => {
  const mode = process.argv[2] || "check";
  // 优先读 GH Pages 真源；本地 data/ 仅作不可达时的兜底（消除冻结副本误报）
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
  // 三端统一影响说明（仅价格停更类适用）
  const scopeAll = "影响：手机网页版、微信小程序、电脑网页版目前可能显示的是稍旧的数据。";

  if (!meta) {
    problems.push("价格数据暂时读不到（手机 / 小程序 / 电脑三端都可能显示旧价格）。" +
      scopeAll + "通常是自动刷新任务或网络临时波动，稍后会自动恢复。");
  } else {
    const ageMin = meta.generatedAt ? (Date.now() - new Date(meta.generatedAt).getTime()) / 60000 : 9999;
    if (ageMin > PRICE_STALE_MIN) {
      problems.push("最新价格数据已约 " + friendlyAge(ageMin) + "没有更新（正常情况下大约每 1 小时自动刷新一次）。" +
        scopeAll + "多数会在下一轮自动恢复；若持续超过半天仍未更新，请检查自动刷新任务是否卡住。");
    }
    const bad = Object.entries((meta.sourceHealth && meta.sourceHealth.validation) || {}).filter(([, v]) => v !== "ok");
    if (bad.length) problems.push("部分品种的数据校验未通过（" + bad.map(([k, v]) => k + "：" + v).join("、") + "），相关价格可能不够准确，仅供参考。");
  }

  if (!evMeta) {
    problems.push("事件资讯数据暂时读不到（不影响价格数据）。");
  } else {
    const ageMin = evMeta.updatedAt ? (Date.now() - new Date(evMeta.updatedAt).getTime()) / 60000 : 9999;
    if (ageMin > EVENT_STALE_MIN) {
      problems.push("事件资讯已约 " + friendlyAge(ageMin) + "没有更新（事件源本身更新较慢）。新事件可能延迟出现，不影响价格数据。");
    }
    const fresh = (evMeta.sources || []).filter((s) => !s.stale).length;
    if (!fresh) problems.push("事件资讯的所有来源都暂时停更，新的事件将无法入库（不影响价格数据）。");
  }

  if (mode === "check") {
    const now = Date.now();
    const st = readState();
    if (!problems.length) {
      // 【2026-11-05】健康时不必每轮写盘：lastOkAt 仅供恢复判定，
      //   每 15 分钟写一次会让「状态回写」步骤每轮制造一次无意义提交。
      //   仅在「刚从异常恢复」或「距上次记录超过 1 小时」时落盘。
      if (st.streak > 0 || now - (st.lastOkAt || 0) > 60 * 60 * 1000) {
        writeState({ lastAlertAt: st.lastAlertAt, lastOkAt: now, streak: 0 });
      }
      console.log("[notify] 数据健康：价格/事件均在预期周期内更新，校验通过，无需告警");
      process.exit(0);
    }
    // 首次异常立即发；持续异常每 3 小时一条汇总
    const firstAfterOk = st.streak === 0 || now - st.lastAlertAt > REPEAT_ALERT_MS;
    writeState({ lastAlertAt: firstAfterOk ? now : st.lastAlertAt, lastOkAt: st.lastOkAt, streak: st.streak + 1 });
    if (!firstAfterOk) {
      console.log("[notify] 持续异常（第 " + (st.streak + 1) + " 轮），3 小时内已告警过，本轮静默");
      process.exit(0);
    }
    const detail = problems.map((p) => "• " + p).join("\n\n") + "\n\n（自动监测 · 贵金属价格监测）";
    const r = await notify.alert("贵金属数据更新提醒", detail, "data-health");
    console.log("[notify] 告警结果：" + JSON.stringify(r));
    process.exit(r.ok ? 0 : 2);
  }
})();
