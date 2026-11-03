// check_platform.js —— 平台只读代理健康巡检（C37 架构）
// ==================================================================
// 背景（C37，2026-11-03）：数据真源已收归 GitHub Actions —— 每 15 分钟抓取真实行情
// （东财/新浪/现货）生成 data/*.json 并推送 GH Pages（zsyong2026.github.io/metal-price-monitor/data）。
// 平台（metal-price-monitor.app.workbuddy.host）因此退化为「只读代理 + 托管站点 + 健康上报」：
//   · 自身不再本地生成、也不再推送 GH Pages 镜像（避免用沙箱受限网络下的陈旧数据覆盖真源）；
//   · 启动即从 GH Pages 真源同步数据到缓存；若真源不可达，则退化为服务「部署时随包注入的 data/ 快照」。
//
// 因此本巡检的判定基准必须改变：
//   ① 真源新鲜度 = GH Pages meta.generatedAt（Actions 每 15 分钟产出），这是整条链路的命门；
//   ② 平台吐出的数据只需与 GH Pages 真源对齐（落后不超过一个部署窗口），平台落后即说明未同步/未重发；
//   ③ 平台不再持有推送凭据、不再推送镜像 —— 旧检查里的 mirror.ok / credential.expired /
//      lastGenOk（作为「生成器失败」）均为「平台自建生成器」时代的产物，C37 后全部失真，已移除。
//
// 运行：node tools/check_platform.js
const notify = require("./notify");
const path = require("path");
const ED = require(path.join(__dirname, "..", "js", "event-dedupe.js"));

const PLATFORM_HOST = "metal-price-monitor.app.workbuddy.host";
const SHARE = "POOW32T4LI";
const GH_PAGES_CANON = "https://zsyong2026.github.io/metal-price-monitor/data";
const MAX_AGE_MIN = 25;        // Actions 每 15 分钟一版 + 余量
// 平台落后真源的告警阈值：平台每 15 分钟全量同步一次真源（syncFromPages），
//   Actions 也是每 15 分钟产出 → 理论最大滞后 ≈ 生成 15 + 同步 15 + 延迟 ≈ 35~40 分钟；
//   另有一种可容忍情形：平台进程重启后会先回落读「部署时随包注入」的磁盘快照，
//   直到首次 syncFromPages 成功才追上真源（实测出现过一次回落 2 小时余）。
//   故阈值取 60 分钟（覆盖两个同步周期），既能放过偶发回落，又能抓住上百分钟级的真异常。
const DRIFT_WARN_MIN = 60;
const TIMEOUT_MS = 15000;

function getJSON(url) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { req.destroy(); } catch (e) { /* ignore */ } resolve(null); }, TIMEOUT_MS);
    const req = require("https").get(url, { headers: { "User-Agent": "metals-check/1.0" } }, (res) => {
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        clearTimeout(t);
        // 网关可能返回 403/404 的 JSON 错误体：能解析但字段全缺（generatedAt=null 等），
        //   若当成功解析就会误报「数据不新鲜」。故非 2xx 一律按不可达处理。
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) { resolve(null); return; }
        try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
      });
    });
    req.on("error", () => { clearTimeout(t); resolve(null); });
  });
}

function ageMin(iso) {
  if (!iso) return NaN;
  const t = Date.parse(iso);
  if (isNaN(t)) return NaN;
  return (Date.now() - t) / 60000;
}

(async () => {
  const problems = [];
  const info = [];

  // ── ① 真源 GH Pages 新鲜度（最关键）──
  const canon = await getJSON(GH_PAGES_CANON + "/meta.json");
  if (!canon) {
    problems.push("【真源异常】GH Pages 元数据不可达（" + GH_PAGES_CANON + "/meta.json），" +
      "GitHub Actions（refresh.yml）可能未运行或网络故障，手机网页与已发布小程序会读到旧数据");
  } else {
    const age = ageMin(canon.generatedAt);
    console.log("[canon] generatedAt=" + canon.generatedAt +
      " (" + (isNaN(age) ? "?" : Math.round(age)) + " 分钟前) dataMode=" + (canon.dataMode || "?"));
    if (isNaN(age) || age > MAX_AGE_MIN) {
      problems.push("【真源陈旧】GH Pages 数据不新鲜：generatedAt=" + canon.generatedAt +
        "（" + (isNaN(age) ? "?" : Math.round(age)) + " 分钟前，上限 " + MAX_AGE_MIN + " 分钟）。" +
        "通常是 GitHub Actions（refresh.yml）未运行/失败，手机网页与已发布小程序会读到旧数据。");
    }

    // ── ② 平台吐出的数据是否与真源对齐 ──
    const health = await getJSON("https://" + PLATFORM_HOST + "/api/health?sharecode=" + SHARE);
    const gold = await getJSON("https://" + PLATFORM_HOST + "/api/data/gold?sharecode=" + SHARE);
    if (!health) {
      problems.push("平台 /api/health 不可达（" + PLATFORM_HOST + "）");
    } else {
      console.log("[platform] role=" + health.role + " lastGenOk=" + health.lastGenOk +
        " updatedAt.gold=" + ((health.updatedAt || {})["gold.json"] || "-"));
      if (health.role && health.role !== "readonly-proxy") {
        info.push("平台仍运行旧架构（role=" + health.role + "），建议重发 C37 只读代理版");
      }
      // 平台吐出的实际数据时间戳（gold 末值入库时间），而非缓存时间戳
      const platTs = (gold && (gold.lastUpdate || (gold.meta && gold.meta.generatedAt))) ||
        ((health.updatedAt || {})["gold.json"]);
      if (platTs) {
        const drift = ageMin(platTs) - ageMin(canon.generatedAt); // 正 = 平台落后于真源
        console.log("[platform] served lastUpdate=" + platTs + " 落后真源约 " + Math.round(drift) + " 分钟");
        if (drift > DRIFT_WARN_MIN) {
          problems.push("【平台落后真源】平台吐出数据（" + platTs + "）落后 GH Pages 真源（" + canon.generatedAt +
            "）约 " + Math.round(drift) + " 分钟，超出 " + DRIFT_WARN_MIN + " 分钟阈值。" +
            "PC 网页 / 非微信手机网页 / 小程序 dev 云函数会读到陈旧价格。" +
            "处置：重发平台版（随包注入最新 data/，或确保平台能同步 GH Pages 真源）。");
        } else if (drift > 10) {
          info.push("平台数据落后真源约 " + Math.round(drift) + " 分钟（在部署窗口内，属正常）");
        }
      } else {
        problems.push("平台未返回可用数据时间戳（gold.lastUpdate 缺失，/api/data/gold 可能异常）");
      }
    }
  }

  // ── ③ 事件体检（视觉同形重复 + 日期漂移）—— 沿用 C19/C24 逻辑 ──
  const events = await getJSON("https://" + PLATFORM_HOST + "/api/events?sharecode=" + SHARE);
  if (events && events.gold) {
    for (const metal of ["gold", "silver", "copper"]) {
      const arr = events[metal] || [];
      let drift = 0;
      for (const e of arr) {
        const m2 = String(e.url || "").match(/\/(\d{4})\/(\d{2})\/(\d{2})(?:\/|-|_)/);
        if (m2 && (m2[1] + "-" + m2[2] + "-" + m2[3]) !== e.date) drift++;
      }
      if (drift) problems.push("事件日期漂移：" + metal + " 有 " + drift + " 条的日期与 URL 发布日不一致");
      const dup = [];
      for (let i = 0; i < arr.length; i++) {
        for (let k = i + 1; k < arr.length; k++) {
          const a = arr[i], b = arr[k];
          if (Math.abs(new Date(a.date) - new Date(b.date)) / 86400000 > 1) continue;
          const sa = ED.skeletonKey(a.summary, a.tags), sb = ED.skeletonKey(b.summary, b.tags);
          if (sa && sa === sb && sa.length >= 12 && ED.tagsOverlap(a.tags, b.tags)) {
            dup.push("《" + a.title + "》(" + a.date + ") vs 《" + b.title + "》(" + b.date + ")");
          }
        }
      }
      if (dup.length) {
        problems.push("事件列表存在视觉同形重复（" + metal + "，" + dup.length + " 对）：" + dup.slice(0, 3).join("；"));
      }
    }
    console.log("[platform] 事件体检完成（gold " + events.gold.length + " 条）");
  } else {
    console.warn("[platform] 事件数据不可达，跳过事件体检");
  }

  // ── 汇总 ──
  if (problems.length) {
    console.error("[check_platform] 发现 " + problems.length + " 项异常：");
    problems.forEach((p) => console.error("  ✗ " + p));
    try {
      await notify.alert("贵金属监测 · 平台真源巡检异常",
        problems.join("\n") + (info.length ? "\n\n附：\n" + info.join("\n") : ""),
        "platform-health");
    } catch (e) {
      console.warn("[check_platform] 告警发送失败：" + (e && e.message));
    }
    process.exit(1);
  }
  console.log("[check_platform] 全部正常（GH Pages 真源新鲜" +
    (info.length ? "；" + info.join("；") : "") + "）");
})();
