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
  var PAGE_SIZE = 20; // 三端统一：每页 20 条（原 8 条导致页码按钮过多、窄屏折行）
  var chart = null;
  var cache = {};

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
    if (state.gran === "day") return pad(d.getMonth() + 1) + "/" + pad(d.getDate());
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
  // 微信/分享链接携带的 sharecode：网关用它对请求做鉴权；把它拼到所有 /api 请求上，
  // 这样即便浏览器/微信 WebView 没有持久化网关的 __wb_rsc Cookie，也能通过分享码拿到数据。
  function shareQ() {
    var s = location.search || "";
    return s.indexOf("sharecode=") >= 0 ? s : "";
  }
  // 【C18 真源定调】平台版（metal-price-monitor.app.workbuddy.host）= 唯一真源生成器，
  // 由 Node 服务每 15 分钟本地生成 data/*.json（不再依赖 GitHub Actions 定时器的易失效定时），
  // 并对外 serve /api/*（CORS *）。三端统一读本服务的 /api/：
  //   · PC 网页          → 同源 /api/（API_BASE 为空）
  //   · 手机网页(GH Pages)→ 浏览器跨域读平台 /api/（API_BASE 为绝对地址 + sharecode；CORS *）
  //   · 微信小程序       → 云函数 → 平台 /api/bundle（微信 UA 被网关拦，故走云函数）
  // GitHub Pages 仅作兜底壳（其仍由 Actions 不定期刷新）。
  var PLATFORM_HOST = "https://metal-price-monitor.app.workbuddy.host";
  var SHARE = "POOW32T4LI";                 // 平台网关鉴权用 sharecode（与云函数同款，可嵌入前端）
  var STATIC = !!window.__STATIC__;          // 手机网页静态壳 = 1；PC 平台版 = undefined
  // 平台 API 基址：PC 同源（相对）｜手机跨域（绝对 + sharecode）
  function apiUrl(p) {
    if (!STATIC) return p;                   // PC：同源相对路径即可
    return PLATFORM_HOST + p + (p.indexOf("?") >= 0 ? "&" : "?") + "sharecode=" + SHARE;
  }
  var CANON = "https://zsyong2026.github.io/metal-price-monitor/"; // 兜底：GitHub Pages 真源壳
  function canon(u) { return u + (u.indexOf("?") >= 0 ? "&" : "?") + "_ts=" + Date.now(); }
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

  /* ---------- 数据加载 ---------- */
  function loadJSON(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("加载失败: " + url);
      return r.json();
    });
  }
  // 依次尝试多个地址，命中可用即返回（平台 /api 优先，GH Pages / 本地静态兜底）
  // C18：手机网页静态壳也优先读平台 /api/（apiUrl 已转绝对地址 + sharecode，CORS * 跨域可达），
  // GitHub Pages 作兜底；GH Pages 边缘缓存约 10 分钟，对兜底 data/ 请求加 _ts 穿透。
  // 平台 /api/ 自身 Cache-Control: no-store，无需 _ts。
  function bust(u) {
    if (u.indexOf("/api/") >= 0) return u;   // 平台 /api/ 已 no-store，不重复穿透
    if (!STATIC) return u;
    if (u.indexOf("_ts=") >= 0) return u;     // 已是真源穿透 URL
    return u + (u.indexOf("?") >= 0 ? "&" : "?") + "_ts=" + Date.now();
  }
  function loadFirst(urls) {
    // 把相对 /api/ 翻成平台绝对地址（手机静态壳跨域；PC 同源不动），其余地址原样
    var list = urls.map(function (u) {
      return u.indexOf("/api/") === 0 ? apiUrl(u) : u;
    });
    return (async function () {
      var lastErr;
      for (var i = 0; i < list.length; i++) {
        try {
          var r = await fetch(bust(list[i]), { cache: "no-store" });
          if (r.ok) return await r.json();
        } catch (e) { lastErr = e; }
      }
      throw new Error("加载失败: " + list.join(" | "));
    })();
  }

  function ensureMetal(metal) {
    if (cache[metal]) return Promise.resolve(cache[metal]);
    // 平台版：同源 /api/ 优先（= 真源字节，国内 0.6s，无跨域）→ GH Pages canon 兜底 → 本地静态
    // 静态版：__STATIC__ 时 loadFirst 会自动剔除 /api/，只剩 canon + 本地静态
    return loadFirst(["/api/data/" + metal + shareQ(), canon(CANON + "data/" + metal + ".json"), "data/" + metal + ".json"]).then(function (d) {
      cache[metal] = d;
      return d;
    });
  }

  function init() {
    parseHash();
    Promise.all([
      loadFirst(["/api/meta" + shareQ(), canon(CANON + "data/meta.json"), "data/meta.json"]),
      loadFirst(["/api/events" + shareQ(), canon(CANON + "data/events.json"), "data/events.json"]),
      // 事件独立元信息：老版本接口/文件缺失时容忍 null（更新时间回退为价格时间）
      loadFirst(["/api/events-meta" + shareQ(), canon(CANON + "data/events.meta.json"), "data/events.meta.json"]).catch(function () { return null; }),
    ])
      .then(function (res) {
        state.meta = res[0];
        state.events = res[1];
        state.eventsMeta = res[2];
        document.getElementById("disclaimer").innerHTML = state.meta.disclaimer +
          " <br><span style='color:var(--ink-soft)'>更新策略：" +
          state.meta.updatePolicy.hourly + " ｜ " + state.meta.updatePolicy.daily + " ｜ " + state.meta.updatePolicy.history + "</span>";
        if (state.meta.dataMode === "real") {
          var b = document.getElementById("dataModeBadge");
          b.textContent = "真实数据"; b.className = "badge badge-ok";
        } else if (state.meta.dataMode === "spot") {
          var b2 = document.getElementById("dataModeBadge");
          b2.textContent = "真实现货"; b2.className = "badge badge-ok";
          b2.title = "最新价为真实现货（每15分钟例行抓取），历史曲线为锚定建模趋势";
        } else {
          // 非 real/spot（静态托管或建模兜底）：与小程序第三态口径统一，不显示「建模数据」这种
          // 自我否定的措辞（C08 反馈），改称「缓存数据」并保留说明 tooltip
          var b3 = document.getElementById("dataModeBadge");
          b3.textContent = "缓存数据";
          b3.title = "展示最近一次成功生成的数据快照（实时行情获取失败时自动进入该模式）";
        }
        initChart();
        bindEvents();
        syncUIFromState();
        switchMetal(state.metal, true);
        startAutoRefresh(); // 主动更新：定时检查数据新版本，用户无感知刷新各区域
      })
      .catch(function (e) { alert("初始化失败：" + e.message); });
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
  function renderChart() {
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
    active.forEach(function (m) { aggSrc[m] = aggregate(info.src[m] || [], state.gran); });
    function marketSeries(m, yAxisIndex) {
      var pts = convertPts(aggSrc[m] || [], m, fx);
      var g = splitGaps(pts, state.gran);
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
      gridRight = 18;
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
      gridRight = (active.length - 1) * 60 + 24;
    }

    var zoom = computeZoom((aggSrc[active[0]] || aggSrc.london || []).length);
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
        axisPointer: {
          type: "cross",
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
            var mk = MARKET_BY_CN[p.seriesName];
            var u = gram ? "元/克" : ((d.unit && d.unit[mk]) || "");
            html += "<div style='display:flex;justify-content:space-between;gap:14px'>" +
              "<span>" + p.marker + p.seriesName + "</span>" +
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
        splitNumber: maxXLabels,
        axisLabel: {
          color: tc.text, hideOverlap: true, fontSize: axisFs,
          // time 轴的 hideOverlap 不生效：按当前缩放窗口与绘图区宽度算最小标签间距，不足则隐藏
          formatter: function (v, idx) {
            if (idx === 0) lsLastShown = -Infinity; // 每批标签从锚点重新起算，缩放后自纠错
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
          borderColor: tc.line, fillerColor: "rgba(212,160,23,.15)",
          handleStyle: { color: "#d4a017" }, textStyle: { color: tc.text, fontSize: 9 },
        },
      ],
      animation: false,
    };
    // 记录全量数据跨度，供横轴标签间距过滤换算缩放窗口使用
    var pts0 = aggSrc[active[0]] || aggSrc.london || [];
    if (pts0.length >= 2) lsXRange = [pts0[0][0], pts0[pts0.length - 1][0]];
    chart.setOption(option, true);
    document.getElementById("chartLoading").style.display = "none";
  }

  /* ---------- 统计卡片 ---------- */
  function computeAndRenderStats() {
    var d = state.data;
    var fx = fxOf(d);
    var primary = MARKET_ORDER.filter(function (m) { return state.markets[m]; })[0] || "london";
    var raw = d.series[primary] || [];
    var pts = convertPts(raw, primary, fx);
    var box = document.getElementById("stats");
    if (pts.length < 2) { box.innerHTML = ""; return; }
    var latest = pts[pts.length - 1][1];
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
    var unit = useGram() ? "元/克" : d.unit[primary];

    function cls(p) { return p >= 0 ? "up" : "down"; }
    box.innerHTML =
      card("最新价（" + MARKET_CN[primary] + "）", fmtNum(latest) + " <span style='font-size:12px;color:var(--ink-soft)'>" + unit + "</span>") +
      card("最新日涨跌", fmtNum(latest - prev), cls(todayPct), fmtPct(todayPct)) +
      card("近一年涨跌", "", cls(yearPct), fmtPct(yearPct)) +
      card("历史区间 (" + unit + ")", "<span class='up'>" + fmtNum(hi) + "</span> / <span class='down'>" + fmtNum(lo) + "</span>");
  }
  function card(k, v, subCls, sub) {
    var s = sub != null ? "<div class='sub " + (subCls || "") + "'>" + sub + "</div>" : "";
    return "<div class='stat-card'><div class='k'>" + k + "</div><div class='v " + (subCls || "") + "'>" + v + "</div>" + s + "</div>";
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
    var total = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (state.eventPage > total) state.eventPage = total;
    var startIdx = (state.eventPage - 1) * PAGE_SIZE;
    var pageItems = list.slice(startIdx, startIdx + PAGE_SIZE);

    var ul = document.getElementById("eventList");
    ul.innerHTML = pageItems.map(function (e) {
      var impCls = e.impact === "up" ? "impact-up" : e.impact === "down" ? "impact-down" : "impact-mixed";
      var impTxt = e.impact === "up" ? "利多" : e.impact === "down" ? "利空" : "中性";
      var href = e.url ? String(e.url).replace(/&/g, "&amp;").replace(/"/g, "&quot;") : "";
      // 标签与小程序端统一：滤掉方向性废话（走强/走弱，多空导向胶囊已表达），最多 6 个
      var tagsHtml = (e.tags || []).filter(function (t) { return t !== "走强" && t !== "走弱"; }).slice(0, 6)
        .map(function (t) { return "<span class='ei-tag'>" + esc(t) + "</span>"; }).join("");
      var origHtml = href
        ? "<a class='ei-link' href='" + href + "' target='_blank' rel='noopener' title='" + esc(e.origTitle || "") + "'>查看原文 ↗</a>"
        : "";
      // 信息层级（三端统一）：标题 → 元信息行（日期/分类/导向/相关性）→ 标签 → 摘要 → 依据 → 来源
      return "<li class='event-item'>" +
        "<div class='ei-title'>" + esc(e.title) + "</div>" +
        "<div class='ei-top'>" +
        "<span class='ei-date'>" + e.date + "</span>" +
        "<span class='ei-cat'>" + e.category + "</span>" +
        "<span class='ei-impact " + impCls + "'>" + impTxt + "</span>" +
        corrBadge(e) +
        "</div>" +
        (tagsHtml ? "<div class='ei-tags'>" + tagsHtml + "</div>" : "") +
        "<div class='ei-summary'>" + esc(String(e.summary || "").replace(/^【[^】]{1,12}】\s*/, "")) + "</div>" +
        corrBasis(e) +
        "<div class='ei-source'>来源：" + esc(e.source) + (e.auto ? " ｜ AI 归纳" : "") + origHtml + "</div>" +
        "</li>";
    }).join("");

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

  /* ---------- 实时现货（C18 已停用）----------
     历史版本在页面打开时由浏览器直连 gold-api.com 把末端价格刷成「实时价」，并据此把顶部
     「更新时间」覆写成现货时间。这导致：① 三端时间戳不一致（PC/手机显示现货时间、小程序显示
     生成时间）；② 顶部时间从「数据生成时间」一闪而过变成「现货时间」（用户反馈 09:14→10:02）。
     C18 统一原则：三端数据严格同源（平台每 15 分钟生成的那一版），顶部「更新时间」恒等于
     数据生成时间，不再叠加实时现货，彻底消除闪烁与多端不一致。故本函数停用。 */
  async function refreshLiveSpot() { /* C18 停用：数据统一为平台 15 分钟生成版，不再叠实时现货 */ }

  /* ---------- 更新时间：按数据真实入库时间展示（价格/事件分区，不随页面实时走） ---------- */
  function priceStamp() {
    // C18：顶部「更新时间」恒等于数据生成时间（meta.generatedAt），三端一致，不再叠加实时现货
    return (state.meta && state.meta.generatedAt) || (state.data && state.data.lastUpdate) || "";
  }
  function eventsStamp() {
    return (state.eventsMeta && state.eventsMeta.updatedAt) || "";
  }
  function renderUpdateTimes() {
    var p = priceStamp(), e = eventsStamp();
    // 右上角：价格与事件中较新的真实入库时间（ISO 同格式可字典序比较）
    var newest = e > p ? e : p;
    var el = document.getElementById("lastUpdate");
    if (el) {
      el.textContent = fmtLocal(newest);
      el.title = "价格更新于 " + fmtLocal(p) + "\n事件更新于 " + fmtLocal(e);
    }
    var pe = document.getElementById("priceUpdate");
    if (pe) {
      // 文案精简：只展示更新时间（数据截至日期看图表示末刻度，不在文案重复）
      pe.textContent = "价格更新于 " + fmtLocal(p);
      pe.title = "价格数据截至 " + (state.data && state.data.lastUpdate ? String(state.data.lastUpdate).slice(0, 10) : "—");
    }
    var ee = document.getElementById("eventsUpdate");
    if (ee) {
      if (state.eventsMeta) {
        ee.textContent = "事件更新于 " + fmtLocal(state.eventsMeta.updatedAt);
        // 源健康度：停更超过 7 天的源其条目不再入库，tooltip 说明（如 WSJ 两源实测停更 638 天）
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
  var AUTO_REFRESH_MS = 5 * 60 * 1000; // 5 分钟一检（抓取 15 分钟一轮，提前 1/3 周期）
  var checking = false; // 防重入：轮询与 visibilitychange 可能并发
  function startAutoRefresh() {
    setInterval(checkDataUpdate, AUTO_REFRESH_MS);
    // 页面从后台/其它标签回来时立即检查一次（配合轮询，回来即是新的）
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) checkDataUpdate();
    });
  }
  async function checkDataUpdate() {
    if (checking || !state.meta) return;
    checking = true;
    try {
      var res = await Promise.all([
        loadFirst(["/api/meta" + shareQ(), canon(CANON + "data/meta.json"), "data/meta.json"]),
        loadFirst(["/api/events-meta" + shareQ(), canon(CANON + "data/events.meta.json"), "data/events.meta.json"]).catch(function () { return null; }),
      ]);
      var meta = res[0], evMeta = res[1];
      var priceChanged = !!(meta && meta.generatedAt && (!state.meta || meta.generatedAt !== state.meta.generatedAt));
      var eventsChanged = !!(evMeta && evMeta.updatedAt && (!state.eventsMeta || evMeta.updatedAt !== state.eventsMeta.updatedAt));
      if (priceChanged) {
        state.meta = meta;
        cache[state.metal] = null; // 丢弃旧缓存，重取新版本
        state.data = await ensureMetal(state.metal);
        corrCache = {};           // 数据源更换，相关性缓存作废
        syncGranAvailability();    // 铜无小时线时禁用「时」选项
        renderChart();
        computeAndRenderStats();
        refreshLiveSpot();        // C18 已停用（不再叠实时现货，避免顶部时间闪烁）
      }
      if (eventsChanged) {
        state.eventsMeta = evMeta;
        state.events = await loadFirst(["/api/events" + shareQ(), canon(CANON + "data/events.json"), "data/events.json"]);
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
    ensureMetal(metal).then(function (d) {
      state.data = d;
      corrCache = {}; // 数据源更换，相关性缓存作废
      renderUpdateTimes();
      state.eventPage = 1;
      syncGranAvailability(); // 铜无小时线时禁用「时」选项
      renderChart();
      computeAndRenderStats();
      renderEvents();
      refreshLiveSpot();
    });
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
      if (state.data) { renderChart(); computeAndRenderStats(); }
    });

    document.querySelector(".granularity").addEventListener("click", function (e) {
      var btn = e.target.closest(".chip"); if (!btn) return;
      if (btn.classList.contains("disabled")) return; // 无小时线时禁止切换到「时」
      [].forEach.call(this.querySelectorAll(".chip"), function (t) { t.classList.remove("active"); });
      btn.classList.add("active");
      state.gran = btn.dataset.gran;
      if (state.data) renderChart();
    });

    document.getElementById("unitToggle").addEventListener("click", function (e) {
      var btn = e.target.closest(".chip"); if (!btn) return;
      state.gram = (btn.dataset.unit === "gram");
      [].forEach.call(this.querySelectorAll(".chip"), function (t) { t.classList.remove("active"); });
      btn.classList.add("active");
      if (state.data) { renderChart(); computeAndRenderStats(); }
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
      setTimeout(function () { if (state.data) renderChart(); }, 200);
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
    renderChart();
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
    renderChart();
    setTimeout(function () { if (chart) chart.resize(); }, 200);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
