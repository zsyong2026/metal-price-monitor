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
const notify = require("./notify");

const DATA = path.resolve(__dirname, "..", "data");
const PRICE_STALE_MIN = 45;   // 价格例行 15 分钟一轮
const EVENT_STALE_MIN = 120;  // 事件例行 60 分钟一轮
const REPEAT_ALERT_MS = 3 * 60 * 60 * 1000; // 持续异常：3 小时一条汇总
const STATE_FILE = path.join(DATA, ".alert-state.json");

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
  const meta = readJSON("meta.json");
  const evMeta = readJSON("events.meta.json");
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
