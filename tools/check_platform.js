// check_platform.js —— 平台真源生成器健康巡检（C19）
// ------------------------------------------------------------------
// 背景（C19）：data/*.json 的写入权已收归平台版 Node 服务——它 24h 在线、setInterval 每
// 15 分钟本地生成，并**直推 GH Pages 镜像**（微信 UA 被平台网关按 UA 鉴权 403，手机网页
// 与已发布小程序实际读的就是 GH Pages）。
// GitHub Actions 因此不再自行生成/提交数据：原 workflow 用 force-push 重写历史，
// 会让平台的镜像推送变成非快进而被拒（实测：Actions 触发 5 次、数据 0 次更新）。
//
// 现在 Actions 只做「巡检 + 告警」：
//   ① 平台生成器是否成功（lastGenOk / lastError）
//   ② 数据是否新鲜（generatedAt 在 25 分钟内）
//   ③ 镜像是否推送成功（mirror.ok）——它决定手机网页/已发布小程序能不能拿到新数据
// 运行：node tools/check_platform.js
const notify = require("./notify");
const path = require("path");
const ED = require(path.join(__dirname, "..", "js", "event-dedupe.js"));

const PLATFORM_HOST = "metal-price-monitor.app.workbuddy.host";
const SHARE = "POOW32T4LI";
const MAX_AGE_MIN = 25;            // 15 分钟生成周期 + 余量
const TIMEOUT_MS = 15000;

function getJSON(url) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { req.destroy(); } catch (e) { /* ignore */ } resolve(null); }, TIMEOUT_MS);
    const req = require("https").get(url, { headers: { "User-Agent": "metals-check/1.0" } }, (res) => {
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (c) => (body += c));
      res.on("end", () => { clearTimeout(t); try { resolve(JSON.parse(body)); } catch (e) { resolve(null); } });
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
  const health = await getJSON("https://" + PLATFORM_HOST + "/api/health?sharecode=" + SHARE);

  if (!health) {
    problems.push("平台 /api/health 不可达（" + PLATFORM_HOST + "）");
  } else {
    const age = ageMin(health.generatedAt);
    console.log("[platform] role=" + health.role + " generatedAt=" + health.generatedAt +
      " (" + (isNaN(age) ? "?" : Math.round(age)) + " 分钟前)");
    console.log("[platform] lastGenOk=" + health.lastGenOk + " lastError=" + JSON.stringify(health.lastError || ""));
    const m = health.mirror || {};
    console.log("[platform] mirror.ok=" + m.ok + " commit=" + (m.commit || "-") +
      " hasToken=" + m.hasToken + (m.error ? " error=" + m.error : ""));

    if (health.lastGenOk !== true) problems.push("平台生成器自报失败：" + (health.lastError || "未知"));
    if (isNaN(age) || age > MAX_AGE_MIN) {
      problems.push("平台数据不新鲜：generatedAt=" + health.generatedAt +
        "（" + (isNaN(age) ? "?" : Math.round(age)) + " 分钟前，上限 " + MAX_AGE_MIN + " 分钟）");
    }
    if (m.ok === false) {
      problems.push("GH Pages 镜像推送失败（手机网页/已发布小程序会读到旧数据）：" +
        (m.error || "未知") + (m.hasToken ? "" : "（无 GitHub 凭据，需检查 .env / GH_TOKEN）"));
    }
  }

  // ② 事件体检：视觉同形重复（用户反馈「事件列表有重复」）+ 事件日期与 URL 发布日漂移
  const events = await getJSON("https://" + PLATFORM_HOST + "/api/events?sharecode=" + SHARE);
  if (events && events.gold) {
    for (const metal of ["gold", "silver", "copper"]) {
      const arr = events[metal] || [];
      // 2.1 日期漂移：条目日期应与 URL 里的发布路径一致（否则同一条会在不同天之间跳）
      let drift = 0;
      for (const e of arr) {
        const m2 = String(e.url || "").match(/\/(\d{4})\/(\d{2})\/(\d{2})(?:\/|-|_)/);
        if (m2 && (m2[1] + "-" + m2[2] + "-" + m2[3]) !== e.date) drift++;
      }
      if (drift) problems.push("事件日期漂移：" + metal + " 有 " + drift + " 条的日期与 URL 发布日不一致");
      // 2.2 视觉同形重复：摘要同模板 + 标签有交集 + 同日/相邻日
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

  if (problems.length) {
    console.error("[check_platform] 发现 " + problems.length + " 项异常：");
    problems.forEach((p) => console.error("  ✗ " + p));
    try {
      await notify.alert("贵金属监测 · 平台真源巡检异常", problems.join("\n"), "platform-health");
    } catch (e) {
      console.warn("[check_platform] 告警发送失败：" + (e && e.message));
    }
    process.exit(1);
  }
  console.log("[check_platform] 全部正常（生成成功 · 数据新鲜 · 镜像已推送）");
})();
