/**
 * event-corr.js —— 【2026-11-18 H17】事件-价格相关性「真源滚动计算」
 *
 * 背景：此前相关性指数只在两个前端各自本地算（网页 js/app.js / 小程序 utils/corr.js），
 *   真源 events.json 不落盘 → 「收录时事件窗未走完算不出来」，且三端结果可能不一致。
 *   本模块把同一套事件研究法移植到真源生成侧：每 15 分钟对「事件窗已走完」的事件重算 corr
 *   并写入 events.json；未走完的保持 null，下轮自动补上 —— 这就是滚动补算机制。
 *
 * 算法与小程序 utils/corr.js / 网页 js/app.js 完全同源（Fama et al. 1969；MacKinlay 1997）：
 *   估计窗 120 交易日 → μ/σ（均值调整模型）；事件窗 [0,+5] → AR/CAR；t = CAR/(σ√L)；
 *   指数 = 显著性50 + 方向一致性30 + 量级20。
 *
 * 输入 priceData = data/{gold|silver|copper}.json（含 series.{domestic,london,hongkong}），
 *   与前端 corr.js 消费结构一致，故算法逐行对齐，保证三端数值一致。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.EventCorr = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var CORR_EST = 120;
  var CORR_WIN = 5;
  var CORR_T_FULL = 2.58;
  var CORR_MAG_FULL = 3;

  // 基准序列：优先国内（与默认视图一致），要求事件日在覆盖范围内且事件窗至少 2 个交易日。
  function benchSeries(data, evUtc) {
    var series = (data && data.series) || {};
    var fallback = null;
    var order = ["domestic", "london", "hongkong"];
    for (var oi = 0; oi < order.length; oi++) {
      var m = order[oi], arr = series[m] || [];
      if (arr.length < 30) continue;
      var t0 = -1;
      for (var i = 0; i < arr.length; i++) { if (arr[i][0] >= evUtc) { t0 = i; break; } }
      if (t0 < 1) continue;
      if (arr.length < t0 + 2) continue;
      if (t0 >= 60) return { market: m, arr: arr, t0: t0 };
      if (!fallback) fallback = { market: m, arr: arr, t0: t0 };
    }
    return fallback;
  }

  // 单条事件的相关性；数据窗口不足返回 null
  function eventCorrelation(data, ev) {
    var p = String((ev && ev.date) || "").split("-");
    if (p.length !== 3) return null;
    var evUtc = Date.UTC(+p[0], +p[1] - 1, +p[2]);
    var b = benchSeries(data, evUtc);
    if (!b) return null;
    var arr = b.arr, t0 = b.t0;

    var estFrom = Math.max(0, t0 - CORR_EST);
    var estRets = [];
    for (var j = estFrom + 1; j <= t0 - 1; j++) estRets.push(arr[j][1] / arr[j - 1][1] - 1);
    if (estRets.length < 10) {
      estRets = [];
      var allFrom = Math.max(0, t0 - 250);
      for (var k = allFrom + 1; k <= t0 - 1; k++) estRets.push(arr[k][1] / arr[k - 1][1] - 1);
      if (estRets.length < 10) return null;
    }
    var estN = estRets.length, s = 0, i2;
    for (i2 = 0; i2 < estN; i2++) s += estRets[i2];
    var mu = s / estN, v = 0;
    for (i2 = 0; i2 < estN; i2++) v += (estRets[i2] - mu) * (estRets[i2] - mu);
    var sigma = Math.sqrt(v / Math.max(1, estN - 1));

    var winEnd = Math.min(arr.length - 1, t0 + CORR_WIN);
    var L = winEnd - t0 + 1;
    if (L < 2) return null;
    var car = 0;
    for (var w = t0; w <= winEnd; w++) car += (arr[w][1] / arr[w - 1][1] - 1) - mu;
    var tStat = sigma > 1e-9 ? car / (sigma * Math.sqrt(L)) : 0;

    var exp = ev.impact === "up" ? 1 : ev.impact === "down" ? -1 : 0;
    var dirOK = exp === 0 ? null : (car !== 0 && (car > 0 ? 1 : -1) === exp);
    var dirScore = exp === 0 ? 15 : (dirOK ? 30 : 0);
    var sigScore = Math.min(50, Math.abs(tStat) / CORR_T_FULL * 50);
    var magScore = sigma > 1e-9 ? Math.min(20, Math.abs(car) / sigma / CORR_MAG_FULL * 20) : 0;
    var idx = Math.round(sigScore + dirScore + magScore);
    return {
      idx: idx, car: car, t: tStat, L: L, market: b.market,
      complete: winEnd === t0 + CORR_WIN, dirOK: dirOK,
      level: idx >= 70 ? "强" : idx >= 40 ? "中" : "弱",
      cls: idx >= 70 ? "ci-strong" : idx >= 40 ? "ci-mid" : "ci-weak",
    };
  }

  /**
   * 对一组事件（同品种）批量计算并写回 corr 字段（滚动补算核心）。
   * @param {Object} priceData data/{metal}.json
   * @param {Array} events 该品种事件数组（会被就地写入 e.corr）
   * @param {String} computedAt ISO 计算时间
   * @returns {{computed:Number, skipped:Number}} 统计
   */
  function attachCorr(priceData, events, computedAt) {
    var computed = 0, skipped = 0;
    var ts = computedAt || new Date().toISOString();
    for (var i = 0; i < (events || []).length; i++) {
      var ev = events[i];
      var c = eventCorrelation(priceData, ev);
      if (c && c.complete) {
        // 事件窗完整走完 → 落盘；附带计算时间便于追踪滚动补算
        ev.corr = {
          idx: c.idx, car: c.car, t: c.t, L: c.L, market: c.market,
          complete: true, dirOK: c.dirOK, level: c.level, cls: c.cls,
          computedAt: ts,
        };
        computed++;
      } else {
        // 事件窗未走完 / 数据不足 → 保持 null，下轮自动补算（滚动机制）
        ev.corr = null;
        skipped++;
      }
    }
    return { computed: computed, skipped: skipped };
  }

  return {
    CORR_EST: CORR_EST, CORR_WIN: CORR_WIN,
    benchSeries: benchSeries, eventCorrelation: eventCorrelation, attachCorr: attachCorr,
  };
});
