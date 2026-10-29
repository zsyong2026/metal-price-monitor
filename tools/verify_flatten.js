// verify_flatten.js —— 压平验证：PC 平台版显示的更新时间是否 = GitHub Pages 真源时间
// 运行：cd metals-monitor && node tools/verify_flatten.js
const { chromium } = require("playwright");

const PC = "https://metal-price-monitor.app.workbuddy.host/?sharecode=POOW32T4LI";
const GH = "https://zsyong2026.github.io/metal-price-monitor/";

(async () => {
  // 1) 真源基准时间（穿透 CDN）
  const get = async (u) => (await fetch(u + "?_ts=" + Date.now())).json();
  const meta = await get(GH + "data/meta.json");
  const evMeta = await get(GH + "data/events.meta.json");
  console.log("真源 GitHub Pages：");
  console.log("  价格 meta.generatedAt =", meta.generatedAt);
  console.log("  事件 eventsMeta.updatedAt =", evMeta.updatedAt);

  // 2) 平台版平台自身生成的时间（前端已绕过，仅作对照）
  let apiTime = "—";
  try {
    const m = await (await fetch("https://metal-price-monitor.app.workbuddy.host/api/meta?sharecode=POOW32T4LI")).json();
    apiTime = m.generatedAt;
  } catch (e) { apiTime = "（/api/meta 不可达）"; }
  console.log("平台版自身 /api/meta（对照，前端已绕过）=", apiTime);

  // 3) 浏览器实测平台版页面显示
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(PC, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(6000);
  const shown = await page.evaluate(() => ({
    lastUpdate: (document.getElementById("lastUpdate") || {}).textContent || "",
    priceUpdate: (document.getElementById("priceUpdate") || {}).textContent || "",
    eventsUpdate: (document.getElementById("eventsUpdate") || {}).textContent || "",
    tip: (document.getElementById("lastUpdate") || {}).title || "",
  }));
  console.log("\nPC 平台版页面实际显示：");
  console.log("  右上角 lastUpdate =", shown.lastUpdate);
  console.log("  ", shown.priceUpdate);
  console.log("  ", shown.eventsUpdate);
  console.log("  tooltip  =", (shown.tip || "").replace(/\n/g, " ｜ "));

  await page.screenshot({ path: "_walk4/c16-pc-flatten.png" });
  console.log("\n截图已存 _walk4/c16-pc-flatten.png");
  await browser.close();
})();
