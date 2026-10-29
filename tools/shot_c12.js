// 截图走查：C12 事件卡片三视口（PC 舒展 / 平板 / 手机居右）
const fs = require("fs");
const path = require("path");
const OUT = path.resolve(__dirname, "..", "_walk4");
const BASE = "http://127.0.0.1:8901";

function findChromium() {
  const c = "C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe";
  return fs.existsSync(c) ? c : undefined;
}

(async () => {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox", "--headless=new"] });
  const shots = [
    { w: 1280, h: 900, sel: ".event-item", name: "c12-pc-card1.png", scrollToEvents: true },
    { w: 1280, h: 900, sel: ".events-head", name: "c12-pc-events.png", scrollToEvents: true },
    { w: 1280, h: 900, sel: ".event-list", name: "c12-pc-cards.png", scrollToEvents: true },
    { w: 390, h: 844, sel: ".event-item", name: "c12-mobile-card1.png", scrollToEvents: true },
    { w: 390, h: 844, sel: ".events-head", name: "c12-mobile-events.png", scrollToEvents: true },
    { w: 390, h: 844, sel: ".event-list", name: "c12-mobile-cards.png", scrollToEvents: true },
  ];
  for (const s of shots) {
    const page = await browser.newPage({ viewport: { width: s.w, height: s.h } });
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5000);
    if (s.scrollToEvents) {
      await page.evaluate(() => {
        const el = document.querySelector(".events-head");
        if (el) el.scrollIntoView({ block: "start" });
      });
      await page.waitForTimeout(400);
    }
    const el = await page.$(s.sel);
    if (!el) { console.log("skip " + s.name + "（元素不存在）"); await page.close(); continue; }
    await el.screenshot({ path: path.join(OUT, s.name) });
    console.log("saved " + s.name);
    await page.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
