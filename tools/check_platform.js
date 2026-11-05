// check_platform.js —— 电脑网页版（平台只读代理）健康巡检
// ==================================================================
// 背景（重要，决定了本脚本的判据口径）：
//   价格数据的唯一真源 = GitHub Actions 自动生成并推送的 GH Pages 数据。
//   手机网页版与微信小程序直接读取该真源，【不受本平台影响】。
//   本平台（metal-price-monitor.app.workbuddy.host）只是「电脑网页版」的数据源（只读代理），
//   它从真源同步数据后提供给电脑浏览器。因此：本平台出问题 → 只影响电脑网页版。
//
// 职责：仅巡检「电脑网页版数据源」是否降级，并以【低优先级提示】告知，
//   绝不把它当作「数据停更」级别的严重告警（那类告警由 tools/notify_run.js 负责，直接查 GH Pages 真源）。
//   这样可彻底避免把「电脑网页版临时慢一点」误报成「数据故障」吓到人。
//
// 文案面向非技术用户：明确「仅影响电脑网页版，手机/小程序不受影响」。
// 运行：node tools/check_platform.js
const notify = require("./notify");

const PLATFORM_HOST = "metal-price-monitor.app.workbuddy.host";
const SHARE = "POOW32T4LI";
const GH_PAGES_CANON = "https://zsyong2026.github.io/metal-price-monitor/data";
const TIMEOUT_MS = 15000;
// 电脑网页版落后真源超过 60 分钟才提示（它每 15 分钟同步一次，正常落后 < 15 分钟）
const DRIFT_WARN_MIN = 60;
// 平台刚重启时的宽限期：新副本启动后几秒内就能同步好，期间不算故障（避免部署后误报）
const COLD_START_GRACE_MIN = 20;
// 部署滚动更新窗口内新旧副本并存，单次采样会随机命中旧副本 → 采样多次取数据最新的一份
const PROBE_SAMPLES = 4;
// 真源读取偶发网络抖动不应误判（真源停更有 notify_run.js 负责，这里只是做对比参考）
const CANON_RETRY = 2;
const CANON_RETRY_GAP_MS = 2500;

function getJSON(url) {
  return new Promise((resolve) => {
    let req = null;
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; clearTimeout(t); resolve(v); };
    const t = setTimeout(() => { try { if (req) req.destroy(); } catch (e) { /* ignore */ } done(null); }, TIMEOUT_MS);
    try {
      req = require("https").get(url, { headers: { "User-Agent": "metals-check/1.0" } }, (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          // 非 2xx（含网关 403/404 错误体）一律按不可达，避免把错误体当成功解析
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

// 平台采样：连发 N 次，取数据最新的一份副本作为判定依据（规避滚动更新误判）
async function samplePlatform(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const h = await getJSON("https://" + PLATFORM_HOST + "/api/health?sharecode=" + SHARE);
    const g = await getJSON("https://" + PLATFORM_HOST + "/api/data/gold?sharecode=" + SHARE);
    if (h) out.push(Object.assign({}, h, { gold: g }));
    if (i < n - 1) await new Promise((r) => setTimeout(r, 400));
  }
  return out;
}

function ageMin(iso) {
  if (!iso) return NaN;
  const t = Date.parse(iso);
  if (isNaN(t)) return NaN;
  return (Date.now() - t) / 60000;
}

(async () => {
  const notes = []; // 低优先级提示（非严重告警）

  // 先确认真源本身是否健康（仅供参考，不在此告警——真源停更由 notify_run.js 负责）
  let canon = null;
  for (let i = 0; i <= CANON_RETRY; i++) {
    canon = await getJSON(GH_PAGES_CANON + "/meta.json");
    if (canon) break;
    if (i < CANON_RETRY) await new Promise((r) => setTimeout(r, CANON_RETRY_GAP_MS));
  }
  if (!canon) {
    console.warn("[check_platform] 真源（GH Pages）暂时读不到，跳过电脑网页版对比，不代表数据停更");
  }

  const samples = await samplePlatform(PROBE_SAMPLES);
  // 取数据最新的一份副本（部署滚动更新期间新旧副本并存，取最优避免误判）
  let health = null, gold = null;
  for (const s of samples) {
    if (!s) continue;
    const sTs = ((s.updatedAt || {})["meta.json"]) || "";
    const hTs = (health && ((health.updatedAt || {})["meta.json"] || "")) || "";
    if (!health || sTs > hTs) { health = s; gold = s.gold; }
  }

  if (!health) {
    notes.push("电脑网页版数据源暂时连不上（不影响手机网页版和微信小程序，它们直接读最新数据）。" +
      "通常是网页托管服务临时波动，会自动恢复。");
  } else {
    const coldStart = !health.generatedAt;
    const upMin = health.processStartAt ? ageMin(health.processStartAt) : NaN;
    const coldStartExpired = coldStart && (!isNaN(upMin) && upMin > COLD_START_GRACE_MIN);

    if (coldStart && !coldStartExpired) {
      console.log("[check_platform] 电脑网页版刚重启，尚在同步，本轮不提示");
    } else if (health.lastGenOk === false) {
      // 平台自报最近一轮真源同步失败：仅影响电脑网页版
      notes.push("电脑网页版最近一次同步最新数据失败，目前可能显示的是稍旧的价格" +
        "（仅电脑网页版受影响；手机网页版与微信小程序仍为最新）。" +
        "通常是托管服务临时出网问题，会自动重试恢复。");
    }

    // 数据漂移：电脑网页版落后真源多少（仅作提示，不报严重）
    const platTs = (gold && (gold.lastUpdate || (gold.meta && gold.meta.generatedAt))) ||
      ((health.updatedAt || {})["gold.json"]);
    if (platTs && canon && canon.generatedAt) {
      const drift = ageMin(platTs) - ageMin(canon.generatedAt); // 正 = 电脑网页版落后于真源
      if (coldStart && !coldStartExpired) {
        console.log("[check_platform] 电脑网页版冷启动中，不判定漂移");
      } else if (health.lastGenOk !== false && drift > DRIFT_WARN_MIN) {
        notes.push("电脑网页版显示的价格比最新数据慢约 " + Math.round(drift) + " 分钟" +
          "（仅电脑网页版；手机网页版与微信小程序已是最新）。" +
          "原因通常是网页托管服务临时同步延迟，一般几分钟内自愈。");
      }
    }
  }

  if (notes.length) {
    console.warn("[check_platform] 电脑网页版数据源提示 " + notes.length + " 项：");
    notes.forEach((n) => console.warn("  · " + n));
    try {
      const r = await notify.alert(
        "电脑网页版数据源提示",
        notes.join("\n\n") + "\n\n（自动监测 · 贵金属价格监测 · 仅影响电脑网页版）",
        "platform-pc"
      );
      console.log("[check_platform] 提示发送结果：" + JSON.stringify(r));
    } catch (e) {
      console.warn("[check_platform] 提示发送失败：" + (e && e.message));
    }
  } else {
    console.log("[check_platform] 电脑网页版数据源正常（手机网页版 / 微信小程序不受影响）");
  }
})();
