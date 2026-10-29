// push_brief.js —— 8–18 点每 2 小时的金银铜数据简报推送（微信域内）
// 数据源：data/*.json（Actions refresh job 刚提交的最新版）+ events.meta.json
// 通道：企业微信 Webhook 机器人（主）/ Server酱（备）；均未配置则仅日志留痕。
// 用法：node tools/push_brief.js
const fs = require("fs");
const path = require("path");
const notify = require("./notify");

const DATA = path.resolve(__dirname, "..", "data");

function readJSON(f) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf-8")); }
  catch (e) { return null; }
}
const CN = { gold: "黄金", silver: "白银", copper: "铜" };
function lastOf(arr) { return arr && arr.length ? arr[arr.length - 1] : null; }
function prevOf(arr) { return arr && arr.length > 1 ? arr[arr.length - 2] : null; }

(async () => {
  const meta = readJSON("meta.json");
  const evMeta = readJSON("events.meta.json");
  const lines = [];
  const updated = meta && meta.generatedAt ? meta.generatedAt.replace("T", " ").slice(5, 16) : "—";
  for (const m of ["gold", "silver", "copper"]) {
    const d = readJSON(m + ".json");
    if (!d) continue;
    const s = (d.series && d.series.domestic) || (d.series && d.series.london) || [];
    const last = lastOf(s), prev = prevOf(s);
    if (!last) continue;
    const pct = prev ? ((last[1] - prev[1]) / prev[1]) * 100 : 0;
    const unit = m === "copper" ? "元/吨" : (d.unit && d.unit.domestic) || "";
    const sign = pct >= 0 ? "📈" : "📉";
    lines.push(sign + " **" + CN[m] + "** " + last[1].toLocaleString("zh-CN") + " " + unit +
      "（日涨跌 " + (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%）");
  }
  // 最新一条重大事件（事件正本只存一份，取三品种合并后最新）
  const events = readJSON("events.json") || {};
  let latestEv = null;
  for (const k of Object.keys(events)) {
    for (const e of (events[k] || [])) {
      if (!latestEv || e.date > latestEv.date) latestEv = e;
    }
  }
  const evLine = latestEv
    ? "\n**最新事件**（" + latestEv.date + "）" + latestEv.title + "｜" + latestEv.category +
      "｜" + (latestEv.impact === "up" ? "利多" : latestEv.impact === "down" ? "利空" : "中性")
    : "";

  const text =
    "**📊 金属数据简报**（" + updated + " 更新）\n" +
    lines.join("\n") + evLine +
    "\n\n> 数据更新至 " + updated + "；事件更新至 " +
    (evMeta && evMeta.latestEventDate ? evMeta.latestEventDate : "—") +
    "\n> 详细走势：https://zsyong2026.github.io/metal-price-monitor/";

  const r = await notify.send("金属数据简报", text);
  console.log("[push] 推送结果：" + JSON.stringify(r));
  process.exit(r.ok ? 0 : (r.via === "log" ? 0 : 2));
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
