// check_platform.js —— 电脑网页版（平台只读代理）健康巡检
// ==================================================================
// 背景（重要，决定了本脚本的判据口径）：
//   价格数据的唯一真源 = GitHub Actions 自动生成并推送的 GH Pages 数据。
//   手机网页版与微信小程序直接读取该真源，【不受本平台影响】。
//   本平台只是「电脑网页版」的数据源（只读代理），从真源同步后提供给电脑浏览器。
//   因此：本平台出问题 → 只影响电脑网页版，绝不是「数据停更」。
//
// 【2026-11-05 修复：告警误报刷屏】
//   原实现把已下线的老平台链接（metal-price-monitor.app.workbuddy.host + POOW32T4LI）
//   写死在代码里，实测恒定返回 HTTP 404「链接已失效」→ 4 次采样全失败 → 每轮必推
//   「电脑网页版数据源暂时连不上」，而平台与真源其实都正常。叠加线上 notify.js 旧版
//   （节流只在进程内，Actions 每轮新进程即失效）→ 每 15 分钟一条噪音告警。
//   修复：
//     ① 巡检目标改为新链接，并支持环境变量覆盖，换链接不再全员误报；
//     ② 识别「链接失效（401/403/404）」= 监控配置问题，静默留日志，绝不推业务告警；
//     ③ 真网络故障需二轮采样确认，避免单次抖动误判；
//     ④ 仅影响电脑网页版的低优先级提示默认【只写日志，不推企业微信】。
//        企业微信只保留「真源停更（三端全受影响）」与「工作流失败」两类真告警。
//        确需接收 PC 提示时设置 NOTIFY_PC_ISSUES=1（仍受 1 小时跨轮节流约束）。
//
// 运行：node tools/check_platform.js
const notify = require("./notify");

const PLATFORM_BASE = (process.env.PLATFORM_BASE || "https://metal-price-mp.app.workbuddy.host").replace(/\/+$/, "");
const SHARE = process.env.PLATFORM_SHARE || "YAC2PRXREO";
const SEND_PC_NOTICE = process.env.NOTIFY_PC_ISSUES === "1";
const GH_PAGES_CANON = "https://zsyong2026.github.io/metal-price-monitor/data";
const TIMEOUT_MS = 15000;
// 电脑网页版落后真源超过 60 分钟才提示（它每 15 分钟同步一次，正常落后 < 15 分钟）
const DRIFT_WARN_MIN = 60;
// 平台刚重启时的宽限期。实测托管环境约每 5~6 分钟回收一次进程，重启后 ~4 秒即可从真源同步完成。
// 【2026-11-05】原设 20 分钟 → 进程根本活不到 20 分钟，宽限期永不退出，巡检形同虚设
//   （线上日志每轮都是「刚重启，尚在同步，本轮不提示」）。收窄到 3 分钟：既盖住正常冷启动，
//   又能在平台真卡住时及时在日志留痕（默认仍不推企微）。
const COLD_START_GRACE_MIN = 3;
// 部署滚动更新窗口内新旧副本并存，单次采样会随机命中旧副本 → 采样多次取数据最新的一份
const PROBE_SAMPLES = 4;
// 全失败时的二次确认（间隔 + 采样次数），避免一次网络抖动就报
const CONFIRM_GAP_MS = 4000;
const CONFIRM_SAMPLES = 2;
// 真源读取偶发网络抖动不应误判（真源停更有 notify_run.js 负责，这里只是做对比参考）
const CANON_RETRY = 2;
const CANON_RETRY_GAP_MS = 2500;

// 返回 { json, status }；网络层故障返回 null（无 status 可判）
function fetchRaw(url) {
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
          const status = res.statusCode || 0;
          // 非 2xx（含网关 403/404 错误体）一律按不可达，避免把错误体当成功解析
          if (status < 200 || status >= 300) { done({ json: null, status }); return; }
          let j = null;
          try { j = JSON.parse(body); } catch (e) { /* 200 但不是 JSON：按异常响应处理 */ }
          done({ json: j, status });
        });
        res.on("error", () => done(null));
      });
      req.on("error", () => done(null));
    } catch (e) {
      done(null);
    }
  });
}

function getJSON(url) {
  return fetchRaw(url).then((r) => (r && r.json) || null);
}

// 平台采样：连发 N 次，取数据最新的一份副本作为判定依据（规避滚动更新误判）
async function samplePlatform(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const h = await fetchRaw(PLATFORM_BASE + "/api/health?sharecode=" + SHARE);
    const g = await fetchRaw(PLATFORM_BASE + "/api/data/gold?sharecode=" + SHARE);
    out.push({ h, g });
    if (i < n - 1) await new Promise((r) => setTimeout(r, 400));
  }
  return out;
}

function pickBest(samples) {
  let health = null, gold = null;
  for (const s of samples) {
    const j = s && s.h && s.h.json;
    if (!j || typeof j !== "object") continue;
    const sTs = ((j.updatedAt || {})["meta.json"]) || "";
    const hTs = (health && ((health.updatedAt || {})["meta.json"] || "")) || "";
    if (!health || sTs > hTs) { health = j; gold = (s.g && s.g.json) || null; }
  }
  return { health, gold };
}

// 401/403/404 = 分享链接失效 / 网关拒绝，属于【监控配置失效】而非业务故障。
// 这类情况必须静默：否则链接一换，就会像 2026-11-05 那样每 15 分钟误报一次。
function badConfig(samples) {
  const sts = (samples || []).map((s) => (s && s.h && typeof s.h.status === "number" ? s.h.status : 0));
  const known = sts.filter((x) => x > 0);
  if (!known.length) return { yes: false, codes: [] }; // 全超时/网络错误：不是配置问题
  const yes = known.every((x) => x === 401 || x === 403 || x === 404);
  return { yes, codes: Array.from(new Set(known)) };
}

function ageMin(iso) {
  if (!iso) return NaN;
  const t = Date.parse(iso);
  if (isNaN(t)) return NaN;
  return (Date.now() - t) / 60000;
}

(async () => {
  const notes = []; // 低优先级提示（非严重告警）
  let skippedByColdStart = false;

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

  const first = await samplePlatform(PROBE_SAMPLES);
  let best = pickBest(first);

  // 判定①：链接本身失效 → 只留日志，绝不推业务告警
  const cfg = badConfig(first);
  if (cfg.yes) {
    console.error("[check_platform] 巡检链接已失效（HTTP " + cfg.codes.join("/") + "，" + PLATFORM_BASE +
      "?sharecode=" + SHARE + "）。这是【监控配置失效】，不是数据故障，已静默不推送。" +
      "请更新 PLATFORM_BASE / PLATFORM_SHARE 后重新巡检。");
    return;
  }

  // 判定②：全失败先二次确认，避免单次网络抖动误报
  if (!best.health) {
    await new Promise((r) => setTimeout(r, CONFIRM_GAP_MS));
    const second = await samplePlatform(CONFIRM_SAMPLES);
    const all = first.concat(second);
    const cfg2 = badConfig(all);
    if (cfg2.yes) {
      console.error("[check_platform] 二轮确认：巡检链接已失效（HTTP " + cfg2.codes.join("/") + "），静默不推送。");
      return;
    }
    best = pickBest(all);
  }

  const health = best.health;
  const gold = best.gold;

  if (!health) {
    notes.push("电脑网页版数据源暂时连不上（不影响手机网页版和微信小程序，它们直接读最新数据）。" +
      "通常是网页托管服务临时波动，会自动恢复。");
  } else {
    const coldStart = !health.generatedAt;
    const upMin = health.processStartAt ? ageMin(health.processStartAt) : NaN;
    const coldStartExpired = coldStart && (!isNaN(upMin) && upMin > COLD_START_GRACE_MIN);

    if (coldStart && !coldStartExpired) {
      skippedByColdStart = true;
      console.log("[check_platform] 电脑网页版刚重启（" +
        (isNaN(upMin) ? "启动时间未知" : Math.round(upMin) + " 分钟") +
        "），冷启动宽限期内跳过判定");
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
    // 【告警纪律】仅影响电脑网页版的低优先级信息不进企业微信（用户要求「告警明确不误报」）。
    // 全端真故障由 notify_run.js 发严重告警；工作流失败由兜底步骤发告警。
    if (!SEND_PC_NOTICE) {
      console.warn("[check_platform] 该类提示默认仅留在 Actions 日志，不推送企业微信；" +
        "如确需接收可设置 NOTIFY_PC_ISSUES=1（受 1 小时跨轮节流约束）");
      return;
    }
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
  } else if (skippedByColdStart) {
    console.log("[check_platform] 本轮处于冷启动宽限期，未作判定（非故障）；手机网页版 / 微信小程序不受影响");
  } else {
    console.log("[check_platform] 电脑网页版数据源正常（手机网页版 / 微信小程序不受影响）");
  }
})();
