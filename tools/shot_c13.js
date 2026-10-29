// C13 走查：截取网页端金属 tab（下划线风格）+ 粒度/市场 chip（透明描边胶囊），
// 作为小程序改版后的对照参照。本地 dist-ghpages 静态服务。
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..", "dist-ghpages");
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".json": "application/json", ".png": "image/png" };
const PORT = 8913;

const server = http.createServer((req, res) => {
  let rel = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  fs.readFile(path.join(ROOT, rel), (e, d) => {
    if (e) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(rel)] || "application/octet-stream" });
    res.end(d);
  });
});

const OUT = path.resolve(__dirname, "..", "_walk4");

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch({
    executablePath: "C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe",
    args: ["--no-sandbox", "--headless=new"],
  });
  const shots = [
    { w: 1280, h: 900, sel: ".metal-tabs", name: "c13-pc-metaltabs.png", scrollTop: 0 },
    { w: 1280, h: 900, sel: ".controls", name: "c13-pc-chips.png", scrollTop: 240 },
    { w: 390, h: 844, sel: ".metal-tabs", name: "c13-mobile-metaltabs.png", scrollTop: 0 },
    { w: 390, h: 844, sel: ".controls", name: "c13-mobile-chips.png", scrollTop: 380 },
  ];
  for (const s of shots) {
    const page = await browser.newPage({ viewport: { width: s.w, height: s.h } });
    await page.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await page.evaluate((y) => window.scrollTo(0, y), s.scrollTop);
    await page.waitForTimeout(400);
    const el = await page.$(s.sel);
    if (el) { await el.screenshot({ path: path.join(OUT, s.name) }); console.log("OK " + s.name); }
    else console.log("MISS " + s.name + " (" + s.sel + ")");
    await page.close();
  }
  await browser.close();
  server.close();
})();
