/* 贵金属报价趋势监测 — 前端逻辑 */
(function () {
  "use strict";

  var MARKET_CN = { london: "伦敦", domestic: "国内", hongkong: "香港" };
  var MARKET_COLOR = { london: "#d4a017", domestic: "#b5651d", hongkong: "#3a7bd5" };
  var MARKET_ORDER = ["london", "domestic", "hongkong"];
  var OZ2G = 31.1034768; // 1 金衡盎司 = 31.1034768 克

  var state = {
    metal: "gold",
    // 默认：仅看「国内」；金/银默认「元/克」
    markets: { london: false, domestic: true, hongkong: false },
    gran: "day",           // 默认粒度：天
    gram: true,           // 是否按「元/克」折算（仅金/银），默认开启
    data: null,           // 当前金属 json
    events: null,         // 全部事件
    meta: null,
    eventsMeta: null,     // 事件独立元信息（updatedAt/latestEventDate/sources），与价格 meta 分开
    eventCat: "all",
    eventPage: 1,
  };
  var PAGE_SIZE = 10; // 三端统一：每页 10 条（移动端一屏约 1.5 屏、下滑成本低；原 8 条页码过多、20 条单页过长折中）
  var chart = null;
  var cache = {};

  /* ---------- 最新价 1 分钟实时层（三端同口径）----------
     真源（GH Pages / bundle）每 15 分钟生成一版，承载历史曲线、事件与校验；
     「最新价」单独旁路直连 gold-api.com 实时现货，每 60 秒拉一次，只局部刷新指标看板。
     覆盖：金/银/铜 × 伦敦/国内/香港 × 原始单位/元克。
       伦敦 = 真实现货（铜由 美元/磅 折 美元/吨）；
       香港 = 伦敦 × 美元兑港币（沿用真源 hkdcny 反推，三端一致）；
       国内 = 保持真源最近一次「内外盘真实比价」（含升水/汇率），随国际现货按比例联动，
              属【联动价】而非独立实时成交价，UI 明确标注，不冒充真实内盘报价。
     任一轮抓取失败：静默保留上一轮报价与时间戳，顶部时间不回退、不闪烁（C18 教训）。 */
  var SPOT_API = "https://api.gold-api.com/price/";
  var SPOT_SYMBOL = { gold: "XAU", silver: "XAG", copper: "HG" };
  var SPOT_METALS = ["gold", "silver", "copper"];
  var LB_PER_TON = 2204.62262;        // COMEX HG 报价为 美元/磅，1 吨 = 2204.62262 磅
  var SPOT_REFRESH_MS = 60 * 1000;    // 最新价：1 分钟
  var SPOT_MIN_GAP_MS = 20 * 1000;    // 页面回前台时允许立即重抓的最小间隔
  var spotState = { quotes: {}, lastOkAt: 0, fetching: false };
  /* ---------- 【2026-11-07 修复·频率文案闪烁】与小程序 pages/index/index.js 同一口径 ----------
     旧逻辑是二态：有现货 →「实时每分」，没现货 →「真源每15分」。冷启动首帧现货必然还没回来，
     于是先显示「真源每15分」，1~2 秒后现货到位又跳成「实时每分」（用户反馈「会跳一下」）。
     改为四态状态机：
       · settled    = 本会话现货链路是否已定论（成功 / 明确不可用）
       · wasOk      = 本会话结论；lastOk = 上次会话结论（localStorage 持久化）
       · failStreak = 连续失败轮次，单轮抖动不立刻改口（连续 2 轮才降级）
     未定论时沿用上次结论，或显示中性的「校验最新价…」，绝不先落误导性的「真源每15分」。 */
  var spotCadence = { settled: false, wasOk: null, lastOk: false, failStreak: 0 };
  try { spotCadence.lastOk = localStorage.getItem("mm.spot.ok") === "1"; } catch (e) { /* 隐私模式 */ }
  function spotSucceed() {
    spotCadence.settled = true;
    spotCadence.wasOk = true;
    spotCadence.failStreak = 0;
    try { localStorage.setItem("mm.spot.ok", "1"); } catch (e) { /* 忽略 */ }
  }
  function spotFailed() {
    spotCadence.failStreak++;
    // 云函数/网络冷启动单轮抖动不改口；连续 2 轮才如实降级
    if (spotCadence.failStreak >= 2 && spotCadence.wasOk !== false) {
      spotCadence.settled = true;
      spotCadence.wasOk = false;
      try { localStorage.setItem("mm.spot.ok", "0"); } catch (e) { /* 忽略 */ }
      if (state.data) renderUpdateTimes();
    }
  }

  /* ---------- 工具 ---------- */
  function fmtNum(v) {
    if (v == null || isNaN(v)) return "—";
    return Number(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPct(p) {
    if (p == null || isNaN(p)) return "—";
    var s = p >= 0 ? "+" : "";
    return s + p.toFixed(2) + "%";
  }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  // 【C29】与小程序端统一：摘要 =「事件概况。对(贵金属|铜价)影响：结论」两段式，
  //   拆成「概况」与「影响：结论」分别渲染，去掉 web 端原本冗余的「对X影响：」前缀。
  function splitSummary(raw) {
    var s = String(raw || "").replace(/^【[^】]{1,12}】\s*/, "");
    var p = s.split(/。对(贵金属|铜价)影响：/);
    var ev = (p[0] || "").trim();
    var imp = p[1] ? ("影响：" + p[1].trim()) : "";
    return { event: ev, impact: imp };
  }
  // 【C32】确定性文本 → 配色档位（视觉规格 §6.3：金 / 琥珀 / 灰，不用红绿，避免与方向撞色）
  //   顺序敏感：「偏强 · 待验证」先命中 high 档，「待确认」兜底只在无方向时落到 low。
  function degreeCls(deg) {
    var s = String(deg || "");
    if (/确定性高|偏强/.test(s)) return "high";
    if (/中等|偏弱/.test(s)) return "mid";
    return "low";
  }
  // 【C32】相关性：头部胶囊降权为影响段末端一行弱字（信息不丢，只是不再抢眼）
  function corrWeak(ev) {
    var c = corrFor(ev);
    return c ? "相关性 " + c.idx + (c.level ? "·" + c.level : "") : "相关性 —";
  }
  // 属性值转义：esc() 只处理 &<>，属性值里还要挡住单双引号截断属性
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
  function round2(v) { return Math.round(v * 100) / 100; }
  function fmtDate(ms, gran) {
    var d = new Date(ms);
    if (gran === "hour") return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":00";
    if (gran === "day") return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    if (gran === "month") return d.getFullYear() + "-" + pad(d.getMonth() + 1);
    return d.getFullYear() + "年";
  }
  function fmtAxis(ms) {
    var d = new Date(ms);
    if (state.gran === "hour") return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + "h";
    // 【2026-11-06 修复·横轴跨年】可见窗口跨年时日标签补年份，消除 "12/01、02/01" 重复无法区分
    if (state.gran === "day") return (lsDayWithYear ? d.getFullYear() + "/" : "") + pad(d.getMonth() + 1) + "/" + pad(d.getDate());
    if (state.gran === "month") return d.getFullYear() + "-" + pad(d.getMonth() + 1);
    return "" + d.getFullYear();
  }
  // 把 UTC 时间戳（ISO）格式化为浏览器本地时区，避免直接展示 UTC 造成「时间不对」
  function fmtLocal(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  // 【准确数字秒】用户要求更新时间别只到分钟：手机状态栏是秒级的，页面精确到秒才能直接核对。
  function fmtLocalSec(iso) {
    var s = fmtLocal(iso);
    if (s === "—" || s === iso) return s;
    var d = new Date(iso);
    return isNaN(d.getTime()) ? s : s + ":" + pad(d.getSeconds());
  }
  // 微信/分享链接携带的 sharecode：网关用它对请求做鉴权；把它拼到所有 /api 请求上，
  // 这样即便浏览器/微信 WebView 没有持久化网关的 __wb_rsc Cookie，也能通过分享码拿到数据。
  function shareQ() {
    var s = location.search || "";
    return s.indexOf("sharecode=") >= 0 ? s : "";
  }
  // 【C43/C45 真源定调（勿按旧注释回退）】
  //   真源唯一写入者 = GitHub Actions refresh.yml：抓真实行情 → 校验 → 写 data/*.json → 提交 main；
  //   平台版 = 纯只读代理 + workflow_dispatch 调度器，不本地生成、不反推真源。三端读同一真源：
  //   · PC 网页           → 同源 /api/（API_BASE 为空）
  //   · 手机网页(GH Pages) → GH Pages data/ 优先，平台 /api/ 跨域兜底
  //   · 微信小程序        → GH Pages 直连为主，云函数 → 平台 /api/bundle 为备
  // 【2026-11-05】老域名 + 旧 sharecode 已 404「链接已失效」，与 check_platform.js 告警误报是同一个坑。
  var PLATFORM_HOST = "https://metal-price-mp.app.workbuddy.host";
  var SHARE = "YAC2PRXREO";                // 平台网关鉴权用 sharecode（与云函数同款，可嵌入前端）
  var STATIC = !!window.__STATIC__;          // 手机网页静态壳 = 1；PC 平台版 = undefined
  // 平台 API 基址：PC 同源（相对）｜手机跨域（绝对 + sharecode）
  function apiUrl(p) {
    if (!STATIC) return p;                   // PC：同源相对路径即可
    return PLATFORM_HOST + p + (p.indexOf("?") >= 0 ? "&" : "?") + "sharecode=" + SHARE;
  }
  // 【2026-11-06 首屏提速·缓存穿透改为「15 分钟版本槽」】
  //   旧写法 _ts=Date.now() 让每个用户、每次刷新都是不同 URL → GH Pages / jsDelivr 边缘
  //   缓存必然 MISS 回源；实测 556KB 的 bundle 因此要 17~31s，而 2.6KB 的 meta 只要 0.5~1.2s。
  //   真源本来就每 15 分钟发布一版：用 _v=floor(now/15min) 作版本号，同一槽里三端/所有用户
  //   共用同一 URL → CDN 命中；跨槽自动换 URL 拿新一版，新鲜度与 15 分钟节奏天然对齐。
  var SLOT_MS = 15 * 60 * 1000;
  function slot() { return Math.floor(Date.now() / SLOT_MS); }
  var CANON = "https://zsyong2026.github.io/metal-price-monitor/"; // 兜底：GitHub Pages 真源壳
  function canon(u) { return u + (u.indexOf("?") >= 0 ? "&" : "?") + "_v=" + slot(); }
  // 【C48·韧性拉齐】jsDelivr 兜底：CORS:*，跨域直连。PC 网页经平台跨域访问时 GitHub Pages 会被 CORS 拦截，
  //   平台不可达时 jsDelivr 仍能给 PC/手机网页供数，与小程序的韧性对齐（小程序直连 GH Pages 主源）。
  var JSD = "https://cdn.jsdelivr.net/gh/zsyong2026/metal-price-monitor@main/";
  function jsd(u) { return u + (u.indexOf("?") >= 0 ? "&" : "?") + "_v=" + slot(); }
  function fxOf(d) {
    return (d && d.fx && d.fx.usdcny) ? d.fx : { usdcny: 7.1, hkdcny: 0.91 };
  }
  function useGram() {
    return (state.metal === "gold" || state.metal === "silver") && !!state.gram;
  }
  // 将某市场的价格序列按当前单位模式换算（元/克 视图）
  function convertPts(pts, market, fx) {
    if (!useGram()) return pts;
    if (market === "london") {
      return pts.map(function (p) { return [p[0], round2(p[1] / OZ2G * fx.usdcny)]; });
    }
    if (market === "hongkong") {
      return pts.map(function (p) { return [p[0], round2(p[1] / OZ2G * fx.hkdcny)]; });
    }
    return pts; // domestic 本来就是 元/克
  }

  /* ---------- 实时现货换算（与 convertPts 完全同一套口径）---------- */
  // 把「原始单位」的实时价折算到当前单位视图；铜不开放元/克，金银仅在 state.gram 时折算
  function convertSpotValue(v, market, metal, gram, fx) {
    if (!(metal === "gold" || metal === "silver") || !gram) return v;
    if (market === "london") return round2(v / OZ2G * fx.usdcny);
    if (market === "hongkong") return round2(v / OZ2G * fx.hkdcny);
    return v; // domestic 本来就是 元/克
  }
  // 真源末端值：作为「内外盘真实比价」的锚（同一版数据，三端一致）
  function anchorOf(d, market) {
    var arr = d && d.series && d.series[market];
    if (!arr || !arr.length) return null;
    var v = arr[arr.length - 1][1];
    return isFinite(v) && v > 0 ? v : null;
  }
  // 某金属在当前真源锚点下的三市场实时价（原始单位）；无报价返回 null
  function livePricesFor(metal, d) {
    var q = spotState.quotes[metal];
    if (!q || !isFinite(q.price) || q.price <= 0) return null;
    var fx = fxOf(d);
    var usdhkd = fx.hkdcny > 0 ? fx.usdcny / fx.hkdcny : 7.8;
    var lNow = metal === "copper" ? q.price * LB_PER_TON : q.price;
    var lRef = anchorOf(d, "london"), dRef = anchorOf(d, "domestic");
    // 国内 = 真源最近一次真实比价 × 国际现货涨幅（保住升水，不硬编码系数）
    var dNow = (lRef && dRef) ? dRef * (lNow / lRef) : null;
    if (!isFinite(dNow) || dNow <= 0) dNow = null;
    return {
      london: round2(lNow),
      domestic: dNow == null ? null : round2(dNow),
      hongkong: round2(lNow * usdhkd),
      ts: q.ts || "",
      linked: !!(lRef && dRef),
    };
  }

  /* ---------- 数据加载 ---------- */
  function loadJSON(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("加载失败: " + url);
      return r.json();
    });
  }
  // 依次尝试多个地址，命中可用即返回（平台 /api 优先，GH Pages / 本地静态兜底）
  // C18：手机网页静态壳也优先读平台 /api/（apiUrl 已转绝对地址 + sharecode，CORS * 跨域可达），
  // GitHub Pages 作兜底；GH Pages 边缘缓存约 10 分钟，对兜底 data/ 请求加版本槽穿透。
  // 平台 /api/ 自身 Cache-Control: no-store，无需版本槽。
  function bust(u) {
    if (u.indexOf("/api/") >= 0) return u;   // 平台 /api/ 已 no-store，不重复穿透
    if (!STATIC) return u;
    if (u.indexOf("_ts=") >= 0 || u.indexOf("_v=") >= 0) return u;  // 已是真源穿透 URL
    return u + (u.indexOf("?") >= 0 ? "&" : "?") + "_v=" + slot();
  }

  /* ---------- 【2026-11-06 首屏提速】串行 waterfall → 并行竞速（hedged request） ----------
     实测基线：PC 平台版首屏 3.688s、手机网页 GH Pages 19.268s。根因是 for-await 依次试 4 个
     地址：排在第一个的跨域 GH Pages（556KB bundle 实测 17~31s）会把后面所有快源全部拖死，
     数据请求又等 ECharts 同步脚本下载完（11.5s）才在 DOMContentLoaded 后发出，两者相乘。

     loadRace：首选源 0ms 起跑，其余每 220ms 起跑一个；任一返回有效 JSON 立即 resolve 并
     abort 其余请求；全部失败才 reject。正常情况只多付出 220ms，最坏耗时从 sum(全部候选)
     压到 min(最快候选) + 220ms。候选仍全部指向同一真源（GH Pages / 平台只读代理 / jsDelivr），
     不改变「三端同源」口径，平台依旧不写数据。 */
  var HEDGE_GAP_MS = 220;
  var FETCH_TIMEOUT_MS = 14000;
  // PC 平台版的静态根 data/ 只是部署包里的旧快照（真源由 /api 走 Contents API 提供）。
  // 并行竞速时它几乎必然最快返回，会把新版真源挤掉 → 数据倒退。故非静态壳下把它拆到
  // 「二阶段兜底」：只有所有真源候选都失败才允许用本地旧快照，静态壳则仍把同源 data/ 当主源。
  function loadRace(sources, validate) {
    var main = [], local = [];
    sources.forEach(function (s) {
      if (!STATIC && typeof s === "string" && s.indexOf("data/") === 0) local.push(s);
      else main.push(s);
    });
    if (!main.length) { main = local; local = []; }
    return raceOnce(main, validate).catch(function (e) {
      if (!local.length) throw e;
      return raceOnce(local, validate);
    });
  }
  function raceOnce(sources, validate) {
    return new Promise(function (resolve, reject) {
      var n = sources.length;
      if (!n) { reject(new Error("无可用数据源")); return; }
      var done = false, remaining = n, ctrls = [], lastErr = null;
      var timer = setTimeout(function () {
        if (!done) { done = true; clearAll(); reject(lastErr || new Error("数据源全部超时")); }
      }, FETCH_TIMEOUT_MS + HEDGE_GAP_MS * n);
      function clearAll() {
        clearTimeout(timer);
        ctrls.forEach(function (c) { try { c.abort(); } catch (e) {} });
      }
      function win(j) { if (done) return; done = true; clearAll(); resolve(j); }
      function settle(e) {
        if (e) lastErr = e;
        remaining--;
        if (remaining <= 0 && !done) { done = true; clearAll(); reject(lastErr || new Error("加载失败")); }
      }
      sources.forEach(function (src, i) {
        var launch = function () {
          if (done) { settle(); return; }
          var ac = (typeof AbortController !== "undefined") ? new AbortController() : null;
          if (ac) ctrls.push(ac);
          var p;
          try {
            if (typeof src === "string") {
              var u = src.indexOf("/api/") === 0 ? apiUrl(src) : src;
              p = fetch(bust(u), { cache: "no-store", signal: ac ? ac.signal : undefined })
                .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
            } else {
              // head 里的早期预取 Promise：直接复用，不重复发同一 URL
              p = (typeof src === "function") ? src() : src;
            }
          } catch (e) { p = Promise.reject(e); }
          Promise.resolve(p).then(function (j) {
            if (validate && !validate(j)) throw new Error("数据校验未通过");
            win(j);
          }).catch(settle);
        };
        if (i === 0) launch(); else setTimeout(launch, i * HEDGE_GAP_MS);
      });
    });
  }
  function loadFirst(urls) { return loadRace(urls, null); }

  function ensureMetal(metal) {
    if (cache[metal]) return Promise.resolve(cache[metal]);
    // 【C32·三端统一】改为 GH Pages 镜像优先（与手机网页/小程序同源同字节）→ 平台 /api 兜底 → 本地静态。
    // 三端读同一份镜像，更新时间恒一致；镜像偶发滞后也是三端同步滞后，不再互相错位。
    // 静态版：__STATIC__ 时 loadFirst 会自动剔除 /api/，只剩 canon + 本地静态
    return loadFirst([canon(CANON + "data/" + metal + ".json"), "/api/data/" + metal + shareQ(), jsd(JSD + "data/" + metal + ".json"), "data/" + metal + ".json"]).then(function (d) {
      cache[metal] = d;
      return d;
    });
  }

  // 【性能·三端提速】bundle 加速源：1 次请求拿齐 6 文件。
  // 【2026-11-06 修正】平台 /api/bundle 返回 { files: {...} }，GH Pages bundle.json 返回
  //   { meta, metals, events, eventsMeta }；旧 tryBundle 只认后者，把最快的同源 /api/bundle
  //   判成「bundle 不可用」白丢一次请求。此处统一 normalize，两条结构都能用。
  function normalizeBundle(b) {
    if (!b) return null;
    if (!b.files) return b;
    var f = b.files;
    return {
      meta: f["meta.json"],
      eventsMeta: f["events.meta.json"] || null,
      events: f["events.json"],
      metals: { gold: f["gold.json"], silver: f["silver.json"], copper: f["copper.json"] },
    };
  }
  function bundleValid(b) {
    var x = normalizeBundle(b);
    return !!(x && x.meta && x.meta.generatedAt && x.metals &&
      x.metals.gold && x.metals.silver && x.metals.copper);
  }
  // 持久缓存的准入比整包宽松：meta + 至少一个金属即可秒开首屏。
  // 首屏最小集本来就只拉当前金属，若强求三金属齐全，缓存会永远写不进去
  // （本地真浏览器实测：三金属由后台补齐前 writeBootCache 一直不触发）。
  // 缺的品种在切换时由 switchMetal → ensureMetal 按需补，不影响正确性。
  function cacheValid(b) {
    var x = normalizeBundle(b);
    return !!(x && x.meta && x.meta.generatedAt && x.metals &&
      (x.metals.gold || x.metals.silver || x.metals.copper));
  }
  // 端上持久缓存：二次进入 / 杀进程重进直接 0 网络秒开，后台再静默校验真源版本。
  // 完整包约 550KB，localStorage 5MB 足够；写入失败（隐私模式/配额）静默忽略，不影响主链路。
  var BOOT_KEY = "mm.boot.v3";
  function readBootCache() {
    try {
      var s = localStorage.getItem(BOOT_KEY);
      var b = s ? JSON.parse(s) : null;
      if (!cacheValid(b)) return null;
      lastWrittenStamp = b.meta.generatedAt || "";
      return normalizeBundle(b);
    } catch (e) { return null; }
  }
  var lastWrittenStamp = "";
  function writeBootCache(b) {
    try {
      if (!cacheValid(b)) return;
      var st = b.meta.generatedAt;
      if (st && st === lastWrittenStamp) return;   // 同版本不重复写 550KB
      lastWrittenStamp = st;
      localStorage.setItem(BOOT_KEY, JSON.stringify(b));
    } catch (e) {}
  }
  var bootData = null;
  function mergeBoot(b) {
    if (!bootData) bootData = { meta: null, events: null, eventsMeta: null, metals: {} };
    if (b.meta) bootData.meta = b.meta;
    if (b.events) bootData.events = b.events;
    if (b.eventsMeta) bootData.eventsMeta = b.eventsMeta;
    if (b.metals) {
      ["gold", "silver", "copper"].forEach(function (m) {
        if (b.metals[m]) { bootData.metals[m] = b.metals[m]; cache[m] = b.metals[m]; }
      });
    }
    if (cacheValid(bootData)) writeBootCache(bootData);
  }

  function tryBundle() {
    // 【性能】静态壳：同源 data/ 打头（CDN 就近）；PC 平台版：同源 /api/bundle 打头（实测最快）。
    // 候选仍是同一真源的三个只读出口，口径不漂移；loadRace 并行竞速，慢源不再拖死快源。
    var local = "data/bundle.json";
    var api = "/api/bundle" + shareQ();
    var urls = STATIC
      ? [local, canon(CANON + "data/bundle.json"), jsd(JSD + "data/bundle.json"), api]
      : [api, local, canon(CANON + "data/bundle.json"), jsd(JSD + "data/bundle.json")];
    return loadRace(urls, bundleValid).then(normalizeBundle);
  }

  // 单文件候选源：首屏只拉「当前金属 + meta + events + eventsMeta」4 个小文件并行，
  // 而不是等 556KB 的整包（实测整包 17~31s，4 文件并行约 1.5~4.8s）。
  var API_OF = {
    "meta.json": "/api/meta", "events.json": "/api/events",
    "events.meta.json": "/api/events-meta", "gold.json": "/api/data/gold",
    "silver.json": "/api/data/silver", "copper.json": "/api/data/copper",
  };
  function fileSources(file) {
    var rel = "data/" + file;
    var urls = STATIC
      ? [rel, canon(CANON + rel), jsd(JSD + rel), API_OF[file] + shareQ()]
      : [API_OF[file] + shareQ(), rel, canon(CANON + rel), jsd(JSD + rel)];
    var early = window.__MM_EARLY__ && window.__MM_EARLY__[file];
    // 有 head 早期预取时复用它，并去掉与之重复的同源首源（避免同一 URL 发两遍）
    if (early) return [early].concat(urls.slice(1));
    return urls;
  }
  function loadMinimal(metal) {
    var files = ["meta.json", "events.json", "events.meta.json", metal + ".json"];
    return Promise.all(files.map(function (f) {
      return loadRace(fileSources(f), null).catch(function () { return null; });
    })).then(function (r) {
      if (!r[0] || !r[0].generatedAt || !r[3] || !r[3].series) throw new Error("首屏最小集不完整");
      var metals = {}; metals[metal] = r[3];
      return { meta: r[0], events: r[1], eventsMeta: r[2], metals: metals };
    });
  }
  // 首屏渲染后后台补齐另外两个金属，切换品种时零等待
  function prefetchMetals() {
    ["gold", "silver", "copper"].forEach(function (m) {
      if (cache[m]) return;
      loadRace(fileSources(m + ".json"), null).then(function (d) {
        if (!d || !d.series) return;
        var one = {}; one[m] = d;
        mergeBoot({ metals: one });
      }).catch(function () {});
    });
  }

  // 把已就绪的金属数据落到 state 并渲染（switchMetal / bundle 命中后复用，避免重复请求）
  function applyMetalData(d) {
    state.data = d;
    corrCache = {}; // 数据源更换，相关性缓存作废
    renderUpdateTimes();
    state.eventPage = 1;
    syncGranAvailability(); // 铜无小时线时禁用「时」选项
    computeAndRenderStats(); // 四卡先算：图表渲染异常不得影响数字
    safeRenderChart();
    renderEvents();
    // 最新价由 startAutoRefresh 的 1 分钟链路统一维护；切金属时 computeAndRenderStats
    // 会用已有现货立即重算，此处不重复抓取（C18 顶部时间闪烁教训）
  }

  // 顶部徽标 + 底部免责/更新策略文案（bundle 命中与原分散请求两条路径共用）
  function setupMetaUI() {
    // 【1 分钟实时价·改】不再直接展示真源里的 updatePolicy 文案（那套仍写「每 15 分钟抓一次现货」，
    //   与最新价 1 分钟直连的新口径矛盾）。前端统一改写为三层频率 + 市场口径，三端同文案。
    document.getElementById("disclaimer").innerHTML =
      "数据说明：伦敦 / 香港为 <strong>gold-api.com 实时现货</strong>（每 60 秒刷新；" +
      "铜由美元/磅折算为美元/吨，香港按真实汇率折算）；国内为按最近一次真实内外盘比价" +
      "随国际现货联动的<strong>联动价</strong>，非独立实时成交价。历史曲线为新浪国际期货 / " +
      "东方财富真实日K，重大事件由公开财经资讯归纳，二者每 15 分钟由真源发布一次。" +
      " <br><span style='color:var(--ink-soft)'>更新频率：最新价 60 秒 ｜ 曲线与校验 15 分钟 ｜ 事件约 1 小时；任一校验不通过保留上一版数据。</span>";
    var b = document.getElementById("dataModeBadge");
    var liveTitle = "最新价：直连实时现货，每 60 秒刷新（页面时间精确到秒）；国内为按真实内外盘比价联动的联动价；历史曲线 / 事件每 15 分钟由真源发布";
    // 【首屏提速】用本机缓存秒开时如实标「缓存数据」，后台拿到真源后由 boot() 清除标志并覆写
    if (state.fromCache) {
      b.textContent = "缓存数据"; b.className = "badge badge-warn";
      b.title = "正在用本机上次成功的数据秒开，后台校验真源新版本中…（" + liveTitle + "）";
    } else if (state.meta.dataMode === "real") {
      b.textContent = "真实数据"; b.className = "badge badge-ok"; b.title = liveTitle;
    } else if (state.meta.dataMode === "spot") {
      b.textContent = "真实现货"; b.className = "badge badge-ok"; b.title = liveTitle;
    } else {
      // 非 real/spot（静态托管或建模兜底）：与小程序第三态口径统一，不显示「建模数据」这种
      // 自我否定的措辞（C08 反馈），改称「缓存数据」并保留说明 tooltip
      b.textContent = "缓存数据";
      b.title = "展示最近一次成功生成的数据快照（实时行情获取失败时自动进入该模式）；" + liveTitle;
    }
  }

  /* ---------- 首屏启动（2026-11-06 重构） ----------
     三条独立加速，互不阻塞：
       ① 本机缓存：0 网络立即出图（徽标如实标「缓存数据」），后台静默换新版；
       ② head 早期预取：数据请求在 HTML 解析到 <head> 时发出，与 1MB ECharts 下载并行；
       ③ 两路并行取数：整包 bundle 与 4 个小文件最小集竞速，谁先有效谁渲染。
     boot() 幂等：initChart / bindEvents / startAutoRefresh 只执行一次，后续只更新数据。 */
  var booted = false;
  var chartBooted = false;
  // ---------- ECharts 多源动态加载（【2026-11-08】）----------
  // 1MB 的 ECharts 若从 github.io 本域加载，国内常限速/阻断（实测 25s 仅下 452KB）→ 图表长期空白。
  // 改为多源竞速：jsDelivr(主) → cdnjs(备) → 本地 vendor(兜)，首个定义 window.echarts 者生效；
  // 全失败才给「加载失败·重试」UI（绝不静默空白）。
  var ECHARTS_SRCS = [
    "https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/echarts/5.5.0/echarts.min.js",
    "js/vendor/echarts.min.js"
  ];
  var echartsLoadStarted = false, echartsFailed = false, pendingEchartsCb = null;
  function bootChartNow() {
    if (chartBooted) return;
    chartBooted = true;
    initChart();
    if (state.data) safeRenderChart(true);
  }
  function fireEchartsReady() {
    if (pendingEchartsCb) { var c = pendingEchartsCb; pendingEchartsCb = null; c(); }
  }
  function onEchartsFail() {
    if (echartsFailed) return;
    echartsFailed = true;
    var el = document.getElementById("chartLoading");
    if (!el) return;
    el.style.display = "flex";
    el.innerHTML = "<div class='cl-fail'><div>图表组件加载失败（网络受限）</div><button type='button' id='clRetry' class='cl-btn'>点击重试</button></div>";
    var btn = document.getElementById("clRetry");
    if (btn) btn.onclick = function () {
      echartsLoadStarted = false; echartsFailed = false;
      el.style.display = "flex"; el.innerHTML = "数据加载中…";
      if (window.echarts) { bootChartNow(); return; }
      pendingEchartsCb = bootChartNow;
      ensureEcharts();
    };
  }
  function ensureEcharts() {
    if (window.echarts || echartsLoadStarted) { if (window.echarts) fireEchartsReady(); return; }
    echartsLoadStarted = true;
    var i = 0;
    function tryNext() {
      if (window.echarts) { fireEchartsReady(); return; }
      if (i >= ECHARTS_SRCS.length) { onEchartsFail(); return; }
      var isLast = (i === ECHARTS_SRCS.length - 1);
      var src = ECHARTS_SRCS[i++];
      var s = document.createElement("script");
      s.src = src; s.async = true;
      var done = false;
      // 非末源（CDN）给 9s 切换；末源（本地 vendor）给 45s，避免 github.io 国内慢时被误判失败
      var budget = isLast ? 45000 : 9000;
      var to = setTimeout(function () {
        if (done) return; done = true;
        if (isLast) onEchartsFail(); else tryNext();
      }, budget);
      function settle(ok) {
        if (done) return; done = true; clearTimeout(to);
        if (ok && window.echarts) { fireEchartsReady(); return; }
        if (isLast) onEchartsFail(); else tryNext();
      }
      s.onload = function () { settle(true); };
      s.onerror = function () { settle(false); };
      document.head.appendChild(s);
    }
    tryNext();
  }
  // ECharts（1MB）多源动态加载（见 ensureEcharts），可能晚于 app.js 执行；图表等它就绪再初始化。
  // 有 60s 轮询上限兜底；库彻底不可达时由 onEchartsFail 给重试 UI（数据区照常可用）。
  function whenEchartsReady(cb) {
    ensureEcharts();
    if (window.echarts && window.echarts.init) { cb(); return; }
    pendingEchartsCb = cb;
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      if (window.echarts && window.echarts.init) { clearInterval(t); pendingEchartsCb = null; cb(); }
      else if (tries >= 600) clearInterval(t);
    }, 100);
  }
  function boot(b, fromCache) {
    if (!b || !b.meta) return;
    mergeBoot(b);
    var stamp = b.meta.generatedAt;
    // 同版本且已不是缓存态 → 无需重绘（两路竞速都会回调，避免抖动）
    if (booted && state.meta && stamp && stamp === state.meta.generatedAt && !state.fromCache) return;
    state.meta = b.meta;
    if (b.events) state.events = b.events;
    if (b.eventsMeta) state.eventsMeta = b.eventsMeta;
    state.fromCache = !!fromCache;
    if (!booted) {
      booted = true;
      setupMetaUI();
      bindEvents();
      syncUIFromState();
      // 数据区不依赖 ECharts：四卡 / 事件 / 更新时间立即渲染，不等 1MB 图表库
      switchMetal(state.metal, true);
      whenEchartsReady(bootChartNow);
      startAutoRefresh();
    } else {
      setupMetaUI();
      if (cache[state.metal]) applyMetalData(cache[state.metal]);
      renderEvents();
    }
  }

  function init() {
    parseHash();
    var cached = readBootCache();
    if (cached) boot(cached, true);          // 秒开：不等网络
    var take = function (b) {
      try { boot(b, false); prefetchMetals(); } catch (e) {}
    };
    tryBundle().then(take).catch(function () {});
    loadMinimal(state.metal).then(take).catch(function () {});
    // 两路全挂才走原分散请求（其内部 loadFirst 现已并行竞速，不会串行拖 4 个源）
    setTimeout(function () { if (!booted) originalInit(); }, 14000);
  }

  // 原分散请求初始化（最终兜底路径，逻辑不变，结果统一交给 boot() 渲染）
  function originalInit() {
    Promise.all([
      // 【C32·三端统一】全部改为 GH Pages 镜像优先（与手机网页/小程序同源同字节），平台 /api 兜底
      loadFirst([canon(CANON + "data/meta.json"), "/api/meta" + shareQ(), jsd(JSD + "data/meta.json"), "data/meta.json"]),
      loadFirst([canon(CANON + "data/events.json"), "/api/events" + shareQ(), jsd(JSD + "data/events.json"), "data/events.json"]),
      // 事件独立元信息：老版本接口/文件缺失时容忍 null（更新时间回退为价格时间）
      loadFirst([canon(CANON + "data/events.meta.json"), "/api/events-meta" + shareQ(), jsd(JSD + "data/events.meta.json"), "data/events.meta.json"]).catch(function () { return null; }),
    ])
      .then(function (res) {
        boot({ meta: res[0], events: res[1], eventsMeta: res[2], metals: {} }, false);
        prefetchMetals();
      })
      .catch(function (e) { if (!booted) alert("初始化失败：" + e.message); });
  }

  // 解析 URL Hash 深链：#metal=silver 或 #unit=gram
  function parseHash() {
    var h = (location.hash || "").replace(/^#/, "");
    if (!h) return;
    h.split("&").forEach(function (kv) {
      var p = kv.split("=");
      if (p.length !== 2) return;
      if (p[0] === "metal" && ["gold", "silver", "copper"].indexOf(p[1]) >= 0) state.metal = p[1];
      if (p[0] === "unit" && p[1] === "gram") state.gram = true;
    });
  }
  // 把 state 反映到控件（金属 Tab、市场、粒度、单位）
  function syncUIFromState() {
    [].forEach.call(document.querySelectorAll("#metalTabs .tab"), function (t) {
      t.classList.toggle("active", t.dataset.metal === state.metal);
    });
    [].forEach.call(document.querySelectorAll(".markets .chip"), function (t) {
      t.classList.toggle("active", !!state.markets[t.dataset.market]);
    });
    [].forEach.call(document.querySelectorAll(".granularity .chip"), function (t) {
      t.classList.toggle("active", t.dataset.gran === state.gran);
    });
    syncUnitToggle();
  }

  // 小时线可用性：铜等品种本轮真实 60 分钟K 未返回合格数据 → hourly 为空，禁用「时」选项
  // （三端统一原则：缺数据不展示空图）
  function hourlyReady() {
    var h = state.data && state.data.hourly;
    return !!(h && ((h.london || []).length + (h.domestic || []).length) > 0);
  }
  function syncGranAvailability() {
    var ok = hourlyReady();
    [].forEach.call(document.querySelectorAll(".granularity .chip"), function (t) {
      if (t.dataset.gran === "hour") {
        t.classList.toggle("disabled", !ok);           // 无小时线时禁用「时」
        t.title = ok ? "" : "暂无小时线：该品种本轮真实 60 分钟K 未返回数据，已保留日线";
      }
    });
    // 当前若停留在「时」但无小时线 → 回退「天」，避免空图
    if (!ok && state.gran === "hour") {
      state.gran = "day";
      [].forEach.call(document.querySelectorAll(".granularity .chip"), function (t) {
        t.classList.toggle("active", t.dataset.gran === state.gran);
      });
    }
  }

  /* ---------- 图表 ---------- */
  function initChart() {
    chart = echarts.init(document.getElementById("chart"));
    window.addEventListener("resize", function () { chart.resize(); });
    document.addEventListener("fullscreenchange", function () {
      setTimeout(function () { chart.resize(); }, 60);
      // 用户通过系统手势/ESC 退出全屏时，同步清理横屏状态与按钮
      if (!document.fullscreenElement && lsActive) exitLandscape();
    });
  }

  function getSeriesSource() {
    // 返回 {src: {market:[...]}, useHour}
    var d = state.data;
    var useHour = state.gran === "hour";
    var src = useHour ? d.hourly : d.series;
    return { src: src, useHour: useHour };
  }

  // 月/年粒度：按期末收盘聚合日线（专业平台惯例），把上千点压到几十点，渲染更快
  function aggregate(pts, gran) {
    if (gran !== "month" && gran !== "year") return pts;
    var buckets = {};
    for (var i = 0; i < pts.length; i++) {
      var d = new Date(pts[i][0]);
      var key = gran === "month" ? (d.getFullYear() + "-" + d.getMonth()) : "" + d.getFullYear();
      (buckets[key] = buckets[key] || []).push(pts[i]);
    }
    var out = [];
    for (var k in buckets) {
      var arr = buckets[k];
      out.push([arr[arr.length - 1][0], arr[arr.length - 1][1]]);
    }
    return out;
  }

  // 非交易时段处理：相邻两点间隔超过阈值 → 主线断开、单独用虚线连接（避免"价格跳水"错觉）。
  // 专业金融平台（TradingView/富途/雪球）对休市跳空均以虚线或断线表达，实线只画交易时段。
  function splitGaps(pts, gran) {
    var gapMs = gran === "hour" ? 1.6 * 3600000 : 1.35 * 86400000;
    var main = [], dash = [];
    for (var i = 0; i < pts.length; i++) {
      main.push(pts[i]);
      if (i < pts.length - 1) {
        var dt = pts[i + 1][0] - pts[i][0];
        if (dt > gapMs) {
          main.push(null);                          // 主线在此断开
          dash.push(pts[i], pts[i + 1], null);      // 虚线连接这对点（点对间以 null 分隔）
        }
      }
    }
    return { main: main, dash: dash };
  }

  // 【2026-11-07 修复·未收盘误标】与小程序 utils/chart-core.js 完全同一口径，勿单边改。
  // 只有折线末点属于「当前尚未结束的周期」时，才允许用 60 秒实时现货覆盖末点并标注「实时(未收盘)」。
  // 周末/夜间/收盘后，末点是上一交易日的**已收盘**日K，标「未收盘」自相矛盾，
  // 更不能拿休市期间的现货价去覆盖已收盘价（用户反馈「日线更新到 6 号，还显示未收盘价」）。
  // 时间戳口径：日线为 UTC 当日零点、小时线为 UTC 整点，统一按北京日历比较。
  function isLivePeriod(lastTs, gran, nowTs) {
    if (!isFinite(lastTs) || lastTs <= 0) return false;
    var now = nowTs || Date.now();
    if (lastTs > now) return false;               // 未来点一律不标
    var a = new Date(lastTs + 8 * 3600000);
    var b = new Date(now + 8 * 3600000);
    var sameDay = a.getUTCFullYear() === b.getUTCFullYear()
               && a.getUTCMonth() === b.getUTCMonth()
               && a.getUTCDate() === b.getUTCDate();
    if (gran === "hour") return sameDay && a.getUTCHours() === b.getUTCHours();
    if (gran === "month") return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
    if (gran === "year") return a.getUTCFullYear() === b.getUTCFullYear();
    return sameDay;
  }

  function computeZoom(len) {
    var win;
    if (state.gran === "hour") win = 72;          // 显示近 72 个小时点
    else win = state.gran === "year" ? 365 : state.gran === "month" ? 90 : 30;
    var start = Math.max(0, 100 * (1 - win / Math.max(len || 1, 1)));
    return [start, 100];
  }

  function themeColors() {
    var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    return dark
      ? { text: "#93a0b4", line: "#262c38" }
      : { text: "#5b6472", line: "#e6e9ef" };
  }

  /* ---------- 图表 ---------- */
  // 横轴 time 轴标签密度控制（axisLabel.hideOverlap 对 time 轴无效，自行按像素间距过滤）
  var lsXRange = null;        // 当前 dataZoom 窗口 [startMs, endMs]，渲染时写入
  var lsLastShown = -Infinity; // 最近一次显示的标签时间戳，供 formatter 间距判断
  var lsDayWithYear = false;   // 可见窗口是否跨年：跨年时日标签补年份
  // 【1 分钟实时价·健壮性】快速连点「金属 / 市场 / 单位」会在同一帧内触发多次
  // setOption(notMerge)，ECharts 重建坐标系时偶发 getAxesOnZeroOf / __ec_inner_ 竞态报错，
  // 异常还会冒泡到事件回调，把后面的 computeAndRenderStats() 一起掐断（四卡停在上一个市场）。
  // 对策：同帧多次请求合并到下一帧只渲染一次；渲染异常就地隔离，绝不影响数字重算。
  var chartPending = false;
  function safeRenderChart(sync) {
    if (sync) { try { renderChart(); } catch (e) { console.warn("[chart] 渲染异常，保留上一帧：" + (e && e.message)); } return; }
    if (chartPending) return;
    chartPending = true;
    requestAnimationFrame(function () {
      chartPending = false;
      try { renderChart(); } catch (e) { console.warn("[chart] 渲染异常，保留上一帧：" + (e && e.message)); }
    });
  }
  function renderChart() {
    // 【2026-11-06 首屏提速】ECharts 改为低优先级异步加载：它没就绪时不尝试画图，
    // 四卡 / 事件 / 更新时间等不依赖图表的区域照常先渲染，库到位后再补画一次。
    if (!chart) return;
    var info = getSeriesSource();
    var d = state.data;
    var fx = fxOf(d);
    var gram = useGram();
    var active = MARKET_ORDER.filter(function (m) { return state.markets[m]; });
    var tc = themeColors();
    var narrow = document.getElementById("chart").clientWidth < 640;
    var isLandscape = document.getElementById("chartWrap").classList.contains("landscape")
      || document.getElementById("chartWrap").classList.contains("fullscreen");

    // 小时线缺失（真实源未返回）时给出说明，不用合成数据充数
    var loadingEl = document.getElementById("chartLoading");
    if (info.useHour && (!info.src.london || !info.src.london.length)) {
      loadingEl.style.display = "flex";
      loadingEl.textContent = d.hourlyNote || "小时线暂不可用：真实 60 分钟K 源本轮未返回数据，已保留日线；将在下一次例行抓取（每 15 分钟）自动恢复。";
      document.getElementById("chart").style.visibility = "hidden";
    } else {
      loadingEl.style.display = "none";
      document.getElementById("chart").style.visibility = "";
    }

    var series = [], yAxis, gridRight;

    // 每个市场：主线（交易时段实线，跨休市断开）+ 虚线连接 series（非交易时段）
    var aggSrc = {};
    // 【C48 防御】过滤未来时间戳点（东财当前未走完小时 bar 按收盘打未来时间戳）；
    //   generate.js 已从源头剔除，此处为端上双保险，避免任何未来点进入折线图。
    var nowTs = Date.now();
    active.forEach(function (m) {
      aggSrc[m] = aggregate((info.src[m] || []).filter(function (p) { return p[0] <= nowTs; }), state.gran);
    });
    // 【2026-11-08 修复·未来空白轴】显式锁定时间轴范围 = 过滤后真实数据首尾（跨激活市场取最值），
    // 不再让 ECharts 自动 nice 延伸到 2027（实测竖屏 2027-01-01、横屏 2027-10-01 空白）。
    // 右侧命中空间由 grid.right 兜底，故 boundaryGap 两侧归零（见下方 xAxis）。
    var axisMin = Infinity, axisMax = -Infinity;
    active.forEach(function (m) {
      var a = aggSrc[m] || [];
      if (a.length) {
        if (a[0][0] < axisMin) axisMin = a[0][0];
        if (a[a.length - 1][0] > axisMax) axisMax = a[a.length - 1][0];
      }
    });
    if (!isFinite(axisMin)) { axisMin = null; axisMax = null; }
    function marketSeries(m, yAxisIndex) {
      var pts = convertPts(aggSrc[m] || [], m, fx);
      var g = splitGaps(pts, state.gran);
      // 【2026-11-06 修复：折线图末点 = 60 秒实时现货价】
      // 日/月/年/时的"当前未结束周期"末点本用批处理聚合值，与「最新价」卡（直连 gold-api 60 秒实时）
      // 不一致，造成"金价不是最新价 / 今天没结束"的错觉。把末点的值替换为实时现货价，
      // 并叠加一个菱形"实时(未收盘)"标记，随 60 秒链路自动更新；失败（无报价）时静默跳过。
      // 【2026-11-07 加固】上述前提「末点始终是当前未结束周期」在周末 / 夜间 / 节假日不成立：
      // 此时末点是上一交易日的**已收盘**日K，标「实时(未收盘)」自相矛盾，且会拿休市期间的
      // 现货价去覆盖已收盘价。故只有 isLivePeriod 判定为「当前尚未结束的周期」时才覆盖 + 标记；
      // 已收盘周期保持真源收盘价、不叠加菱形实时点。休市原因由图表卡的「非交易时段」说明解释，
      // 不让用户误以为数据停更（与小程序 utils/chart-core.js 同一口径）。
      var live = livePricesFor(state.metal, d);
      var lastTs = null;
      for (var ti = g.main.length - 1; ti >= 0; ti--) {
        if (g.main[ti] != null) { lastTs = g.main[ti][0]; break; }
      }
      var periodOpen = isLivePeriod(lastTs, state.gran, nowTs);
      if (periodOpen && live && live[m] != null && isFinite(live[m]) && g.main.length) {
        for (var li = g.main.length - 1; li >= 0; li--) {
          if (g.main[li] != null) {
            var liveVal = gram ? convertSpotValue(live[m], m, state.metal, gram, fx) : live[m];
            g.main[li] = [g.main[li][0], liveVal];
            var livePt = g.main[li];
            var liveScatter = {
              name: MARKET_CN[m] + "·实时",
              type: "scatter",
              symbol: "diamond",
              symbolSize: 11,
              itemStyle: { color: MARKET_COLOR[m], borderColor: "#fff", borderWidth: 1.5 },
              z: 12,
              animation: false,
              silent: false,
              data: [livePt],
            };
            if (yAxisIndex != null) liveScatter.yAxisIndex = yAxisIndex;
            series.push(liveScatter);
            break;
          }
        }
      }
      var s = {
        name: MARKET_CN[m],
        type: "line",
        showSymbol: false,
        smooth: false,
        sampling: "lttb",
        progressive: 4000,
        lineStyle: { width: 2 },
        itemStyle: { color: MARKET_COLOR[m] },
        emphasis: { focus: "series" },
        animation: false,
        data: g.main,
      };
      if (yAxisIndex != null) s.yAxisIndex = yAxisIndex;
      series.push(s);
      if (g.dash.length) {
        series.push({
          name: MARKET_CN[m] + "·非交易时段",
          type: "line",
          showSymbol: false,
          silent: true,
          animation: false,
          z: 1,
          lineStyle: { width: 1.5, type: "dashed", color: MARKET_COLOR[m], opacity: 0.75 },
          itemStyle: { color: MARKET_COLOR[m] },
          data: g.dash,
        });
      }
    }

    if (gram) {
      // 元/克 视图：单一 Y 轴（所有市场已折算成同一单位，可比）
      // 单位不设 axis 名（会与图例压盖），改由图例 formatter 附带
      active.forEach(function (m) { marketSeries(m, null); });
      yAxis = {
        type: "value",
        scale: true,
        axisLabel: { color: tc.text, formatter: function (v) { return fmtNum(v); } },
        splitLine: { lineStyle: { color: tc.line, type: "dashed" } },
      };
      // 【2026-11-07 修复·末点贴边难 hover】右侧留白由 18 → 26：最新一点原本几乎压在
      // 图表/屏幕右边缘，手指或鼠标一靠近边缘就点不中，tooltip 也容易溢出被裁。
      // 与下方 xAxis.boundaryGap 右侧 6% 一起把末点推进可点区域（小程序同口径）。
      gridRight = 26;
    } else {
      // 原始单位视图：每个市场一条独立 Y 轴，避免「美元/盎司 vs 元/克 vs 港元/盎司」量纲差异把曲线压平
      active.forEach(function (m, i) { marketSeries(m, i); });
      yAxis = active.map(function (m, i) {
        return {
          type: "value",
          scale: true,
          position: i === 0 ? "left" : "right",
          offset: i === 0 ? 0 : (i - 1) * 60,
          axisLine: { show: true, lineStyle: { color: MARKET_COLOR[m] } },
          axisLabel: { color: MARKET_COLOR[m], formatter: function (v) { return fmtNum(v); } },
          splitLine: { show: i === 0, lineStyle: { color: tc.line, type: "dashed" } },
        };
      });
      // 多 Y 轴占位之外再留 36px 命中空间（原 24px 偏窄，靠右边缘点不中）
      gridRight = (active.length - 1) * 60 + 36;
    }

    // 【2026-11-06】保留用户当前的 dataZoom（避免 60 秒重绘 / 切金属时把缩放/平移重置回默认窗口）
    var keepZoom = null;
    if (chart && chart.getOption) {
      try {
        var dz = chart.getOption().dataZoom;
        if (dz && dz[0] && typeof dz[0].start === "number" && typeof dz[0].end === "number") {
          keepZoom = [dz[0].start, dz[0].end];
        }
      } catch (e) { /* 忽略 */ }
    }
    var zoom = keepZoom || computeZoom((aggSrc[active[0]] || aggSrc.london || []).length);
    var MARKET_BY_CN = { "伦敦": "london", "国内": "domestic", "香港": "hongkong" };
    var gridBottom = narrow ? 80 : 64;      // 小屏留足横轴标签 + 缩放条空间
    var sliderH = narrow ? 22 : 26;
    var sliderB = narrow ? 10 : 14;
    var axisFs = narrow ? 10 : 12;
    // 横轴标签预算：按绘图区宽度估算最多可容纳几个时间标签（按字号估每个标签占位），
    // time 轴的 hideOverlap 不生效，超预算的标签在 formatter 里按间距过滤
    var chartW = document.getElementById("chart").clientWidth || 320;
    var labelPx = axisFs >= 12 ? 78 : 56;   // 竖屏字号小，标签占位也相应收窄
    var maxXLabels = Math.max(2, Math.min(12, Math.floor((chartW - 100) / labelPx)));
    // 全屏/横屏时顶部留出退出按钮空间，图例移到左上避免与之重叠
    var gridTop = isLandscape ? 52 : 42;
    var option = {
      color: active.map(function (m) { return MARKET_COLOR[m]; }),
      series: series,
      grid: { left: 8, right: gridRight, top: gridTop, bottom: gridBottom, containLabel: true },
      tooltip: {
        trigger: "axis",
        // 【2026-11-07 修复·hover 难点】点击/触摸也触发（不只 mousemove，移动端更友好）；
        // confine 把浮层限制在画布内，避免靠右边缘时 tooltip 溢出屏幕被裁掉看不见。
        triggerOn: "mousemove|click",
        confine: true,
        axisPointer: {
          // 【2026-11-06 修复·hover】由 "cross" 改为 "line"：cross 的 Y 轴标签显示光标 Y 插值，
          // 与 tooltip 数据值不一致（如 872.46 vs 901.82）造成读感断裂；line 仅竖线 + tooltip 取真实数据，
          // 与小程序口径一致。
          type: "line",
          snap: true,   // 吸附最近数据点：不用精确戳中细线，靠近即出值
          lineStyle: { color: "#c3c9d4" },
          label: {
            // 默认会把全量时间（2021-01-11 08:00:00）做成 chip 挤在轴标签行里，改简短格式
            formatter: function (p) {
              var v = p && p.value;
              var num = (v && typeof v === "object") ? (v.value != null ? v.value : v[0]) : v;
              if (num == null || isNaN(num)) return "";
              if (p.axisDimension === "y" || num < 1e9) return fmtNum(num); // 价格轴
              return fmtAxis(num); // 时间轴（时间戳量级 >1e9）
            },
          },
        },
        backgroundColor: "rgba(23,27,35,.92)",
        borderWidth: 0,
        textStyle: { color: "#e8ebf0", fontSize: 12 },
        formatter: function (params) {
          if (!params.length) return "";
          var vis = params.filter(function (p) { return p.seriesName.indexOf("·非交易时段") < 0; });
          if (!vis.length) return "";
          var head = fmtDate(vis[0].value[0], state.gran);
          var html = "<div style='font-weight:600;margin-bottom:4px'>" + head + "</div>";
          vis.forEach(function (p) {
            var baseName = p.seriesName.replace(/·.*$/, "");
            var mk = MARKET_BY_CN[baseName];
            var isLive = p.seriesName.indexOf("·实时") >= 0;
            var label = isLive ? (baseName + " · 实时(未收盘)") : p.seriesName;
            var u = gram ? "元/克" : ((d.unit && d.unit[mk]) || "");
            html += "<div style='display:flex;justify-content:space-between;gap:14px'>" +
              "<span>" + p.marker + label + "</span>" +
              "<b>" + fmtNum(p.value[1]) + (u ? " " + u : "") + "</b></div>";
          });
          return html;
        },
      },
      legend: {
        data: active.map(function (m) { return MARKET_CN[m]; }),
        top: isLandscape ? 12 : 8,
        left: isLandscape ? 12 : "center",
        textStyle: { color: tc.text },
        // 轴名已移除，单位改由图例文字附带，避免与图例压盖
        formatter: function (name) {
          var mk = MARKET_BY_CN[name];
          var u = gram ? "元/克" : (mk && d.unit ? d.unit[mk] : "");
          return u ? name + " " + u : name;
        },
      },
      xAxis: {
        type: "time",
        // 【2026-11-08 修复·末点不再延伸到未来】显式锁定到真实数据范围（axisMin/axisMax 见上方），
        // boundaryGap 两侧归零，右侧命中空间由 grid.right 提供；末点不再压边、也不被 nice 到 2027。
        boundaryGap: ["0%", "0%"],
        min: axisMin,
        max: axisMax,
        splitNumber: maxXLabels,
        axisLabel: {
          color: tc.text, hideOverlap: true, fontSize: axisFs,
          // time 轴的 hideOverlap 不生效：按当前缩放窗口与绘图区宽度算最小标签间距，不足则隐藏
          formatter: function (v, idx) {
            if (idx === 0) {
              lsLastShown = -Infinity; // 每批标签从锚点重新起算，缩放后自纠错
              // 可见窗口是否跨年：跨年时把日标签补年份，避免缩放后 "12/01、02/01" 重复
              var dz0 = chart.getOption().dataZoom;
              lsDayWithYear = false;
              if (dz0 && dz0[0] && lsXRange) {
                var z0 = dz0[0];
                var st0 = (z0.start != null ? z0.start : 0) / 100;
                var en0 = (z0.end != null ? z0.end : 100) / 100;
                var wStart = lsXRange[0] + st0 * (lsXRange[1] - lsXRange[0]);
                var wEnd = lsXRange[0] + en0 * (lsXRange[1] - lsXRange[0]);
                lsDayWithYear = new Date(wStart).getFullYear() !== new Date(wEnd).getFullYear();
              }
            }
            var dz = chart.getOption().dataZoom;
            if (dz && dz.length && lsXRange) {
              var z = dz[0];
              var st = (z.start != null ? z.start : 0) / 100;
              var en = (z.end != null ? z.end : 100) / 100;
              var spanMs = Math.max(1, (en - st) * (lsXRange[1] - lsXRange[0]));
              var plotPx = Math.max(160, chart.getWidth() - 40 - gridRight);
              if (v - lsLastShown < (spanMs * labelPx / plotPx)) return "";
            }
            lsLastShown = v;
            return fmtAxis(v);
          },
        },
        axisLine: { lineStyle: { color: tc.line } },
        splitLine: { show: false },
      },
      yAxis: yAxis,
      dataZoom: [
        { type: "inside", start: zoom[0], end: zoom[1], zoomOnMouseWheel: true, moveOnMouseMove: true },
        {
          type: "slider", start: zoom[0], end: zoom[1], height: sliderH, bottom: sliderB,
          borderColor: tc.line, backgroundColor: "rgba(127,127,127,.06)",
          fillerColor: "rgba(212,160,23,.20)",
          handleSize: "130%",
          handleStyle: { color: "#d4a017", borderColor: "#8a6d12", borderWidth: 2 },
          moveHandleStyle: { color: "#d4a017" },
          dataBackground: { lineStyle: { color: "#c3c9d4", width: 1 }, areaStyle: { color: "rgba(195,201,212,.18)" } },
          selectedDataBackground: { lineStyle: { color: "#d4a017", width: 1 }, areaStyle: { color: "rgba(212,160,23,.14)" } },
          textStyle: { color: tc.text, fontSize: 9 },
        },
      ],
      animation: false,
    };
    // 记录全量数据跨度，供横轴标签间距过滤换算缩放窗口使用
    var pts0 = aggSrc[active[0]] || aggSrc.london || [];
    if (axisMin != null) lsXRange = [axisMin, axisMax];
    // 【2026-11-08 修复·说明整合统一】与小程序 chartCaption 同文案、同口径（三端统一）：
    // 常驻交易时段/虚线/缩放/60秒/15分钟（国内联动价）；休市时前置一句「非交易时段…数据未停更」。
    var noteEl = document.getElementById("chartCaption");
    if (noteEl) {
      var lastTs0 = pts0.length ? pts0[pts0.length - 1][0] : 0;
      var sessionClosed = lastTs0 > 0 && !isLivePeriod(lastTs0, state.gran, nowTs);
      var sessionAt = lastTs0 ? fmtDate(lastTs0, state.gran).replace(/^\d{4}-/, "") : "";
      var MECH = "交易时段为实线，非交易时段（夜间 / 周末 / 节假日）以虚线连接；可缩放拖动查看。最新价每 60 秒刷新，历史曲线每 15 分钟更新（国内为联动价）。";
      noteEl.textContent = sessionClosed
        ? "当前为非交易时段，曲线截至 " + sessionAt + " 收盘，数据未停更（真源每 15 分钟、最新价每 60 秒仍在更新）。" + MECH
        : MECH;
      noteEl.hidden = false;
    }
    chart.setOption(option, true);
    document.getElementById("chartLoading").style.display = "none";
  }

  /* ---------- 统计卡片 ---------- */
  function computeAndRenderStats() {
    var d = state.data;
    var fx = fxOf(d);
    var primary = MARKET_ORDER.filter(function (m) { return state.markets[m]; })[0] || "london";
    // 【2026-11-07】真源个别市场会带「下一交易日」预置点（周末出现未来日K），
    // 统计口径必须与图表一致剔除未来点，否则「最新价/日涨跌/区间高低」被未来数据污染。
    var nowTs = Date.now();
    var raw = (d.series[primary] || []).filter(function (p) { return p && p[0] <= nowTs; });
    var pts = convertPts(raw, primary, fx);
    var box = document.getElementById("stats");
    if (pts.length < 2) { box.innerHTML = ""; return; }
    // 【1 分钟实时价】有现货则用「当前市场 + 当前单位」下的实时价，否则回退真源曲线末端（15 分钟版）
    var live = livePricesFor(state.metal, d);
    var liveRaw = live && live[primary] != null ? live[primary] : null;
    var latest = liveRaw != null
      ? convertSpotValue(liveRaw, primary, state.metal, state.gram, fx)
      : pts[pts.length - 1][1];
    var prev = pts[pts.length - 2][1];
    var todayPct = ((latest - prev) / prev) * 100;
    // 近一年：按时间戳取约 365 天前的点（真实日K仅含交易日，不能按条数索引）
    var yearAgo = pts[pts.length - 1][0] - 365 * 86400000;
    var idxYear = 0;
    for (var i = pts.length - 1; i >= 0; i--) {
      if (pts[i][0] <= yearAgo) { idxYear = i; break; }
    }
    var yearVal = pts[idxYear][1];
    var yearPct = ((latest - yearVal) / yearVal) * 100;
    var hi = -Infinity, lo = Infinity;
    for (var i = 0; i < pts.length; i++) { var v = pts[i][1]; if (v > hi) hi = v; if (v < lo) lo = v; }
    // 最新价刷新后历史区间一并取极值，避免「最新价高于历史高点」这种自相矛盾
    hi = Math.max(hi, latest); lo = Math.min(lo, latest);
    var unit = useGram() ? "元/克" : d.unit[primary];
    // 【2026-11-06 UI 精简】价格卡单位行去掉「· 联动 / · 实时」后缀（与小程序一致），
    //   联动/实时的数据来源口径已统一在底部说明与图表卡 tooltip 解释，卡片不再重复贴标。
    var unitLine = unit;

    function cls(p) { return p >= 0 ? "up" : "down"; }
    // 【指标看板统一·改】四卡一律「标题 / 主数值 / 副行」三层结构，与小程序完全对齐：
    //   ① 涨跌类卡片以「涨跌幅 %」为主数值（跨品种可比），绝对值+单位下沉为灰色副行；
    //   ② 单位不塞标题（四卡标题等长）；③ 仅主数值带涨跌色，副行恒灰，避免一卡两色一片红。
    var dayAbs = (latest - prev >= 0 ? "+" : "") + fmtNum(latest - prev) + " " + unit;
    var spanMs = pts.length > 1 ? (pts[pts.length - 1][0] - pts[0][0]) : 0;
    var spanYears = Math.max(1, Math.round(spanMs / (365 * 86400000) * 10) / 10);
    box.innerHTML =
      card("最新价（" + MARKET_CN[primary] + "）", fmtNum(latest), "", unitLine) +
      card("最新日涨跌", fmtPct(todayPct), cls(todayPct), dayAbs) +
      card("近一年涨跌", fmtPct(yearPct), cls(yearPct), (pts.length - idxYear) + " 个数据点") +
      // 【修复选择器不匹配】history 容器必须与小程序一致为「同一元素 .v.his-range」，
      // 不能是 .v 内再嵌一层 .his-range（旧写法导致 CSS .v.his-range 永不命中，
      // 数字一直继承 .v 的 22px/700 黑字、且高低红绿不渲染）。
      card("历史区间",
        "<div class='hr-row'><span class='hr-key up'>高</span><span class='hr-val up'>" + fmtNum(hi) + "</span></div>" +
        "<div class='hr-row'><span class='hr-key down'>低</span><span class='hr-val down'>" + fmtNum(lo) + "</span></div>",
        "his-range", "近 " + spanYears + " 年高低点");
  }
  function card(k, v, vCls, sub) {
    var s = sub != null ? "<div class='sub'>" + sub + "</div>" : "";
    return "<div class='stat-card'><div class='k'>" + k + "</div><div class='v " + (vCls || "") + "'>" + v + "</div>" + s + "</div>";
  }

  /* ---------- 事件 ---------- */
  // 翻页/筛选后把视口带到重大事件开头，避免用户人工滑动查找
  function scrollToEvents() {
    var sec = document.querySelector(".events");
    if (sec && sec.scrollIntoView) sec.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  // 按品种取事件：事件正本只存一份，用 metals[] 记录影响品种（跨品种去重后不丢、不重）
  function eventsForMetal(metal) {
    if (window.EDedupe && window.EDedupe.eventsFor) return window.EDedupe.eventsFor(state.events || {}, metal);
    return ((state.events || {})[metal] || []).slice();
  }
  function renderEvents() {
    // 三端一致：事件区只展示当前选中品种相关的事件（跟随顶部金/银/铜切换）
    var mName = state.metal === "gold" ? "金" : state.metal === "silver" ? "银" : "铜";
    var mEl = document.getElementById("eventsMetal");
    if (mEl) mEl.textContent = "· " + mName;
    var list = eventsForMetal(state.metal).slice().sort(function (a, b) {
      return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
    });
    if (state.eventCat !== "all") list = list.filter(function (e) { return e.category === state.eventCat; });
    // 【C22】同日「相关性可计算」优先：当天新事件的事件窗（5 个交易日）未走完 → 相关性不可算；
    //   当天条目一多，首屏会全是「相关性 —」。日期倒序不变，仅同日内部把可计算的排前面（与小程序端同口径）。
    if (window.EDedupe && window.EDedupe.sortEventsForDisplay) {
      list = window.EDedupe.sortEventsForDisplay(list, function (e) { return !!corrFor(e); });
    }
    var total = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (state.eventPage > total) state.eventPage = total;
    var startIdx = (state.eventPage - 1) * PAGE_SIZE;
    var pageItems = list.slice(startIdx, startIdx + PAGE_SIZE);

    var ul = document.getElementById("eventList");
    // 【C31】标题「查看全部」展开：委托监听只绑定一次（innerHTML 重渲染不重复绑定）
    if (!ul.__evTitleWired) {
      ul.addEventListener("click", function (ev) {
        var more = ev.target && ev.target.closest ? ev.target.closest(".ei-more") : null;
        if (more) {
          var wrap = more.closest(".ei-title-wrap");
          if (wrap) {
            var open = wrap.classList.toggle("expanded");
            // a11y：按钮语义 + aria-expanded 同步 + 文案切换（视觉规格 §6.1）
            more.setAttribute("aria-expanded", open ? "true" : "false");
            more.textContent = open ? "收起 ›" : "查看全部 ›";
          }
        }
      });
      ul.__evTitleWired = true;
    }
    ul.innerHTML = pageItems.map(function (e) {
      // 【C32-bugfix】方向徽章取「机制修正后的有效方向」impactEff，与结论正文同源
      //   （旧口径下徽章按关键词分类器、结论按机制判定，实测 22 条「徽章中性 + 结论承压」互相打脸）
      var eff = e.impactEff || e.impact;
      var impCls = eff === "up" ? "impact-up" : eff === "down" ? "impact-down" : "impact-mixed";
      var impTxt = eff === "up" ? "利多" : eff === "down" ? "利空" : "中性";
      // a11y：不靠颜色 alone 传达方向（红绿色盲 / 国内外红绿语义相反），带 ▲▼— 字形
      var impGlyph = eff === "up" ? "▲" : eff === "down" ? "▼" : "—";
      var href = e.url ? String(e.url).replace(/&/g, "&amp;").replace(/"/g, "&quot;") : "";
      var origHtml = href
        ? "<a class='ei-link' href='" + href + "' target='_blank' rel='noopener' title='" + esc(e.origTitle || "") + "'>查看原文 ↗</a>"
        : "";
      // 标签与小程序端统一：滤掉方向性废话（走强/走弱，多空导向胶囊已表达）+ 互斥标签
      //   （「按兵不动」曾被同时打上「不加息」「加息」，两个相反标签并列会让人直接不信这条结论）
      var rawTags = (e.tags || []).filter(function (t) { return t !== "走强" && t !== "走弱"; });
      if (rawTags.indexOf("不加息") >= 0) rawTags = rawTags.filter(function (t) { return t !== "加息"; });
      if (rawTags.indexOf("加息") >= 0 && rawTags.indexOf("降息") >= 0) {
        var keepHike = /加息|鹰派|收紧|紧缩/.test(String(e.title || ""));
        rawTags = rawTags.filter(function (t) { return t !== (keepHike ? "降息" : "加息"); });
      }
      var evTags = rawTags.slice(0, 6)
        .map(function (t) { return "<span class='ei-tag'>" + esc(t) + "</span>"; }).join("");
      var scope = (e.impactScope || []).slice(0, 5);
      var degree = e.impactDegree || "";
      var sp = splitSummary(e.summary);
      // 【C32】影响结论：优先用数据层现场组句的 impactConclusion（125 条 → 70 种，去模板化），
      //   旧数据（未回填）回退到 summary 切分出的结论段，再兜底到多空方向预期句。
      var conclusion = e.impactConclusion || String(sp.impact || "").replace(/^影响：/, "") ||
        (impTxt + "（事件窗走完将给出统计结论）");
      // a11y：读屏串联「方向；影响范围；确定性；结论」（视觉规格 §6.2）
      var aria = [impTxt];
      if (scope.length) aria.push("影响范围：" + scope.join("、"));
      if (degree) aria.push("确定性：" + degree);
      aria.push("结论：" + conclusion);
      // 卡片三层 IA（PRIMARY 标题 → SECONDARY 事件事实 → TERTIARY 影响结论）
      //   头部只留「日期 · 分类」弱信息行；方向徽章只在影响区出现一次；相关性降为末端弱字。
      //   顺序与小程序严格对齐（EVENT_LIST_REDESIGN §(b) 单卡模板）：标题 → 元信息行 → 事件段 → 影响段
      return "<li class='event-item'>" +
        "<div class='ei-title-wrap'>" +
          "<div class='ei-title' role='heading' aria-level='3'>" + esc(e.title) + "</div>" +
          "<button type='button' class='ei-more' aria-expanded='false' hidden>查看全部 ›</button>" +
        "</div>" +
        "<div class='ei-meta'>" +
          "<span class='ei-date'>" + esc(e.date) + "</span>" +
          "<span class='ei-dot'>·</span>" +
          "<span class='ei-cat-txt'>" + esc(e.category) + "</span>" +
        "</div>" +
        "<div class='sec-div'><span>事件</span></div>" +
        "<div class='ei-fact'>" + esc(sp.event) + "</div>" +
        (evTags ? "<div class='ei-tags'>" + evTags + "</div>" : "") +
        "<div class='sec-div'><span>影响</span></div>" +
        "<div class='impact-head' aria-label=\"" + escAttr(aria.join("；")) + "\">" +
          "<span class='badge dir " + impCls + "'><span class='badge-glyph'>" + impGlyph + "</span>" + impTxt + "</span>" +
          (degree ? "<span class='chip-degree deg-" + degreeCls(degree) + "'>" + esc(degree) + "</span>" : "") +
          scope.map(function (x) { return "<span class='ei-itag scope'>" + esc(x) + "</span>"; }).join("") +
        "</div>" +
        "<div class='ei-conclusion'>" + esc(conclusion) + "</div>" +
        "<div class='ei-corr-weak'>" + esc(corrWeak(e)) + "</div>" +
        corrBasis(e) +
        "<div class='ei-source'>来源：" + esc(e.source) + (e.auto ? " ｜ AI 归纳" : "") + origHtml + "</div>" +
        "</li>";
    }).join("");
    // 「查看全部 ›」显隐：渲染后按实测溢出决定（比「字符数 > 22」准，短英文标题不会被误判）。
    //   折行由 CSS nowrap + 省略号兜底，这里只控制按钮入口（视觉规格 §6.1）。
    Array.prototype.forEach.call(ul.querySelectorAll(".ei-title-wrap"), function (w) {
      var t = w.querySelector(".ei-title"), more = w.querySelector(".ei-more");
      if (!t || !more) return;
      if (t.scrollWidth > t.clientWidth + 1) more.hidden = false;
    });

    // 当前筛选范围的平均相关性指数（覆盖全部页，非仅当前页）
    var corrVals = [];
    list.forEach(function (e) { var c = corrFor(e); if (c) corrVals.push(c.idx); });
    var avgEl = document.getElementById("corrAvg");
    if (avgEl) {
      avgEl.innerHTML = corrVals.length
        ? "当前筛选平均相关性 <b>" + Math.round(corrVals.reduce(function (a, b) { return a + b; }, 0) / corrVals.length) + "</b>（" + corrVals.length + "/" + list.length + " 条可计算）"
        : "";
    }

    // 分页
    var pager = document.getElementById("pager");
    if (total <= 1) { pager.innerHTML = ""; return; }
    // 单行紧凑三件套（上一页 / 第 x/y 页 · 共 N 条 / 下一页），不折行；与小程序端一致
    var html = "<button class='pg-nav' data-pg='prev' " + (state.eventPage === 1 ? "disabled" : "") + ">‹ 上一页</button>";
    html += "<span class='pg-info'>第 " + state.eventPage + " / " + total + " 页 · 共 " + list.length + " 条</span>";
    html += "<button class='pg-nav' data-pg='next' " + (state.eventPage === total ? "disabled" : "") + ">下一页 ›</button>";
    pager.innerHTML = html;
  }

  /* ---------- 事件-价格相关性指数（事件研究法 Event Study） ---------- */
  // 方法依据（Fama et al. 1969；MacKinlay 1997 事件研究法）：
  //   估计窗：事件日前 120 个交易日，计算日收益均值 μ 与标准差 σ（正常收益基准，均值调整模型）；
  //   事件窗：事件当日起 5 个交易日 [0,+5]（事件日为非交易日则顺延至下一交易日）；
  //   异常收益 AR_t = R_t − μ，累计 CAR = Σ AR_t；
  //   显著性 t = CAR /（σ·√L），L 为窗口实际交易日数；临界值 1.658/1.980/2.618 对应 10%/5%/1%；
  //   相关性指数（0-100）= 显著性 50 + 方向一致性 30 + 量级 20：
  //     显著性 = min(50, |t|/2.58×50)；
  //     方向：impact=up 要求 CAR>0、down 要求 CAR<0，同向 30、背离 0，mixed 中性主张 15；
  //     量级 = min(20, |CAR|/σ/3×20)。
  var CORR_EST = 120;     // 估计窗（交易日）
  var CORR_WIN = 5;       // 事件窗（交易日，[0,+5]）
  var CORR_T_FULL = 2.58; // |t| 满分阈值（1% 显著性临界值）
  var CORR_MAG_FULL = 3;  // |CAR|/σ 满分阈值（3 倍日波动）
  var corrCache = {};

  // 基准序列：优先国内（与默认视图一致；估计窗按交易日计数，天然跳过中国假期），
  // 要求事件日在覆盖范围内且事件窗至少有 2 个交易日；估计窗 ≥60 个交易日才直接采用，
  // 否则（仅数据起点附近的早年事件）记为首个可用备选。
  function corrBenchSeries(d, evUtc) {
    var fallback = null;
    var order = ["domestic", "london", "hongkong"];
    for (var oi = 0; oi < order.length; oi++) {
      var m = order[oi], arr = (d.series && d.series[m]) || [];
      if (arr.length < 30) continue;
      var t0 = -1; // 事件日 t0 = 首个 >= evUtc 的交易日
      for (var i = 0; i < arr.length; i++) { if (arr[i][0] >= evUtc) { t0 = i; break; } }
      if (t0 < 1) continue;                          // 事件日不在序列范围内（过早/过晚）
      if (arr.length < t0 + 2) continue;             // 事件窗不足 2 个交易日，无法评估
      if (t0 >= 60) return { market: m, arr: arr };  // 估计窗充足，直接采用
      if (!fallback) fallback = { market: m, arr: arr };
    }
    return fallback;
  }

  // 单条事件的相关性指数；数据窗口不足返回 null
  function eventCorrelation(d, ev) {
    var p = String(ev.date || "").split("-");
    if (p.length !== 3) return null;
    var evUtc = Date.UTC(+p[0], +p[1] - 1, +p[2]); // 序列时间戳为 UTC 午夜，事件日期按 UTC 对齐
    var b = corrBenchSeries(d, evUtc);
    if (!b) return null;
    var arr = b.arr;
    // 事件日 t0 = 首个 >= evUtc 的交易日（周末/节假日顺延）
    var t0 = -1;
    for (var i = 0; i < arr.length; i++) { if (arr[i][0] >= evUtc) { t0 = i; break; } }
    if (t0 < 1) return null;
    // 估计窗：t0 前最多 CORR_EST 个交易日 → μ、σ
    var estFrom = Math.max(0, t0 - CORR_EST);
    var estRets = [];
    for (var j = estFrom + 1; j <= t0 - 1; j++) estRets.push(arr[j][1] / arr[j - 1][1] - 1);
    if (estRets.length < 10) {
      // 估计窗不足（事件靠近数据起点）：回退用事件前全部（≤250 日）收益
      estRets = [];
      var allFrom = Math.max(0, t0 - 250);
      for (var k = allFrom + 1; k <= t0 - 1; k++) estRets.push(arr[k][1] / arr[k - 1][1] - 1);
      if (estRets.length < 10) return null;
    }
    var estN = estRets.length, s = 0;
    estRets.forEach(function (r) { s += r; });
    var mu = s / estN, v = 0;
    estRets.forEach(function (r) { v += (r - mu) * (r - mu); });
    var sigma = Math.sqrt(v / Math.max(1, estN - 1));
    // 事件窗 [t0, t0+CORR_WIN]
    var winEnd = Math.min(arr.length - 1, t0 + CORR_WIN);
    var L = winEnd - t0 + 1;
    if (L < 2) return null; // 窗口交易日不足，无法评估
    var car = 0;
    for (var w = t0; w <= winEnd; w++) car += (arr[w][1] / arr[w - 1][1] - 1) - mu;
    var tStat = sigma > 1e-9 ? car / (sigma * Math.sqrt(L)) : 0;
    // 方向一致性
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
    };
  }

  // 按事件键缓存（切换金属/重载数据时由 switchMetal 清空）
  function corrFor(ev) {
    var key = ev.date + "|" + (ev.title || "");
    if (corrCache[key] === undefined) corrCache[key] = eventCorrelation(state.data, ev);
    return corrCache[key];
  }

  // 指数徽标（只放卡片顶行；统计依据行见 corrBasis，放卡片底部，与小程序端结构一致）
  function corrBadge(ev) {
    var c = corrFor(ev);
    if (!c) return "<span class='ei-corr ci-none' title='事件窗数据不足，无法计算'>相关性 —</span>";
    var pct = (c.car * 100).toFixed(2);
    var sigTxt = Math.abs(c.t) >= 2.618 ? "1% 显著" : Math.abs(c.t) >= 1.980 ? "5% 显著" : Math.abs(c.t) >= 1.658 ? "10% 显著" : "不显著";
    var dirTxt = c.dirOK === null ? "方向中性" : c.dirOK ? "方向一致" : "方向背离";
    var dirCls = c.dirOK === null ? "dir-neutral" : c.dirOK ? "dir-ok" : "dir-bad";
    var mktName = c.market === "domestic" ? "国内" : c.market === "london" ? "伦敦" : "香港";
    var tip = "事件研究法：估计窗 120 交易日定 μ/σ → 事件窗 [0,+5] → CAR " + (c.car >= 0 ? "+" : "") + pct +
      "% ｜ t=" + c.t.toFixed(2) + "（" + sigTxt + "）｜ " + dirTxt + " ｜ 基准 " + mktName + "日K ｜ 指数=显著性50+方向30+量级20" +
      " ｜ 同日同品种事件共用同一价格窗口，CAR 相同属正常";
    return "<span class='ei-corr ci-" + (c.idx >= 70 ? "strong" : c.idx >= 40 ? "mid" : "weak") + "' title='" + esc(tip) + "'>相关性 <b>" + c.idx + "</b>·" + c.level + "</span>";
  }

  // 统计依据行：放卡片底部（摘要之后、来源之前），与小程序端 ev-basis 位置一致。
  // 省去非必要信息：「基准 XX日K」在每个卡片重复且底部说明已写明的，不再展示（保留在徽标 tooltip 里）。
  function corrBasis(ev) {
    var c = corrFor(ev);
    if (!c) return "<div class='ei-corr-basis ei-basis-none'>事件窗数据不足，无法计算相关性</div>";
    var pct = (c.car * 100).toFixed(2);
    var sigTxt = Math.abs(c.t) >= 2.618 ? "1% 显著" : Math.abs(c.t) >= 1.980 ? "5% 显著" : Math.abs(c.t) >= 1.658 ? "10% 显著" : "不显著";
    var dirTxt = c.dirOK === null ? "方向中性" : c.dirOK ? "方向一致" : "方向背离";
    var dirCls = c.dirOK === null ? "dir-neutral" : c.dirOK ? "dir-ok" : "dir-bad";
    return "<div class='ei-corr-basis'>" +
        "<span class='cb'>CAR <b>" + (c.car >= 0 ? "+" : "") + pct + "%</b></span>" +
        "<span class='cb'>" + c.L + " 个交易日" + (c.complete ? "" : "<i class='cb-open'>窗口未走完</i>") + "</span>" +
        "<span class='cb'>t <b>" + (c.t >= 0 ? "+" : "") + c.t.toFixed(2) + "</b> · " + sigTxt + "</span>" +
        "<span class='cb " + dirCls + "'>" + dirTxt + "</span>" +
      "</div>";
  }

  /* ---------- 最新价 1 分钟实时链路（C18 停用逻辑的重建）----------
     C18 当年停用浏览器直连现货，原因是「三端时间戳不一致 + 顶部时间闪烁」。
     本次重新启用但换了做法，两条老问题都不再成立：
       ① 三端一致：PC 网页 / 手机网页 / 小程序（云函数代理）全部读同一份 gold-api 现货，
          并用同一份真源锚点换算；顶部时间统一取「当前金属的实时报价时刻」。
       ② 不闪烁：只对成功响应更新报价，单品种 ts 不倒退；失败静默保留上一轮，时间只增不减。
          fmtLocal 精确到分钟，金属之间几秒的报价时差也不会造成可见跳动。
     严格边界：只刷新「最新价」及其派生指标，不重写历史曲线、不碰事件、不触发整页渲染。 */
  async function fetchOneSpot(metal) {
    var sym = SPOT_SYMBOL[metal];
    // 【坑·勿改】gold-api.com 把「整段路径」当品种代码，加 ?_ts= 会直接 404（实测）。
    //   也不要加 cache:"no-store" / 自定义头：会触发 CORS 预检 OPTIONS，跨域不稳。
    //   它自身 Cache-Control: max-age=16，1 分钟轮询天然拿得到新价，裸 GET 即可。
    var r = await fetch(SPOT_API + sym);
    if (!r.ok) throw new Error("spot " + sym + " " + r.status);
    var j = await r.json();
    if (!j || !isFinite(j.price) || j.price <= 0) throw new Error("spot " + sym + " bad price");
    return { metal: metal, price: j.price, ts: j.updatedAt || new Date().toISOString() };
  }

  async function refreshSpot(force) {
    if (spotState.fetching) return;
    if (!force && spotState.lastOkAt && Date.now() - spotState.lastOkAt < SPOT_MIN_GAP_MS) return;
    spotState.fetching = true;
    try {
      var rs = await Promise.all(SPOT_METALS.map(function (m) {
        return fetchOneSpot(m).catch(function () { return null; });
      }));
      var got = 0;
      rs.forEach(function (r) {
        if (!r) return;
        var old = spotState.quotes[r.metal];
        if (old && r.ts < old.ts) return; // 单品种时间戳只增不减
        spotState.quotes[r.metal] = { price: r.price, ts: r.ts };
        got++;
      });
      if (got) {
        spotState.lastOkAt = Date.now();
        spotSucceed();        // 定论「实时每分」并持久化，下次冷启动首帧即最终态
        if (state.data) {
          computeAndRenderStats(); // 四卡一起重算，避免「最新价变了但涨跌没变」
          renderUpdateTimes();    // 顶部 / 筛选区时间同步
          if (chart) safeRenderChart(); // 折线图实时末点（菱形标记）随 60 秒现货刷新；保留用户 dataZoom
        }
      } else {
        spotFailed();         // 单轮失败不改口，连续 2 轮才如实降级
      }
    } catch (e) { spotFailed(); /* 静默保留上一轮：不回退、不闪烁 */ }
    finally { spotState.fetching = false; }
  }

  /* ---------- 更新时间：按数据真实入库时间展示（价格/事件分区，不随页面实时走） ---------- */
  function priceStamp() {
    // 【1 分钟实时价】按当前金属的实时报价时刻；从未取到现货时才回退真源生成时间。
    // 抓取失败不清除 spotState.quotes，故不会因一次网络抖动把时间倒退回 15 分钟前（不闪烁）。
    var live = state.data ? livePricesFor(state.metal, state.data) : null;
    return (live && live.ts) || (state.meta && state.meta.generatedAt) || (state.data && state.data.lastUpdate) || "";
  }
  function curveStamp() {
    return (state.meta && state.meta.generatedAt) || (state.data && state.data.lastUpdate) || "";
  }
  function eventsStamp() {
    return (state.eventsMeta && state.eventsMeta.updatedAt) || "";
  }
  // 有没有拿到实时现货：决定频率文案能否标「60 秒」。
  // 拿不到时如实写「真源 15 分钟」，绝不假标（用户截图里 18:15 卡住却写「1 分钟」就是这么来的）。
  function spotAvailable() {
    return !!(state.data && livePricesFor(state.metal, state.data));
  }
  function renderUpdateTimes() {
    if (!state.data) return; // 首屏数据未到时不渲染时间，避免空时间戳闪一帧（与小程序同口径）
    var p = priceStamp(), c = curveStamp(), e = eventsStamp();
    var hasLive = spotAvailable();
    var ps = fmtLocalSec(p), cs = fmtLocalSec(c), es = fmtLocalSec(e);
    // 【2026-11-07 修复·进入时文案跳变】与小程序 renderTimes 同一四态口径，勿单边改：
    //   ① 有实时报价 → 实时每分；② 本会话已明确降级 → 真源每15分（如实，不假标 60 秒）；
    //   ③ 冷启动未定论 + 上次成功 → 沿用「实时每分」，首帧即最终态，零跳变；
    //   ④ 冷启动未定论 + 从未成功 → 中性「校验最新价…」，不误导为没有实时价。
    var cadence = hasLive ? "实时每分"
      : (spotCadence.settled && spotCadence.wasOk === false) ? "真源每15分"
      : spotCadence.lastOk ? "实时每分"
      : "校验最新价…";
    // 【2026-11-06 反馈③+：时间收敛到筛选区行末一处】折线图下 / 最新价卡内的时间均移除，
    //   价格更新时间统一在筛选区行末右对齐（到分钟），与小程序口径一致；真源节奏如实标注。
    var pe = document.getElementById("priceUpdate");
    if (pe) {
      // 【2026-11-06 修复·单位折行】窄屏单位行空间有限，日期去掉年份（"2026-11-04"→"11-04"），
      // 省约 30px 让 375px 一行完整显示而不被 ellipsis 截断；完整时间在 title 悬停可见。
      // 口径与小程序 renderTimes 保持一致，勿单边改。
      pe.textContent = "更新 " + fmtLocal(p).replace(/^\d{4}-/, "") + " · " + cadence;
      pe.title = "最新价：直连 gold-api.com 实时现货，每 60 秒刷新（" + ps + "）\n" +
        "历史曲线与校验：每 15 分钟由真源发布（" + cs + "）\n" +
        "重大事件：约每 1 小时（" + es + "）\n" +
        "国内市场：按最近一次真实内外盘比价随国际现货联动（联动价）";
    }
    var ee = document.getElementById("eventsUpdate");
    if (ee) {
      if (state.eventsMeta) {
        // 事件时间独立成区（事件数据集自有更新时刻），标签从「事件更新于」精简为「事件」，
        // 与上方唯一的「更新」时间明确区分，不再三者看起来像同一更新。
        ee.textContent = "事件 " + fmtLocal(state.eventsMeta.updatedAt);
        var stale = (state.eventsMeta.sources || []).filter(function (s) { return s.stale; });
        ee.title = (stale.length
          ? "以下来源已停更，其旧条目不再入库：" + stale.map(function (s) { return s.name + "（" + Math.round(s.ageDays) + " 天前）"; }).join("、")
          : "全部来源均在 7 天内有更新") +
          (state.eventsMeta.latestEventDate ? " ｜ 最新事件 " + state.eventsMeta.latestEventDate : "");
      } else {
        ee.textContent = "";
      }
    }
  }

  /* ---------- 主动更新：定时检查数据新版本，不依赖用户刷新/重进 ---------- */
  // C19：数据改为「平台生成器每 15 分钟生成 → 直推 GH Pages 镜像」，手机网页/已发布小程序
  // 读镜像、桌面端读平台，镜像落地比生成晚约 1~2 分钟 → 轮询周期收紧到 3 分钟，尽快追上。
  var AUTO_REFRESH_MS = 3 * 60 * 1000; // 真源（曲线/事件）3 分钟一检
  var checking = false; // 防重入：轮询与 visibilitychange 可能并发
  function startAutoRefresh() {
    // 两条独立节拍，互不干扰：
    //   · 最新价：60 秒直连实时现货（不依赖真源 15 分钟生成）
    //   · 真源 meta / events：3 分钟检查新版本（覆盖「15 分钟生成 + 镜像落地」链路）
    refreshSpot(true);
    setInterval(function () { refreshSpot(false); }, SPOT_REFRESH_MS);
    setInterval(checkDataUpdate, AUTO_REFRESH_MS);
    // 页面从后台/其它标签回来时立即检查一次（配合轮询，回来即是新的）
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) { checkDataUpdate(); refreshSpot(false); }
    });
  }
  async function checkDataUpdate() {
    if (checking || !state.meta) return;
    checking = true;
    try {
      var res = await Promise.all([
        // 【C32·三端统一】GH Pages 镜像优先，平台 /api 兜底（与手机网页/小程序同源同字节）
        loadFirst([canon(CANON + "data/meta.json"), "/api/meta" + shareQ(), jsd(JSD + "data/meta.json"), "data/meta.json"]),
        loadFirst([canon(CANON + "data/events.meta.json"), "/api/events-meta" + shareQ(), jsd(JSD + "data/events.meta.json"), "data/events.meta.json"]).catch(function () { return null; }),
      ]);
      var meta = res[0], evMeta = res[1];
      var priceChanged = !!(meta && meta.generatedAt && (!state.meta || meta.generatedAt !== state.meta.generatedAt));
      var eventsChanged = !!(evMeta && evMeta.updatedAt && (!state.eventsMeta || evMeta.updatedAt !== state.eventsMeta.updatedAt));
      if (priceChanged) {
        state.meta = meta;
        // 【2026-11-06 修正】三个金属的缓存一起作废：旧逻辑只清当前品种，
        // 轮询发现新版本后切到其它品种仍会命中旧数据，与「三端同源同版本」口径矛盾。
        cache = {};
        bootData = null;
        lastWrittenStamp = "";
        state.data = await ensureMetal(state.metal);
        prefetchMetals();
        corrCache = {};           // 数据源更换，相关性缓存作废
        syncGranAvailability();    // 铜无小时线时禁用「时」选项
        computeAndRenderStats(); // 用新真源锚点 + 现有实时现货重算四卡
        safeRenderChart();
      }
      if (eventsChanged) {
        state.eventsMeta = evMeta;
        state.events = await loadFirst([canon(CANON + "data/events.json"), "/api/events" + shareQ(), jsd(JSD + "data/events.json"), "data/events.json"]);
        state.eventPage = 1;
        renderEvents();
      }
      if (priceChanged || eventsChanged) renderUpdateTimes();
    } catch (e) { /* 静默失败：下一轮再试，不影响当前渲染 */ }
    finally { checking = false; }
  }

  /* ---------- 切换金属 ---------- */
  function switchMetal(metal, first) {
    state.metal = metal;
    state.priceSpotAt = null; // 现货时间按品种重置，避免串显示
    syncUnitToggle(); // 铜不开放「元/克」，且需重置视图
    // bundle 命中后 cache 已就绪 → 直接用；否则按原逻辑拉取该金属
    if (cache[metal]) { applyMetalData(cache[metal]); }
    else { ensureMetal(metal).then(applyMetalData); }
  }

  // 单位切换控件：铜隐藏；金/银显示，并按 state.gram 高亮
  function syncUnitToggle() {
    var box = document.getElementById("unitToggle");
    if (state.metal === "copper") {
      box.style.display = "none";
      state.gram = false;
    } else {
      box.style.display = "";
    }
    [].forEach.call(box.querySelectorAll(".chip"), function (t) {
      t.classList.toggle("active", (t.dataset.unit === "gram") === !!state.gram);
    });
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    document.getElementById("metalTabs").addEventListener("click", function (e) {
      var btn = e.target.closest(".tab"); if (!btn) return;
      [].forEach.call(this.querySelectorAll(".tab"), function (t) { t.classList.remove("active"); });
      btn.classList.add("active");
      switchMetal(btn.dataset.metal);
    });

    document.querySelector(".markets").addEventListener("click", function (e) {
      var btn = e.target.closest(".chip"); if (!btn) return;
      var m = btn.dataset.market;
      state.markets[m] = !state.markets[m];
      btn.classList.toggle("active", state.markets[m]);
      if (state.data) { computeAndRenderStats(); safeRenderChart(); }
    });

    document.querySelector(".granularity").addEventListener("click", function (e) {
      var btn = e.target.closest(".chip"); if (!btn) return;
      if (btn.classList.contains("disabled")) return; // 无小时线时禁止切换到「时」
      [].forEach.call(this.querySelectorAll(".chip"), function (t) { t.classList.remove("active"); });
      btn.classList.add("active");
      state.gran = btn.dataset.gran;
      if (state.data) safeRenderChart();
    });

    document.getElementById("unitToggle").addEventListener("click", function (e) {
      var btn = e.target.closest(".chip"); if (!btn) return;
      state.gram = (btn.dataset.unit === "gram");
      [].forEach.call(this.querySelectorAll(".chip"), function (t) { t.classList.remove("active"); });
      btn.classList.add("active");
      if (state.data) { computeAndRenderStats(); safeRenderChart(); }
    });

    document.getElementById("eventFilter").addEventListener("click", function (e) {
      var btn = e.target.closest(".chip"); if (!btn) return;
      [].forEach.call(this.querySelectorAll(".chip"), function (t) { t.classList.remove("active"); });
      btn.classList.add("active");
      state.eventCat = btn.dataset.cat;
      state.eventPage = 1;
      renderEvents();
      scrollToEvents();
    });

    document.getElementById("pager").addEventListener("click", function (e) {
      var btn = e.target.closest("button"); if (!btn || btn.disabled) return;
      var pg = btn.dataset.pg;
      if (pg === "prev") state.eventPage--;
      else if (pg === "next") state.eventPage++;
      else state.eventPage = parseInt(pg, 10);
      renderEvents();
      scrollToEvents();
    });

    // 相关性指数计算方法已移至页面底部说明（三端统一），此处无绑定

    // PC 全屏：原生 Fullscreen API（移动端由「横屏放大」承担）
    var fsBtn = document.getElementById("fsBtn");
    if (fsBtn) fsBtn.addEventListener("click", function () {
      var w = document.getElementById("chartWrap");
      if (!document.fullscreenElement) {
        if (w.requestFullscreen) w.requestFullscreen();
      } else if (document.exitFullscreen) {
        document.exitFullscreen();
      }
      setTimeout(function () { if (state.data) safeRenderChart(); }, 200);
    });

    var lsBtn = document.getElementById("landscapeBtn");
    if (lsBtn) lsBtn.addEventListener("click", function () { enterLandscape(); });
    var exBtn = document.getElementById("exitLandscape");
    if (exBtn) exBtn.addEventListener("click", function (e) { e.stopPropagation(); exitLandscape(); });
    // 旋转/回正：按视口实际方向在「原生宽图 ↔ 旋转兜底」间自动切换（横放手机即得原生宽图）；
    // 方向未变（如工具栏显隐引起的 resize）不重排。Esc 正常收尾。
    var onOrient = function () {
      if (!lsActive) return;
      var portrait = window.innerWidth < window.innerHeight;
      if (portrait === lsPortrait) return;
      setTimeout(applyLandscapeMode, 250);
    };
    window.addEventListener("orientationchange", onOrient);
    window.addEventListener("resize", onOrient);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && lsActive) exitLandscape(); });
  }

  /* ---------- 移动端横屏查看 ---------- */
  var lsActive = false;
  var lsPortrait = null;   // 横屏模式下当前视口是否竖屏（决定是否走旋转兜底）

  // 按视口实际方向决定呈现方式：
  // 横屏（Android 已锁方向 / 用户把手机横放）→ 原生宽图；
  // 竖屏（iOS/微信锁不了方向）→ 整图旋转 90° 兜底：时间轴沿屏幕长边展开（横轴长、纵轴短）
  function applyLandscapeMode() {
    var w = document.getElementById("chartWrap");
    var st = document.getElementById("lsStage");
    if (!w || !st || !lsActive) return;
    var portrait = window.innerWidth < window.innerHeight;
    lsPortrait = portrait;
    if (portrait) {
      // 舞台 = 屏高 × 屏宽（横屏比例），由 CSS 整体向右旋转 90°。
      // 旋转对象是 #lsStage（全屏元素的子级）而非 #chartWrap 本身：
      // 全屏元素会被 UA 样式表以 !important 钉死为「铺满 + transform:none」，旋转它无效。
      w.classList.add("rotate-fallback");
      st.style.width = window.innerHeight + "px";
      st.style.height = window.innerWidth + "px";
    } else {
      w.classList.remove("rotate-fallback");
      st.style.width = "";
      st.style.height = "";
    }
    safeRenderChart(true);
    if (chart) chart.resize();
    setTimeout(function () { if (chart) chart.resize(); }, 50);
    setTimeout(function () { if (chart) chart.resize(); }, 300);
  }

  async function enterLandscape() {
    var w = document.getElementById("chartWrap");
    if (!w) return;
    lsActive = true;
    // 先尝试进入全屏（部分浏览器要求全屏后才能锁定方向）
    try {
      if (w.requestFullscreen) await w.requestFullscreen();
      else if (w.webkitRequestFullscreen) await w.webkitRequestFullscreen();
    } catch (e) {}
    // Android：锁定横屏，设备 UI 随之旋转、视口变宽 → 原生宽图
    // iOS/微信：lock 必然失败 → 维持竖屏，由 applyLandscapeMode 走旋转兜底
    try {
      if (screen.orientation && screen.orientation.lock) await screen.orientation.lock("landscape");
    } catch (e) {}
    w.classList.add("landscape");
    document.body.style.overflow = "hidden";
    applyLandscapeMode();
  }
  function exitLandscape() {
    var w = document.getElementById("chartWrap");
    var st = document.getElementById("lsStage");
    if (!w) return;
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
    if (document.fullscreenElement) {
      try { if (document.exitFullscreen) document.exitFullscreen(); else if (document.webkitExitFullscreen) document.webkitExitFullscreen(); } catch (e) {}
    }
    w.classList.remove("landscape", "rotate-fallback");
    if (st) { st.style.width = ""; st.style.height = ""; }
    document.body.style.overflow = "";
    lsActive = false;
    lsPortrait = null;
    safeRenderChart(true);
    setTimeout(function () { if (chart) chart.resize(); }, 200);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
