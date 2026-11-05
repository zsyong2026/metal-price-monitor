// generate-all.js —— 价格 + 重大事件 全量生成（C18 平台生成器入口）
// ------------------------------------------------------------------
// 背景：generate.js 把「价格生成」（generateAll）与「事件生成」（buildEvents）拆成了两个入口。
//   GitHub Actions 原 workflow 是两步（node generate.js + node -e "buildEvents()"），
//   但 C18 的平台版生成器若只跑第一步，就会出现：
//   价格 meta.generatedAt 每 15 分钟前进，而 events.meta.updatedAt 永远停在旧值
//   → 用户看到「价格更新到 10:01，重大事件更新时间还是 09:14」的三端不一致。
// 故这里把两步合并成一个入口，平台定时任务只认这一个，保证价格与事件同批次入库。
//
// 行为约定：
//   · 事件抓取（RSS）失败不阻断价格入库：保留上一版事件并打印告警，价格照常更新。
//   · 进程退出码 0 = 本轮生成成功（平台 server.js 依据它刷新内存缓存）。
const g = require("./generate");
const fs = require("fs");
const path = require("path");

// 【性能·三端提速】生成 data/bundle.json（合并 gold/silver/copper/meta/events/events.meta 六文件为一），
// 让网页/小程序首屏从「6 次请求（且网页端每条还 waterfall 试错 4 个地址）」降到「1 次请求」。
// 这是增量优化：bundle 仅是单文件逻辑的一级加速源，任一端读取失败会自动回退到单文件，不影响数据管线。
// 必须在 generateAll + buildEvents 都落盘后再写，且整体 fail-safe：即使读不到某文件也只告警、绝不抛错中断生成。
const DATA_DIR = path.join(__dirname, "data");
const BUNDLE_FILES = ["gold.json", "silver.json", "copper.json", "meta.json", "events.json", "events.meta.json"];
function writeBundle() {
  const parts = {};
  for (const f of BUNDLE_FILES) {
    const p = path.join(DATA_DIR, f);
    if (!fs.existsSync(p)) throw new Error("缺少 " + f);
    parts[f] = JSON.parse(fs.readFileSync(p, "utf-8"));
  }
  const bundle = {
    meta: parts["meta.json"],
    eventsMeta: parts["events.meta.json"],
    events: parts["events.json"],
    metals: {
      gold: parts["gold.json"],
      silver: parts["silver.json"],
      copper: parts["copper.json"],
    },
  };
  fs.writeFileSync(path.join(DATA_DIR, "bundle.json"), JSON.stringify(bundle));
  console.log("[generate-all] bundle.json 已生成（" + BUNDLE_FILES.length + " 文件合并，约 " +
    Math.round(Buffer.byteLength(JSON.stringify(bundle)) / 1024) + " KB）");
}

(async () => {
  // 1) 价格曲线 + meta（含 dataMode / updatePolicy 等口径）
  await g.generateAll();
  // 2) 重大事件（RSS 抓取 + 聚类归纳 + 去重 → events.json / events.meta.json）
  try {
    await g.buildEvents();
  } catch (e) {
    console.warn("[generate-all] 重大事件刷新失败（保留上一版事件）：" + ((e && e.message) || String(e)));
  }
  // 3) 合并 bundle（fail-safe：失败仅告警，绝不中断生成/提交）
  try {
    writeBundle();
  } catch (e) {
    console.warn("[generate-all] bundle.json 生成失败（不影响数据管线，端上自动回退单文件）：" + ((e && e.message) || String(e)));
  }
  console.log("[generate-all] done");
})().catch((e) => {
  console.error("[generate-all] failed:", e);
  process.exit(1);
});
