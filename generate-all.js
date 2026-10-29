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

(async () => {
  // 1) 价格曲线 + meta（含 dataMode / updatePolicy 等口径）
  await g.generateAll();
  // 2) 重大事件（RSS 抓取 + 聚类归纳 + 去重 → events.json / events.meta.json）
  try {
    await g.buildEvents();
  } catch (e) {
    console.warn("[generate-all] 重大事件刷新失败（保留上一版事件）：" + ((e && e.message) || String(e)));
  }
  console.log("[generate-all] done");
})().catch((e) => {
  console.error("[generate-all] failed:", e);
  process.exit(1);
});
