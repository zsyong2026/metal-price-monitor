// generate.js —— 云端数据生成（Node，CommonJS）
// 与 scripts/build_data.py 同口径：锚定真实历史价位的建模数据；
// 若运行环境可联网，则优先抓取 Yahoo/stooq 真实价 + Frankfurter 汇率（dataMode=real）。
const fs = require("fs");
const path = require("path");
// 去重规范（收集 → 清洗 → 入库 唯一口径，三端共用同一份实现）
const ED = require(path.join(__dirname, "js", "event-dedupe.js"));

const DATA_DIR = path.join(__dirname, "data");
const OZ2G = 31.1034768;
const USDHKD = 7.8;

// 真实历史月度锚点（伦敦基准，USD）
const GOLD = {
  2021: [1845,1760,1730,1775,1820,1835,1805,1780,1750,1785,1810,1830],
  2022: [1815,1875,1935,1900,1840,1810,1735,1725,1675,1645,1740,1800],
  2023: [1860,1835,1900,1990,1960,1940,1960,1925,1875,1980,2010,2060],
  2024: [2030,2035,2160,2330,2350,2330,2390,2500,2580,2740,2650,2620],
  2025: [2680,2880,3050,3300,3250,3350,3400,3450,3500,3550,3600,3650],
  2026: [3500,3450,3400,3350,3300,3280,3250,3300,3350,3380],
};
const SILVER = {
  2021: [25.0,26.0,24.5,25.5,27.5,26.0,25.0,23.5,22.5,23.0,24.0,22.5],
  2022: [22.5,23.5,24.5,23.0,21.5,20.5,19.0,19.5,19.0,19.5,21.0,23.5],
  2023: [23.5,21.5,23.0,25.0,24.0,23.5,24.0,24.5,23.0,22.5,23.5,24.0],
  2024: [23.0,24.5,25.0,27.0,29.0,30.0,30.0,28.5,29.5,32.0,31.0,30.5],
  2025: [30.0,32.0,33.5,35.0,33.0,34.0,36.0,38.0,37.0,36.0,35.0,34.0],
  2026: [34.0,35.0,36.0,35.5,34.0,33.5,34.5,35.0,36.0,37.0],
};
const COPPER = {
  2021: [8000,8500,9000,9300,10000,9500,9500,9300,9300,9500,9600,9700],
  2022: [9800,10000,10300,9500,9400,8700,7600,7900,7700,7500,8000,8400],
  2023: [9100,8900,8900,8700,8200,8400,8600,8400,8200,8000,8400,8500],
  2024: [8500,8400,8900,9200,10100,9800,9300,9200,9500,9600,9200,9000],
  2025: [9000,9200,9800,9500,9800,9700,9600,9400,9700,10000,9500,9300],
  2026: [9300,9400,9500,9600,9700,9800,9900,10000,10100,10200],
};
const USDCNY = {
  2021: [6.45,6.45,6.50,6.50,6.40,6.40,6.45,6.45,6.45,6.40,6.40,6.35],
  2022: [6.35,6.35,6.35,6.40,6.70,6.70,6.75,6.80,7.00,7.10,7.15,6.95],
  2023: [6.90,6.85,6.90,6.90,7.05,7.15,7.15,7.30,7.30,7.30,7.20,7.15],
  2024: [7.15,7.20,7.25,7.25,7.25,7.30,7.25,7.20,7.10,7.10,7.20,7.30],
  2025: [7.30,7.25,7.30,7.30,7.25,7.20,7.20,7.15,7.10,7.10,7.15,7.20],
  2026: [7.20,7.20,7.25,7.20,7.15,7.10,7.10,7.05,7.00,6.67],
};

const VOL = { gold: 0.006, silver: 0.009, copper: 0.007 };
const WIGGLE = { gold: 0.022, silver: 0.030, copper: 0.025 };

const METALS = {
  gold: { name: "黄金", anchor: GOLD, unit: { london: "美元/盎司", domestic: "元/克", hongkong: "港元/盎司" } },
  silver: { name: "白银", anchor: SILVER, unit: { london: "美元/盎司", domestic: "元/克", hongkong: "港元/盎司" } },
  copper: { name: "铜", anchor: COPPER, unit: { london: "美元/吨", domestic: "元/吨", hongkong: "港元/吨" } },
};

// 可复现随机数
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function monthAnchors(map) {
  const pts = [];
  Object.keys(map).map(Number).sort((a, b) => a - b).forEach((y) => {
    map[y].forEach((v, i) => pts.push({ t: Date.UTC(y, i, 1), v: Number(v) }));
  });
  return pts;
}
function linInterp(pts, dt) {
  if (dt <= pts[0].t) return pts[0].v;
  if (dt >= pts[pts.length - 1].t) return pts[pts.length - 1].v;
  for (let i = 0; i < pts.length - 1; i++) {
    if (pts[i].t <= dt && dt < pts[i + 1].t) {
      const f = (dt - pts[i].t) / Math.max(pts[i + 1].t - pts[i].t, 1);
      return pts[i].v + (pts[i + 1].v - pts[i].v) * f;
    }
  }
  return pts[pts.length - 1].v;
}
function dailyNoise(n, sigma, clip, rng) {
  const rw = new Array(n).fill(0);
  for (let i = 1; i < n; i++) rw[i] = rw[i - 1] + (rng() * 2 - 1) * sigma;
  const out = new Array(n).fill(0);
  let seg = 30, i = 0;
  while (i < n) {
    const end = Math.min(i + seg, n);
    const s0 = rw[i], s1 = rw[end - 1], denom = Math.max(end - 1 - i, 1);
    for (let k = i; k < end; k++) {
      const f = (k - i) / denom;
      out[k] = rw[k] - (s0 + (s1 - s0) * f);
    }
    i = end;
  }
  return out.map((x) => Math.max(-clip, Math.min(clip, x)));
}
function genDaily(anchorMap, startMs, endMs, sigma, clip, rng) {
  const pts = monthAnchors(anchorMap);
  const usd = monthAnchors(USDCNY);
  const days = Math.round((endMs - startMs) / 86400000) + 1;
  const base = [];
  for (let d = 0; d < days; d++) base.push(linInterp(pts, startMs + d * 86400000));
  const noise = dailyNoise(days, sigma, clip, rng);
  const london = base.map((b, d) => b * (1 + noise[d]));
  const domestic = [], hongkong = [];
  for (let d = 0; d < days; d++) {
    const dt = startMs + d * 86400000;
    // 找最近月锚点汇率
    let fx = 7.1;
    for (let i = usd.length - 1; i >= 0; i--) { if (usd[i].t <= dt) { fx = usd[i].v; break; } }
    const lv = london[d];
    if (anchorMap === GOLD || anchorMap === SILVER) {
      const prem = (anchorMap === GOLD) ? (15 + 12 * Math.sin(d / 40)) : (0.6 + 0.5 * Math.sin(d / 35));
      domestic.push([startMs + d * 86400000, round2((lv + prem) / OZ2G * fx)]);
      hongkong.push([startMs + d * 86400000, round2(lv * USDHKD)]);
    } else {
      domestic.push([startMs + d * 86400000, round2(lv * fx * 1.13 + 500 + 300 * Math.sin(d / 50))]);
      hongkong.push([startMs + d * 86400000, round2(lv * USDHKD)]);
    }
  }
  return { london: london.map((v, d) => [startMs + d * 86400000, round2(v)]), domestic, hongkong };
}
// 交易时段（北京时间 09:00-15:30 → UTC 01:00-07:30）：非交易时段不产出点，
// 避免"夜间也在连续交易"的错觉（专业金融平台的小时图均只画交易时段）
const SESSION_HOURS = [1, 2, 3, 4, 5, 6, 7];
function genHourly(lastL, lastD, lastH, endMs, days, rng) {
  const outL = [], outD = [], outH = [];
  const sigma = 0.0015;
  // 三市场节假日不同（交易日数量不一致），必须按时间戳对齐：取并集逐日生成，
  // 同日共用一次随机游走以保持三市场联动；某市场当日休市则不产出该市场的点。
  const lMap = new Map(lastL.map((p) => [p[0], p[1]]));
  const dMap = new Map(lastD.map((p) => [p[0], p[1]]));
  const hMap = new Map(lastH.map((p) => [p[0], p[1]]));
  const daySet = new Set();
  for (const arr of [lastL, lastD, lastH]) {
    for (let i = Math.max(0, arr.length - days); i < arr.length; i++) daySet.add(arr[i][0]);
  }
  const allDays = Array.from(daySet).sort((a, b) => a - b);
  for (const dayMs of allDays) {
    const lv = lMap.get(dayMs), dv = dMap.get(dayMs), hv = hMap.get(dayMs);
    const rw = new Array(24).fill(0);
    for (let h = 1; h < 24; h++) rw[h] = rw[h - 1] + (rng() * 2 - 1) * sigma;
    const s0 = rw[SESSION_HOURS[0]], s1 = rw[SESSION_HOURS[SESSION_HOURS.length - 1]];
    for (let k = 0; k < SESSION_HOURS.length; k++) {
      const h = SESSION_HOURS[k];
      const f = k / (SESSION_HOURS.length - 1);
      const nz = rw[h] - (s0 + (s1 - s0) * f); // 日内去趋势，保证首尾贴住当日真实收盘
      const ts = dayMs + h * 3600000;
      if (ts > endMs) continue; // 不画"未来小时"
      if (lv != null) outL.push([ts, round2(lv * (1 + nz))]);
      if (dv != null) outD.push([ts, round2(dv * (1 + nz))]);
      if (hv != null) outH.push([ts, round2(hv * (1 + nz))]);
    }
  }
  return { london: outL, domestic: outD, hongkong: outH };
}
function round2(v) { return Math.round(v * 100) / 100; }

// ---------- 真实抓取（可选） ----------
async function fetchYahoo(symbol, interval, p1, p2) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&period1=${p1}&period2=${p2}`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error("yahoo " + r.status);
  const j = await r.json();
  const res = j.chart.result[0];
  const ts = res.timestamp, cl = res.indicators.quote[0].close;
  const out = [];
  for (let i = 0; i < ts.length; i++) if (cl[i] != null) out.push([ts[i] * 1000, round2(cl[i])]);
  return out;
}
async function fetchStooq(symbol, d1, d2) {
  const url = `https://stooq.com/q/d/l/?s=${symbol}&i=d&d1=${d1}&d2=${d2}`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const txt = await r.text();
  const out = [];
  txt.trim().split("\n").slice(1).forEach((line) => {
    const p = line.split(",");
    if (p.length < 2) return;
    const ms = Date.parse(p[0] + "T00:00:00Z");
    if (!isNaN(ms)) out.push([ms, round2(parseFloat(p[1]))]);
  });
  return out;
}
async function fetchFX(days) {
  const end = Date.now(), start = end - (days + 5) * 86400000;
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
  const url = `https://api.frankfurter.dev/v1/${fmt(start)}..${fmt(end)}?base=USD&symbols=CNY,HKD`;
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  const rates = {};
  for (const [d, v] of Object.entries(j)) rates[d] = [parseFloat(v.CNY || 7.1), parseFloat(v.HKD || USDHKD)];
  return rates;
}
function latestFx(rates) {
  const keys = Object.keys(rates || {}).sort();
  if (!keys.length) return null;
  const [c, h] = rates[keys[keys.length - 1]];
  return { usdcny: Math.round(c * 10000) / 10000, hkdcny: Math.round(c / (h || USDHKD) * 10000) / 10000 };
}

// ---------- 真实数据源（每日/每15分钟例行抓取） ----------
// 伦敦：新浪国际期货日K —— XAU/XAG 为 美元/盎司；HG 为 美分/磅（COMEX 铜连续）
// 国内：东方财富日K —— 黄金 AU9999（元/克）、白银 AGTD（元/千克）、沪铜主连 cum（元/吨）
// 小时：东方财富 60 分钟K（国内真实日内走势）
// 香港：由伦敦价 × 每日真实汇率（Frankfurter）折算
const SINA_SYM = { gold: "XAU", silver: "XAG", copper: "HG" };
const EM_SECID = { gold: "118.AU9999", silver: "118.AGTD", copper: "113.cum" };
const EM_SCALE = { gold: 1, silver: 0.001, copper: 1 }; // 折到序列单位（白银 元/千克 -> 元/克）
const WIN_START = Date.UTC(2021, 0, 1); // 图表窗口：近 5 年

async function fetchSinaDaily(sym) {
  const url = "https://stock.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=" + sym;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) });
  const txt = await r.text();
  const m = txt.match(/=\((\[[\s\S]*?\])\);/);
  if (!m) throw new Error("sina parse fail " + sym);
  const arr = JSON.parse(m[1]);
  const out = [];
  for (const k of arr) {
    const ms = Date.parse(k.date + "T00:00:00Z");
    const v = parseFloat(k.close);
    if (isFinite(ms) && isFinite(v) && v > 0) out.push([ms, v]);
  }
  if (out.length < 120) throw new Error("sina too few " + sym);
  return out;
}

async function fetchEMKline(secid, klt, lmt) {
  const url = "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=" + secid +
    "&fields1=f1,f2,f3&fields2=f51,f52,f53&klt=" + klt + "&fqt=1&end=20500101&lmt=" + lmt;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  if (!j || !j.data || !j.data.klines || !j.data.klines.length) throw new Error("em empty " + secid);
  const out = [];
  for (const k of j.data.klines) {
    const p = k.split(",");
    const t = p[0], v = parseFloat(p[2]);
    if (!isFinite(v) || v <= 0) continue;
    // 日K：按北京日期归一到 UTC 当日零点（与既有序列口径一致）；小时K：北京时间转 UTC
    const ms = t.length === 10
      ? Date.parse(t + "T00:00:00+08:00") + 28800000
      : Date.parse(t.replace(" ", "T") + ":00+08:00");
    if (isFinite(ms)) out.push([ms, v]);
  }
  if (out.length < 20) throw new Error("em too few " + secid);
  return out;
}

// 由国内真实收盘反推伦敦价（新浪不可用时的回退路径）
function impliedLondon(domesticVal, usdcny, metal) {
  if (metal === "copper") return (domesticVal - 500) / (usdcny * 1.13);
  return domesticVal * OZ2G / usdcny - (metal === "gold" ? 15 : 0.6);
}

// 抓取某金属的真实序列：伦敦（新浪）+ 国内（东财）+ 香港（汇率折算）
async function fetchRealSeries(metal, rates) {
  const [sina, emD] = await Promise.all([
    fetchSinaDaily(SINA_SYM[metal]).catch(() => null),
    fetchEMKline(EM_SECID[metal], 101, 1600).catch(() => null),
  ]);
  const emOk = !!(emD && emD.length >= 120);
  const sinaOk = !!sina;
  if (!emOk) return { ok: false, sinaOk, emOk }; // 国内真实数据是底线
  const sc = EM_SCALE[metal];
  const from = WIN_START - 40 * 86400000;
  const D = emD.filter((p) => p[0] >= from).map((p) => [p[0], round2(p[1] * sc)]);
  let L = null;
  if (sina) {
    L = sina.filter((p) => p[0] >= from).map((p) => [
      p[0],
      round2(metal === "copper" ? p[1] / 100 * LB2KG : p[1]), // HG 美分/磅 -> 美元/吨
    ]);
  } else {
    // 新浪不可用：由国内真实收盘 + 当日汇率反推伦敦
    L = D.map(([ms, dv]) => [ms, round2(impliedLondon(dv, fxFor(rates, ms)[0], metal))]);
  }
  const H = L.map(([ms, lv]) => [ms, round2(lv * (fxFor(rates, ms)[1] || USDHKD))]);
  return { ok: true, sinaOk, emOk, L, D, H, rates, fx: latestFx(rates) };
}

// 真实 60 分钟K（国内日内），失败返回 null
async function fetchHourlyReal(metal) {
  const bars = await fetchEMKline(EM_SECID[metal], 60, 400).catch(() => null);
  if (!bars || bars.length < 20) return null;
  const sc = EM_SCALE[metal];
  return bars.map((p) => [p[0], round2(p[1] * sc)]);
}

// 用真实 60 分钟K 覆盖生成的小时线尾部；伦敦/香港按「当日收盘价比率」联动，保证三市场同步
function buildHourlyFromReal(hRealD, D, L, rates) {
  if (!hRealD || hRealD.length < 20 || !D.length || !L.length) return null;
  const dMap = new Map(D.map((p) => [p[0], p[1]]));
  const lMap = new Map(L.map((p) => [p[0], p[1]]));
  const out = { london: [], domestic: [], hongkong: [] };
  let dropped = 0;
  for (const [ms, dv] of hRealD) {
    const dayMs = ms - (ms % 86400000);
    const dClose = dMap.get(dayMs), lClose = lMap.get(dayMs);
    if (!dClose || !lClose || dClose <= 0) continue;
    // 清洗：数据源偶发量纲异常bar（如沪铜主连 2026-09-23 夜盘出现约 111 倍脏数据），
    // 偏离当日收盘超过 60% 即剔除，避免污染小时线 Y 轴与统计
    if (Math.abs(dv / dClose - 1) > 0.6) { dropped++; continue; }
    const lv = lClose * (dv / dClose);
    out.domestic.push([ms, round2(dv)]);
    out.london.push([ms, round2(lv)]);
    out.hongkong.push([ms, round2(lv * (fxFor(rates, ms)[1] || USDHKD))]);
  }
  if (dropped) console.warn(`[hourly] 剔除量纲异常bar ${dropped} 根`);
  return out.london.length >= 20 ? out : null;
}

// 真实模式：把伦敦序列最后一根更新为实时现货（休市则追加"今"点，按 UTC 当日零点幂等）
function spliceSpotLast(arr, target) {
  if (!arr || !arr.length || target == null) return arr;
  const out = arr.slice();
  const last = out[out.length - 1];
  const todayUtc = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  if (todayUtc - last[0] <= 86400000) {
    out[out.length - 1] = [last[0], round2(target)];
  } else {
    out.push([todayUtc, round2(target)]);
  }
  return out;
}

// 抓取失败时读取磁盘上已有的真实数据，避免被建模数据覆盖（仅末端会更新为现货）
function loadExistingReal(metal) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(DATA_DIR, metal + ".json"), "utf-8"));
    if (p && p.dataMode === "real" && p.series && p.series.london && p.series.london.length > 200) {
      return {
        ok: true, sinaOk: true, emOk: true,
        L: p.series.london, D: p.series.domestic, H: p.series.hongkong,
        hL: p.hourly.london, hD: p.hourly.domestic, hH: p.hourly.hongkong,
        fx: p.fx, rates: null,
      };
    }
  } catch (e) {}
  return null;
}

// 平台沙箱抓不到新浪/东财时的备用通道：拉取 GitHub Pages 上 Actions 刚生成好的真实数据
const PAGES_BASE = "https://zsyong2026.github.io/metal-price-monitor";
async function fetchFromPages(metal) {
  try {
    const r = await fetch(PAGES_BASE + "/data/" + metal + ".json", { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || j.dataMode !== "real" || !j.series || !j.series.domestic || j.series.domestic.length < 200) return null;
    return {
      ok: true, sinaOk: true, emOk: true, fromPages: true,
      L: j.series.london, D: j.series.domestic, H: j.series.hongkong,
      hL: j.hourly.london, hD: j.hourly.domestic, hH: j.hourly.hongkong,
      fx: j.fx, rates: null,
    };
  } catch (e) { return null; }
}

// ---------- 数据校验（定时收集 → 校验 → 清洗 → 入库 → 发布的关卡） ----------
// 任何一条不通过：该品种本轮不发布，保留上一版已发布数据，原因记入 meta.sourceHealth.validation
const RANGE = {
  gold:   { london: [300, 30000], domestic: [80, 8000], hongkong: [2000, 250000] },
  silver: { london: [2, 2000],    domestic: [0.3, 2000], hongkong: [20, 16000] },
  copper: { london: [1500, 200000], domestic: [5000, 800000], hongkong: [12000, 1600000] },
};
// 单日跳变上限（防数据源出错；白银波动大，2026-01-30 真实崩盘 -26.8%，已双源核实）
const JUMP_MAX = { gold: 0.25, silver: 0.45, copper: 0.25 };
function validateSeries(metal, L, D, H, prevLast, spot) {
  const bad = (reason) => ({ ok: false, reason });
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const jumpMax = JUMP_MAX[metal] || 0.25;
  for (const [name, s] of [["伦敦", L], ["国内", D], ["香港", H]]) {
    if (!s || s.length < 800) return bad(name + "条数不足（" + (s ? s.length : 0) + "）");
    const rg = RANGE[metal][name === "伦敦" ? "london" : name === "国内" ? "domestic" : "hongkong"];
    let prevT = -Infinity, prevV = null;
    for (let i = 0; i < s.length; i++) {
      const p = s[i];
      if (!p || !(p[0] > prevT)) return bad(name + "时间戳非递增@" + i);
      if (!(p[1] > rg[0] && p[1] < rg[1])) return bad(name + "数值越界 " + p[1] + "@" + day(p[0]));
      if (prevV != null && Math.abs(p[1] / prevV - 1) > jumpMax) {
        return bad(name + "单日跳变 " + ((p[1] / prevV - 1) * 100).toFixed(1) + "%@" + day(p[0]));
      }
      if (i > 0 && p[0] - prevT > 12 * 86400000) return bad(name + "存在大段缺失@" + day(p[0]));
      prevT = p[0]; prevV = p[1];
    }
    if (Date.now() - s[s.length - 1][0] > 12 * 86400000) return bad(name + "末端数据陈旧（" + day(s[s.length - 1][0]) + "）");
  }
  // 交叉校验：伦敦日线末端 vs gold-api 真实现货（同一市场，应基本一致）
  if (spot) {
    const lv = L[L.length - 1][1];
    if (Math.abs(lv / spot - 1) > 0.08) return bad("伦敦末端与现货偏差 " + ((lv / spot - 1) * 100).toFixed(1) + "%");
  }
  // 与上一版已发布数据对比（防数据源整体漂移/串档）
  if (prevLast != null) {
    const dv = D[D.length - 1][1];
    if (Math.abs(dv / prevLast - 1) > 0.15) return bad("国内末端与上版偏差 " + ((dv / prevLast - 1) * 100).toFixed(1) + "%");
  }
  return { ok: true };
}
// 小时线校验门：条数/时间递增/数值范围/单步跳变（日内波动允许大于日线，脏数据仍可识别）
const HOURLY_JUMP_MAX = { gold: 0.12, silver: 0.25, copper: 0.12 };
function validateHourly(metal, hL, hD, hH) {
  const bad = (reason) => ({ ok: false, reason });
  const jumpMax = HOURLY_JUMP_MAX[metal] || 0.12;
  for (const [name, s] of [["伦敦", hL], ["国内", hD], ["香港", hH]]) {
    if (!s || s.length < 20) return bad(name + "小时线条数不足（" + (s ? s.length : 0) + "）");
    const rg = RANGE[metal][name === "伦敦" ? "london" : name === "国内" ? "domestic" : "hongkong"];
    let prevT = -Infinity, prevV = null;
    for (let i = 0; i < s.length; i++) {
      const p = s[i];
      if (!p || !(p[0] > prevT)) return bad(name + "小时线时间戳非递增@" + i);
      if (!(p[1] > rg[0] && p[1] < rg[1])) return bad(name + "小时线数值越界 " + p[1] + "@" + new Date(p[0]).toISOString().slice(0, 16));
      if (prevV != null && Math.abs(p[1] / prevV - 1) > jumpMax) {
        return bad(name + "小时线单步跳变 " + ((p[1] / prevV - 1) * 100).toFixed(1) + "%@" + new Date(p[0]).toISOString().slice(0, 16));
      }
      prevT = p[0]; prevV = p[1];
    }
  }
  return { ok: true };
}
function fxFor(rates, ms) {
  if (!rates || !Object.keys(rates).length) return [7.1, USDHKD];
  const d = new Date(ms).toISOString().slice(0, 10);
  if (rates[d]) return rates[d];
  // 缺失日期（周末/节假日）：取就近的「前一个」有报价的日期，避免把今天汇率套到历史
  const keys = Object.keys(rates).sort();
  let prev = null;
  for (const k of keys) { if (k <= d) prev = k; else break; }
  return prev ? rates[prev] : rates[keys[0]];
}

// ---------- 实时现货（gold-api.com，免费无需 key）----------
const LB2KG = 2204.62262; // 1 吨 = 2204.62262 磅（COMEX HG 报价为 美元/磅）
async function fetchFXLatest() {
  try {
    const r = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY,HKD");
    if (r.ok) {
      const j = await r.json();
      if (j.rates && j.rates.CNY) return { usdcny: j.rates.CNY, usdhkd: j.rates.HKD || USDHKD, source: "Frankfurter" };
    }
  } catch (e) {}
  const r2 = await fetch("https://open.er-api.com/v6/latest/USD");
  if (!r2.ok) throw new Error("fx latest fail");
  const j2 = await r2.json();
  if (!j2.rates || !j2.rates.CNY || !j2.rates.HKD) throw new Error("fx latest missing");
  return { usdcny: j2.rates.CNY, usdhkd: j2.rates.HKD, source: "open.er-api" };
}
async function fetchOne(sym) {
  const r = await fetch("https://api.gold-api.com/price/" + sym, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error("gold-api " + sym + " " + r.status);
  const j = await r.json();
  if (!j || !j.price) throw new Error("gold-api " + sym + " no price");
  return { price: Number(j.price), ts: j.updatedAt || new Date().toISOString() };
}
// 一次性抓齐：金/银/铜现货 + 美元汇率。任一品种失败则该品种为 null，全失败返回 null。
async function fetchSpotAll() {
  const [xau, xag, hg, fxC] = await Promise.all([
    fetchOne("XAU").catch(() => null),
    fetchOne("XAG").catch(() => null),
    fetchOne("HG").catch(() => null),
    fetchFXLatest().catch(() => null),
  ]);
  if (!xau && !xag && !hg) return null;
  return { xau, xag, hg, fx: fxC };
}
// 把序列末端 days 天线性收敛到 target（最新点=真实价）
function spliceTail(series, target, days) {
  if (!series || !series.length || target == null) return series;
  const endT = series[series.length - 1][0];
  const startT = endT - days * 86400000;
  let idx = series.findIndex((p) => p[0] >= startT);
  if (idx < 0) idx = 0;
  const n = series.length - idx;
  const out = series.slice();
  for (let i = 0; i < n; i++) {
    const f = n === 1 ? 1 : i / (n - 1);
    out[idx + i] = [out[idx + i][0], round2(out[idx + i][1] * (1 - f) + target * f)];
  }
  return out;
}
function convert(london, rates, metal) {
  return london.map(([ms, lv]) => {
    const [cny, hkd] = fxFor(rates, ms);
    if (metal === "gold" || metal === "silver") {
      const prem = metal === "gold" ? 15 : 0.6;
      return { l: [ms, lv], d: [ms, round2((lv + prem) / OZ2G * cny)], h: [ms, round2(lv * hkd)] };
    }
    return { l: [ms, lv], d: [ms, round2(lv * cny * 1.13 + 500)], h: [ms, round2(lv * hkd)] };
  });
}

async function tryReal(metal) {
  const now = Math.floor(Date.now() / 1000);
  const p1 = Math.floor(Date.UTC(2021, 0, 1) / 1000);
  const ySym = { gold: "GC=F", silver: "SI=F", copper: "HG=F" }[metal];
  const sSym = { gold: "xauusd", silver: "xagusd", copper: "copper" }[metal];
  let london = null;
  try { london = await fetchYahoo(ySym, "1d", p1, now); } catch (e) {}
  if (!london || !london.length) {
    try { london = await fetchStooq(sSym, "20210101", new Date().toISOString().slice(0, 10).replace(/-/g, "")); } catch (e) {}
  }
  if (!london || london.length < 100) return null; // 数据太少，回退建模
  const rates = await fetchFX(2200).catch(() => ({}));
  // 取最近汇率：fx.usdcny=1美元兑人民币；fx.hkdcny=1港元兑人民币（=USDCNY/USDHKD）
  const rateKeys = Object.keys(rates).sort();
  const lastRate = rateKeys.length ? rates[rateKeys[rateKeys.length - 1]] : [7.1, USDHKD];
  const fx = { usdcny: lastRate[0], hkdcny: Math.round(lastRate[0] / lastRate[1] * 10000) / 10000 };
  const conv = convert(london, rates, metal);
  const L = conv.map((x) => x.l), D = conv.map((x) => x.d), H = conv.map((x) => x.h);
  // 小时线
  let hL = [], hD = [], hH = [];
  try {
    const ph1 = now - 60 * 86400;
    const hr = await fetchYahoo(ySym, "1h", ph1, now);
    if (hr && hr.length) { const c = convert(hr, rates, metal); hL = c.map((x) => x.l); hD = c.map((x) => x.d); hH = c.map((x) => x.h); }
  } catch (e) {}
  return { L, D, H, hL, hD, hH, mode: "real", fx };
}

function writeJSON(name, obj) {
  fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(obj));
}

const SPOT_SYMBOL = { gold: "xau", silver: "xag", copper: "hg" };

async function generateAll(preSpot) {
  const startMs = Date.UTC(2021, 0, 1);
  const endMs = Date.now();
  let lastUpdate = new Date().toISOString();
  // 现货与汇率每次刷新只抓一次（可由 server 传入复用）
  const spot = preSpot !== undefined ? preSpot : await fetchSpotAll().catch(() => null);
  const anchorYears = Object.keys(USDCNY).map(Number).sort((a, b) => a - b);
  const lastAnchor = USDCNY[anchorYears[anchorYears.length - 1]];
  const modelFx = { usdcny: lastAnchor[lastAnchor.length - 1], hkdcny: Math.round(lastAnchor[lastAnchor.length - 1] / USDHKD * 10000) / 10000 };
  let anyReal = false, anySpot = false;
  const health = { goldapi: false, fx: false, sina: {}, eastmoney: {}, pages: {}, disk: {}, validation: {}, hourly: {} };
  // 每日真实汇率（香港价折算用），整轮只抓一次
  let rates = {};
  try { rates = await fetchFX(2200); } catch (e) { rates = {}; }
  health.fx = Object.keys(rates).length > 0;
  for (const [metal, cfg] of Object.entries(METALS)) {
    let L, D, H, hL = null, hD = null, hH = null, dataMode, fx, spotInfo = null;
    let lReal = null, dReal = null, hReal = null;
    // 1) 真实数据：新浪（伦敦日K）+ 东财（国内日K/60分钟K）+ 真实汇率（香港折算）
    let real = null, hRealBars = null;
    try { real = await fetchRealSeries(metal, rates); } catch (e) { real = null; }
    try { hRealBars = await fetchHourlyReal(metal); } catch (e) { hRealBars = null; }
    if (real) { health.sina[metal] = real.sinaOk; health.eastmoney[metal] = real.emOk; }
    if (!real || !real.ok) {
      // 2) 平台沙箱抓不到新浪/东财时：改用 GitHub Pages 上 Actions 刚生成的数据（每15分钟更新）
      real = await fetchFromPages(metal).catch(() => null);
      if (real) health.pages = health.pages || {};
      if (real) health.pages[metal] = true;
    }
    if (!real || !real.ok) {
      // 3) 最后：保留本地已有的真实数据（末端仍更新为现货），避免被建模数据覆盖
      real = loadExistingReal(metal);
      if (real) health.disk = health.disk || {};
      if (real) health.disk[metal] = true;
    }
    if (real && real.L.length > 200 && real.D.length > 200) {
      dataMode = "real";
      L = real.L; D = real.D; H = real.H;
      fx = real.fx || modelFx;
      anyReal = true;
    } else {
      dataMode = "modeled";
      const rng = mulberry32(20261026);
      const dd = genDaily(cfg.anchor, startMs, endMs, VOL[metal], WIGGLE[metal], rng);
      L = dd.london; D = dd.domestic; H = dd.hongkong;
      fx = modelFx;
    }
    // 3) 现货：伦敦最后一根 = gold-api 实时现货；国内保持真实收盘（不用伦敦反推，避免升水系数失真）
    const s = spot && SPOT_SYMBOL[metal] ? spot[SPOT_SYMBOL[metal]] : null;
    if (s && s.price) {
      const fxr = spot.fx || { usdcny: modelFx.usdcny, usdhkd: USDHKD };
      const usdhkd = fxr.usdhkd || USDHKD;
      lReal = metal === "copper" ? s.price * LB2KG : s.price; // HG 美元/磅 -> 美元/吨
      hReal = lReal * usdhkd;
      if (dataMode === "real") {
        L = spliceSpotLast(L, lReal);
        if (H.length) H[H.length - 1] = [H[H.length - 1][0], round2(hReal)];
      } else {
        dReal = metal === "copper"
          ? lReal * fxr.usdcny * 1.13 + 500
          : (lReal + (metal === "gold" ? 15 : 0.6)) / OZ2G * fxr.usdcny;
        L = spliceTail(L, lReal, 90);
        D = spliceTail(D, dReal, 90);
        H = spliceTail(H, hReal, 90);
      }
      dataMode = dataMode === "real" ? "real" : "spot";
      fx = { usdcny: Math.round(fxr.usdcny * 10000) / 10000, hkdcny: Math.round(fxr.usdcny / usdhkd * 10000) / 10000 };
      spotInfo = { symbol: SPOT_SYMBOL[metal].toUpperCase(), priceUsd: round2(lReal), ts: s.ts, source: "gold-api.com" };
      if (s.ts) lastUpdate = s.ts;
      anySpot = true;
    }
    // 4) 小时线：只输出真实 60 分钟K（约11个交易日）。不用合成日内数据充数——
    //    小时粒度必须是真实数据；真实源未返回则留空并在 payload 注明，等下一次例行抓取恢复。
    let hourlyNote = null;
    if (dataMode === "real") {
      const realHourly = buildHourlyFromReal(hRealBars, D, L, real.rates || {})
        || (real.hL && real.hL.length > 100 ? { london: real.hL, domestic: real.hD, hongkong: real.hH } : null);
      if (realHourly) {
        // 小时线同样过校验门（此前只有日线校验，脏bar会直接发布）
        const hv = validateHourly(metal, realHourly.london, realHourly.domestic, realHourly.hongkong);
        if (hv.ok) {
          hL = realHourly.london; hD = realHourly.domestic; hH = realHourly.hongkong;
        } else {
          hL = []; hD = []; hH = [];
          hourlyNote = "小时线暂不可用：本轮小时数据未通过校验（" + hv.reason + "），已保留日线；将在下一次例行抓取自动恢复。";
          health.hourly = health.hourly || {};
          health.hourly[metal] = "invalid: " + hv.reason;
        }
      } else {
        hL = []; hD = []; hH = [];
        hourlyNote = "小时线暂不可用：真实 60 分钟K 源本轮未返回合格数据（已按规则清洗与校验），已保留日线；将在下一次例行抓取（每 15 分钟）自动恢复。";
        health.hourly = health.hourly || {};
        health.hourly[metal] = "missing";
      }
    } else {
      // 建模路径：合成交易时段小时线（锚定日收盘，仅当日线都不可用时兜底）
      const hr = genHourly(L, D, H, endMs, 60, mulberry32(20261026));
      hL = hr.london; hD = hr.domestic; hH = hr.hongkong;
    }
    // 小时线末端与现货对齐（伦敦=实时现货；国内保持真实收盘，不用反推值）
    if (lReal != null && hL.length) {
      hL[hL.length - 1][1] = round2(lReal);
      if (hH.length) hH[hH.length - 1][1] = round2(hReal);
      if (dataMode !== "real" && hD.length) hD[hD.length - 1][1] = round2(dReal);
    }
    // 5) 校验：通过才清洗入库并发布；不通过则保留上一版已发布数据（不覆盖）
    let prevLast = null;
    try {
      const prev = JSON.parse(fs.readFileSync(path.join(DATA_DIR, metal + ".json"), "utf-8"));
      if (prev && prev.series && prev.series.domestic && prev.series.domestic.length) {
        prevLast = prev.series.domestic[prev.series.domestic.length - 1][1];
      }
    } catch (e) {}
    const vres = validateSeries(metal, L, D, H, prevLast, lReal);
    if (!vres.ok) {
      health.validation = health.validation || {};
      health.validation[metal] = vres.reason;
      console.warn(`[${metal}] 校验未通过，保留上一版已发布数据：${vres.reason}`);
      continue;
    }
    health.validation = health.validation || {};
    health.validation[metal] = "ok";
    const payload = buildPayload(metal, cfg, L, D, H, hL, hD, hH, lastUpdate, dataMode, fx);
    if (spotInfo) payload.spot = spotInfo;
    if (hourlyNote) payload.hourlyNote = hourlyNote;
    writeJSON(metal + ".json", payload);
    console.log(`[${metal}] ${dataMode} 日线=${payload.series.london.length} 小时=${payload.hourly.london.length}` + (spotInfo ? ` 现货=${spotInfo.priceUsd} USD` : "") + (hourlyNote ? " 小时线缺失" : ""));
  }
  health.goldapi = !!anySpot;
  const meta = {
    generatedAt: lastUpdate, dataMode: anyReal ? "real" : (anySpot ? "spot" : "modeled"),
    sourceHealth: health,
    spotSource: anySpot ? ("gold-api.com 现货（XAU/XAG/HG）+ " + (spot && spot.fx ? spot.fx.source : "Frankfurter") + " 汇率") : null,
    markets: {
      london: "伦敦（COMEX/LME 连续合约，USD；新浪国际期货日K）",
      domestic: "国内（上海金交所 AU9999 / 白银T+D / 沪铜主连；东方财富真实日K）",
      hongkong: "香港（按每日真实汇率由伦敦价折算；Frankfurter）",
    },
    updatePolicy: {
      hourly: "每 15 分钟例行抓取一次真实现货（gold-api.com）与汇率，并刷新最新价",
      daily: "日K为真实收盘价，随每 15 分钟刷新自动更新",
      history: "近 5 年真实历史日K（新浪国际期货 + 东方财富）",
    },
    disclaimer: "数据模式：全部为真实数据。发布链路：定时收集（每 15 分钟）→ 校验（条数/时间递增/数值范围/单日跳变≤25%/无大段缺失/末端新鲜度/伦敦末端与 gold-api 现货交叉核对/与上版偏差≤15%）→ 清洗（去重、排序、单位折算）→ 入库（本地文件 + 云库）→ 发布；任一校验不通过则该品种保留上一版已发布数据，不覆盖。数据源：伦敦价为新浪国际期货日K（COMEX 黄金/白银连续、COMEX 铜连续，美分/磅已折算为美元/吨），最新价为 gold-api.com 实时现货；国内价为东方财富真实日K（上海金交所 AU9999 元/克、白银T+D 元/千克、沪铜主连 元/吨）；香港价按每日真实汇率（Frankfurter）折算；小时线仅采用真实 60 分钟K（近约 11 个交易日），非交易时段不画线（虚线表示价格延续）。重大事件同样经过校验门禁：定时抓取 RSS 财经资讯（WSJ/CNBC）→ 跨源聚类去重 → 分类/方向标签 → 校验（日期格式且非未来、标题非空且不重复、分类与方向合法、来源非空、链接合法、倒序且≤80条）→ 清洗入库 → 发布；任一品种不合格则保留上一版已发布事件。仅供研究参考，不构成投资建议。「元/克」视图按真实汇率将伦敦（美元/盎司）与香港（港元/盎司）价折算为人民币元/克。",
  };
  writeJSON("meta.json", meta);
  return { lastUpdate, dataMode: meta.dataMode };
}

function buildPayload(metal, cfg, L, D, H, hL, hD, hH, lastUpdate, dataMode, fx) {
  const SOURCE = {
    real: "真实数据：新浪国际期货日K（伦敦）+ 东方财富日K（国内）+ Frankfurter 汇率（香港折算）+ gold-api.com 实时现货",
    spot: "gold-api.com 实时现货（XAU/XAG/HG）+ Frankfurter/open.er-api 真实汇率；历史为锚定真实历史价位的建模趋势（近端 90 天向现货收敛，最新点=现货价）",
    modeled: "锚定真实历史价位的建模数据",
  };
  return {
    metal, name: cfg.name, unit: cfg.unit, markets: ["london", "domestic", "hongkong"],
    series: { london: L, domestic: D, hongkong: H },
    hourly: { london: hL, domestic: hD, hongkong: hH },
    lastUpdate, dataMode, fx,
    source: SOURCE[dataMode] || SOURCE.modeled,
  };
}

// ---------- 自动抓取全网重大信息（RSS）----------
// WSJ 两源自 2025-01 停更（实测最新条目停更 638 天），靠 FEED_STALE_DAYS 门禁自动跳过；
// 保留定义是为了它哪天复活时能自动恢复供料（源健康度面板会持续显示 stale 状态）。
// 2026-10-28 补源：实测可用且条目新鲜的三个源（Kitco/Mining/Yahoo/Investing 均 403/404，BBC/Guardian 连不上）
const FEEDS = [
  { name: "WSJ 市场", url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml" },
  { name: "WSJ 国际", url: "https://feeds.a.dj.com/rss/RSSWorldNews.xml" },
  { name: "CNBC 市场", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839135" },
  { name: "CNBC 经济", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258" },
  { name: "CNBC 头条", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114" },
  { name: "CNBC 商务", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10001147" },
  { name: "MarketWatch 头条", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories" },
];
// 源停更判定：最新一条 pubDate 超过这么多天，该源判「陈旧」，其条目不再入库。
// 真实案例：WSJ 两个 feed 停更在一年多前，旧闻每 15 分钟混进候选池，
// 与历史库标题碰撞后在去重环节被合并吞掉，白抓还污染统计。
const FEED_STALE_DAYS = 7;
const METAL_KEYS = {
  gold: [/\bgold\b/i, /bullion/i, /金价|黄金/i, /comex/i, /precious metal/i],
  silver: [/\bsilver\b/i, /银价|白银/i, /comex/i, /precious metal/i],
  copper: [/\bcopper\b/i, /铜价|沪铜|精铜|阴极铜/i, /\blme\b/i, /base metal/i, /industrial metal/i, /dr copper/i],
};
const MACRO_KEYS = [
  /\bfed\b/i, /federal reserve/i, /central bank|央行/i, /rate cut|降息|加息|利率/i,
  /inflation|cpi|\bpce\b|通胀/i, /tariff|关税|trade war/i, /recession|衰退/i,
  /stimulus|刺激/i, /jobs report|就业|nonfarm/i, /goldman|摩根/i,
];
function stripText(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&apos;/g, "'").replace(/&#0?39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();
}
function pickTag(block, tag) {
  const m = block.match(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">", "i"));
  return m ? stripText(m[1]) : null;
}
function parseRSS(xml) {
  const out = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/g) || [];
  for (const b of blocks) {
    const title = pickTag(b, "title");
    if (!title) continue;
    out.push({
      title,
      link: pickTag(b, "link"),
      pub: pickTag(b, "pubDate"),
      desc: pickTag(b, "description") || "",
    });
  }
  return out;
}
// 从文章 URL 的发布路径里取日期（优先于 pubDate）
// 【C19】实测同一个 CNBC 文章在不同 CDN 副本上 pubDate 不一致（20:59Z vs 次日 01:30Z），
//   而 URL 里的 /YYYY/MM/DD/ 是发布方的规范发布日期，跨副本、跨时区都稳定。
//   取不到时回落 isoDate(pub)（UTC 口径），再取不到才用当天。
function dateFromUrl(u) {
  const m = String(u || "").match(/\/(\d{4})\/(\d{2})\/(\d{2})(?:\/|-|_)/);
  if (!m) return "";
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return "";
  return m[1] + "-" + m[2] + "-" + m[3];
}

function isoDate(s) {
  const d = new Date(s);
  // 【C19】统一用 UTC 取事件日期。
  //   原实现用本地时区（getFullYear/getMonth/getDate），有两个硬伤：
  //     ① 同一篇文章的日期随「运行机器时区」不同而不同（平台沙箱 vs 本机 vs 云函数）→ 跨端漂移；
  //     ② RSS 的 pubDate 会被发布方更新（实测 CNBC 把同一条从 12:00Z 改到 20:59Z），
  //        跨过本地 00:00（UTC+8 即 16:00Z）时日期从 10-28 翻转成 10-29
  //        → 「同日期」类去重规则失效，用户看到两张同形卡片（美联储·冲突 / 美联储·楼市）。
  //   UTC 口径：跨机器确定、与本文件其它日期校验（未来日期、源停更）一致，且不受 pubDate 抖动影响。
  if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}
// 判定该条新闻归属哪些品种；宏观类事件三个品种均计入
function routeMetal(t) {
  const hits = [];
  for (const m of ["gold", "silver", "copper"]) if (METAL_KEYS[m].some((r) => r.test(t))) hits.push(m);
  if (hits.length) return hits;
  if (MACRO_KEYS.some((r) => r.test(t))) return ["gold", "silver", "copper"];
  return [];
}
function impactOf(t) {
  const UP = /surge|jump|rally|climb|rise|higher|record|soar|gain|boost|\bpow\b|突破|上涨|大涨|创新高|走强|反弹/i;
  const DOWN = /sink|slump|fall|drop|lower|slide|decline|plunge|tumble|retreat|跌|下跌|回落|承压|重挫/i;
  const u = UP.test(t), d = DOWN.test(t);
  if (u && !d) return "up";
  if (d && !u) return "down";
  return "mixed";
}
function catOf(t) {
  if (/tariff|trade war|war\b|attack|strike on|iran|israel|ukraine|russia|中东|伊朗|以色列|俄罗斯|乌|冲突|地缘/i.test(t)) return "地缘政治";
  if (/fed\b|federal reserve|rate cut|hike|inflation|cpi|central bank|stimulus|加税|货币|加息|降息|央行|利率|通胀/i.test(t)) return "货币政策";
  if (/supply|mine|smelter|output|shortage|inventory|demand|库存|产量|罢工|矿端|减产/i.test(t)) return "供需";
  return "市场";
}

// ---------- 中文归纳：关键标签 / 中文标题 / 中文摘要（规则化，输出保证全中文）----------
const ZH_PHRASES = [
  [/rate cut|cuts? rates|easing|pivot to cuts/i, "降息"],
  [/rate hike|raises? rates|hawkish|tightening/i, "加息"],
  [/fed\b|federal reserve|fomc|powell/i, "美联储"],
  [/inflation|cpi\b|\bpce\b/i, "通胀"],
  [/tariff(s)?|trade war|import dut/i, "关税"],
  [/gold/i, "黄金"],
  [/silver/i, "白银"],
  [/copper/i, "铜"],
  [/iran/i, "伊朗"],
  [/israel|gaza/i, "以色列"],
  [/ukraine/i, "乌克兰"],
  [/russia/i, "俄罗斯"],
  [/war|conflict|attack|missile|strike on/i, "冲突"],
  [/jobs|payrolls|nonfarm|unemployment/i, "就业"],
  [/recession/i, "衰退"],
  [/central bank|\becb\b|\bboj\b|\bpboc\b/i, "央行"],
  [/stimulus/i, "刺激政策"],
  [/housing|home sales|mortgage/i, "楼市"],
  [/dollar/i, "美元"],
  [/china|beijing/i, "中国"],
  [/\buk\b|britain|england|sterling/i, "英国"],
  [/europe|eurozone/i, "欧元区"],
  [/demand/i, "需求"],
  [/supply|shortage|mine|smelter|output|inventor/i, "供应"],
  [/surge[sd]?|soar[sd]?|jump[sd]?|rall(y|ies)|record|climb[sd]?|boost|higher/i, "走强"],
  [/sink[s]?|slump[s]?|fall[s]?|plunge[s]?|tumble[s]?|drop[s]?|decline[s]?|retreat|lower/i, "走弱"],
  [/stocks|equities|wall street|\bai\b/i, "股市"],
  [/oil/i, "原油"],
];
function zhTags(t) {
  const tags = [];
  for (const [re, zh] of ZH_PHRASES) if (re.test(t) && tags.indexOf(zh) < 0) tags.push(zh);
  return tags.slice(0, 4);
}
function zhTitle(t, tags) {
  const dir = impactOf(t);
  const head = (tags || []).filter((x) => x !== "走强" && x !== "走弱").slice(0, 2).join("·") || "国际市场";
  const dirZh = dir === "up" ? "利多驱动" : dir === "down" ? "利空压制" : "多空交织";
  return head + "：" + dirZh;
}
var MONTHS = { january: "1", february: "2", march: "3", april: "4", may: "5", june: "6", july: "7", august: "8", september: "9", october: "10", november: "11", december: "12" };
var MONTH_RE = "january|february|march|april|may|june|july|august|september|october|november|december";
function rx(s, flags) { return new RegExp(s, flags || "i"); }
// 月份：September → 9 月
function monthZh(w) { return (MONTHS[String(w || "").toLowerCase()] || "") + "月"; }

// ---------- 多词短语词典 ----------
// 顺序很关键：
// ① 整句/长搭配先手——此时标题还是原始英文，实体词没被替换成中文，长模式才匹配得上；
// ② 命中后整体用 «» 保护，后面的单词词典不会再动它；
// ③ 词条值可以是字符串，也可以是函数 (m, g1, g2) => 中文（用于月份、数字等动态内容）。
var ZH_LEX_P = [
  // ① 整句 / 长搭配
  [/^economists?\s*[:：]/i, "经济学家："],
  [/^analysts?\s*[:：]/i, "分析师："],
  [/coming, but not this week/i, "将至，但本周不会"],
  [rx("became a ['\"]?fact of life['\"]? in the u\\.s\\.a?\\.?"), "在美国成为常态"],
  [/fact of life/i, "常态"],
  [rx("one-year outlook in fed survey hits? highest level since (" + MONTH_RE + ")"), function (m, g1) { return "美联储调查中一年期预期触及" + monthZh(g1) + "以来最高"; }],
  [rx("hits? highest level since (" + MONTH_RE + ")"), function (m, g1) { return "触及" + monthZh(g1) + "以来最高水平"; }],
  [rx("hits? highest since (" + MONTH_RE + ")"), function (m, g1) { return "触及" + monthZh(g1) + "以来最高"; }],
  [/flashing (?:a )?warning not seen since (?:the )?great recession/i, "亮起自大衰退以来首见的警示"],
  [/flashing (?:a )?warning signs? just as/i, "亮起预警信号，同时"],
  [/flashing (?:a )?warning signs?|flashing (?:a )?warning/i, "亮起预警信号"],
  [/(?:is |are )?wreaking havoc with|wreaks? havoc with/i, "严重扰乱"],
  [/is dominating|are dominating|dominates?/i, "主导"],
  [/\bjust as\b/i, "，同时"],
  [rx("inflation on many everyday items"), "多种日用品涨价"],
  [/could see a|could see/i, "或出现"],
  [rx("['\"]?disorderly['\"]? spike"), "无序跳升"],
  [/would be catastrophic for (?:the )?industr(?:y|ies)/i, "将对行业造成灾难性冲击"],
  [/catastrophic for (?:the )?industr(?:y|ies)/i, "对行业造成灾难性冲击"],
  [/work is not done|is not done/i, "抗通胀尚未结束"],
  [rx("jumps? to\\s*([\\d.,]+\\s*%?)\\s*in\\s*(" + MONTH_RE + ")"), function (m, g1, g2) { return monthZh(g2) + "升至" + String(g1).replace(/\s/g, ""); }],
  [/jumps? to|jumped to|jumps? by/i, "升至"],
  [/climbs? to|climbed to/i, "升至"],
  [/falls? to|fell to/i, "降至"],
  [/drops? to|dropped to/i, "降至"],
  [/on the rise/i, "升温"],
  [/heats? up|heating up/i, "升温"],
  [/cools? (?:down|off)/i, "降温"],
  [/due to/i, "源于"],
  [/thanks to/i, "得益于"],
  [/auto tariffs?/i, "汽车关税"],
  [rx("u\\.s\\.a?,? colombia tariff spat"), "，因美国与哥伦比亚关税争端"],
  [/tariff spat/i, "关税争端"],
  [/tariff standoff/i, "关税对峙"],
  [/trade war/i, "贸易战"],
  [/settle lower|settles lower|settled lower/i, "收跌"],
  [/settle higher|settles higher|settled higher/i, "收涨"],
  [/hit record|hits record|hit a record|hits a record|hit all-time high/i, "创历史新高"],
  [/record high/i, "历史新高"],
  [/above estimates?|above expectations?|beats? estimates?/i, "高于预期"],
  [/below estimates?|misses? estimates?/i, "低于预期"],
  [/fairly stable/i, "基本稳定"],
  [/crude exports?/i, "原油出口"],
  [/oil exports?/i, "石油出口"],
  [/crude oil/i, "原油"],
  [/will accept/i, "将接收"],
  [/deportees?/i, "被驱逐移民"],
  [rx(":\\s*cnbc survey"), "（CNBC 调查）"],
  // ② 经济 / 政策术语
  [/more (?:interest )?rate hikes?/i, "进一步加息"],
  [rx("holds? rates (?:steady |unchanged |on hold )?in (" + MONTH_RE + ")"), function (m, g1) { return monthZh(g1) + "维持利率不变"; }],
  [/holds? rates?|keeps? rates?|leaves? rates? (?:unchanged|steady|on hold)/i, "维持利率不变"],
  [/(?:interest )?rate hikes?|hikes? (?:interest )?rates?|raises? rates?/i, "加息"],
  [/(?:interest )?rate cuts?|cuts? (?:interest )?rates?/i, "降息"],
  [/rate hike expectations?/i, "加息预期"],
  [/rate cut expectations?/i, "降息预期"],
  [/monetary polic(?:y|ies)/i, "货币政策"],
  [/fiscal polic(?:y|ies)/i, "财政政策"],
  [/yield curve/i, "收益率曲线"],
  [/bond yields?/i, "债券收益率"],
  [/treasury yields?|treasuries/i, "美债收益率"],
  [/10-year|\b10y\b/i, "10 年期"],
  [/retail inflation|consumer inflation|consumer prices?/i, "零售通胀"],
  [/hot ppi/i, "PPI 高企"],
  [/producer prices?|\bppi\b/i, "PPI"],
  [/core inflation/i, "核心通胀"],
  [/inflation fears?/i, "通胀担忧"],
  [/inflation risks?/i, "通胀风险"],
  [/inflation forecasts?|inflation outlook|inflation expectations?/i, "通胀预期"],
  [/jobs report|nonfarm payrolls|payrolls/i, "非农就业"],
  [/unemployment rate/i, "失业率"],
  [/jobless claims/i, "初请失业金人数"],
  [/great recession/i, "大衰退"],
  // ③ 机构 / 人物
  [/goldman sachs/i, "高盛"], [/\bgoldman\b/i, "高盛"],
  [/jp ?morgan|jpmorgan/i, "摩根大通"],
  [/morgan stanley/i, "摩根士丹利"],
  [/kevin warsh/i, "凯文·沃什"],
  [/jerome powell|\bpowell\b/i, "鲍威尔"],
  [/new york fed|\bny fed\b/i, "纽约联储"],
  [/federal reserve|\bthe fed\b|\bfed(?:'s)?\b/i, "美联储"],
  [/philippine central bank|bangko sentral/i, "菲律宾央行"],
  [/european central bank|\becb\b/i, "欧洲央行"],
  [/bank of japan|\bboj\b/i, "日本央行"],
  [/people's bank of china|\bpboc\b/i, "中国人民银行"],
  [/central bank(?:'s)?/i, "央行"],
  [/white house/i, "白宫"],
  [/wall street/i, "华尔街"],
  [/international monetary fund|\bimf\b/i, "IMF"],
  [/\bhonda\b/i, "本田"], [/\btoyota\b/i, "丰田"], [/\btesla\b/i, "特斯拉"],
  [/\bnvidia\b/i, "英伟达"], [/\btrump\b/i, "特朗普"], [/\bbiden\b/i, "拜登"], [/\bmusk\b/i, "马斯克"],
  // ④ 国家 / 地区
  [rx("in the u\\.s\\.a?\\.?"), "在美国"],
  [/\bu\.s\.a?\.?(?![a-z])/i, "美国"],
  [/\buk\b|britain|british/i, "英国"],
  [/comex gold/i, "COMEX 黄金"],
  [/comex silver/i, "COMEX 白银"],
  [/coffee prices?/i, "咖啡价格"],
  [/arabica/i, "阿拉比卡"],
  [/el ni(?:ñ|n)o/i, "厄尔尼诺"],
  [/godzilla/i, "超强"],
  [/cnbc survey/i, "CNBC 调查"],
  [/freight|shipping/i, "航运"],
  // ⑤ 时间
  [rx("\\bin (" + MONTH_RE + ")"), function (m, g1) { return monthZh(g1); }],
];

// ---------- 单词词典 ----------
var ZH_LEX_W = {
  // 国家 / 地区
  us: "美国", usa: "美国", america: "美国", american: "美国", americans: "美国人",
  uk: "英国", england: "英格兰", europe: "欧洲", eurozone: "欧元区", eu: "欧盟",
  germany: "德国", france: "法国", italy: "意大利", spain: "西班牙", netherlands: "荷兰",
  japan: "日本", china: "中国", chinese: "中国", india: "印度", russia: "俄罗斯", russian: "俄罗斯",
  ukraine: "乌克兰", iran: "伊朗", israel: "以色列", gaza: "加沙", taiwan: "中国台湾地区", hongkong: "中国香港",
  canada: "加拿大", canadian: "加拿大", mexico: "墨西哥", brazil: "巴西", colombia: "哥伦比亚",
  chile: "智利", peru: "秘鲁", australia: "澳大利亚", korea: "韩国", vietnam: "越南",
  philippines: "菲律宾", philippine: "菲律宾", indonesia: "印尼", turkey: "土耳其",
  saudi: "沙特", emirates: "阿联酋", qatar: "卡塔尔", egypt: "埃及", nigeria: "尼日利亚",
  africa: "非洲", asia: "亚洲", european: "欧洲",
  // 机构
  fed: "美联储", fomc: "美联储", government: "政府", administration: "政府", congress: "国会",
  senate: "参议院", treasury: "财政部", bank: "银行", economist: "经济学家",
  economists: "经济学家", analyst: "分析师", analysts: "分析师", strategists: "策略师",
  survey: "调查", report: "报告", data: "数据",
  // 宏观
  inflation: "通胀", cpi: "CPI", ppi: "PPI", gdp: "GDP", deflation: "通缩", recession: "衰退",
  growth: "增长", slowdown: "放缓", job: "就业", jobs: "就业", payroll: "就业人数",
  unemployment: "失业率", labor: "劳动力", labour: "劳动力", wage: "工资", wages: "工资",
  consumer: "消费者", consumers: "消费者", spending: "支出", retail: "零售", sales: "销售",
  orders: "订单", manufacturing: "制造业", factory: "工厂", output: "产出", production: "产量",
  export: "出口", exports: "出口", imports: "进口", trade: "贸易", deficit: "赤字",
  debt: "债务", debts: "债务", bond: "债券", bonds: "债券", yield: "收益率", yields: "收益率",
  dollar: "美元", euro: "欧元", yuan: "人民币", sterling: "英镑", currency: "汇率",
  economy: "经济", economic: "经济", stimulus: "刺激政策", budget: "预算", tax: "税收",
  taxes: "税收", fiscal: "财政", monetary: "货币", policy: "政策", policies: "政策",
  liquidity: "流动性", credit: "信贷", lending: "信贷", loans: "贷款", default: "违约",
  bankruptcy: "破产", earnings: "财报", revenue: "营收", profit: "利润", ipo: "IPO",
  merger: "并购", acquisition: "收购", hedge: "对冲", fund: "基金", funds: "基金",
  volatility: "波动率", risk: "风险", risks: "风险", sentiment: "市场情绪",
  // 市场 / 商品
  gold: "黄金", silver: "白银", copper: "铜", bullion: "现货金", platinum: "铂金",
  palladium: "钯金", nickel: "镍", zinc: "锌", aluminum: "铝", aluminium: "铝", iron: "铁矿石",
  ore: "矿石", steel: "钢铁", lithium: "锂", metal: "金属", metals: "金属",
  miner: "矿企", miners: "矿企", mining: "矿业", mine: "矿山", mines: "矿山",
  smelter: "冶炼厂", smelters: "冶炼厂", refinery: "精炼厂", inventory: "库存", inventories: "库存",
  supply: "供应", supplies: "供应", demand: "需求", shortage: "短缺",
  oil: "原油", crude: "原油", gas: "天然气", coal: "煤炭", power: "电力", energy: "能源",
  electricity: "电力", opec: "OPEC", bitcoin: "比特币", crypto: "加密货币",
  equities: "股票", stock: "股票", stocks: "股票", shares: "股票",
  market: "市场", markets: "市场", investor: "投资者", investors: "投资者",
  wall: "华尔街", street: "华尔街", boom: "热潮", rally: "反弹", bubble: "泡沫",
  housing: "楼市", home: "住房", homes: "住房", mortgage: "抵押贷款",
  // 政治 / 冲突
  tariff: "关税", tariffs: "关税", duties: "关税", war: "战争", wars: "战争",
  conflict: "冲突", attack: "袭击", attacks: "袭击", missile: "导弹", missiles: "导弹",
  troops: "军队", ceasefire: "停火", talks: "谈判", summit: "峰会", deal: "协议",
  agreement: "协议", sanction: "制裁", sanctions: "制裁", restrictions: "限制",
  curbs: "限制", ban: "禁令", quota: "配额", election: "大选",
  // 动词
  surge: "大涨", surges: "大涨", surged: "大涨", soar: "飙升", soars: "飙升", soared: "飙升",
  jump: "跳升", jumps: "跳升", jumped: "跳升", climb: "上涨", climbs: "上涨", climbed: "上涨",
  rise: "上涨", rises: "上涨", rose: "上涨", gain: "上涨", gains: "上涨", gained: "上涨",
  advance: "上行", advances: "上行",
  fall: "下跌", falls: "下跌", fell: "下跌", drop: "下跌", drops: "下跌", dropped: "下跌",
  decline: "下跌", declines: "下跌", declined: "下跌", sink: "下挫", sinks: "下挫",
  slump: "重挫", slumps: "重挫", slumped: "重挫", plunge: "暴跌", plunges: "暴跌", plunged: "暴跌",
  tumble: "大跌", tumbles: "大跌", tumbled: "大跌", retreat: "回落", retreats: "回落",
  slide: "下滑", slides: "下滑", slid: "下滑",
  hit: "触及", hits: "触及", reach: "触及", reaches: "触及", reached: "触及",
  break: "突破", breaks: "突破", broke: "突破", top: "突破", tops: "突破",
  settle: "收于", close: "收盘", closes: "收盘", closed: "收盘",
  hover: "徘徊", hovers: "徘徊", steady: "企稳",
  warn: "警告", warns: "警告", warned: "警告", say: "表示", says: "表示", said: "表示",
  expect: "预期", expects: "预期", expected: "预期", show: "显示", shows: "显示", showed: "显示",
  forecast: "预测", forecasts: "预测", predict: "预测", predicts: "预测",
  see: "看到", sees: "预计", weigh: "权衡", weighs: "正权衡", weighing: "正权衡",
  signal: "释放信号", signals: "释放信号", suggest: "显示", suggests: "显示",
  cut: "下调", cuts: "下调", raise: "上调", raises: "上调", hike: "上调", hikes: "上调",
  increase: "增加", increases: "增加", increased: "增加", decrease: "减少", decreased: "减少",
  expand: "扩张", expands: "扩张", contract: "收缩", contracts: "收缩",
  slow: "放缓", slows: "放缓", slowed: "放缓", accelerate: "加速", accelerates: "加速",
  add: "增加", adds: "增加", added: "增加", lose: "失去", loses: "失去", lost: "失去",
  remain: "仍", remains: "仍然", remained: "仍然",
  continue: "继续", continues: "继续", continuing: "继续",
  hold: "维持", holds: "维持", held: "维持", pause: "暂停", pauses: "暂停", paused: "暂停",
  resume: "恢复", resumes: "恢复", surprise: "带来意外", surprises: "带来意外",
  drive: "推动", drives: "推动", drove: "推动", push: "推高", pushes: "推高", pushed: "推高",
  lift: "提振", lifts: "提振", lifted: "提振", boost: "提振", boosts: "提振", boosted: "提振",
  drag: "拖累", drags: "拖累", dragged: "拖累", hurt: "打击", hurts: "打击", squeeze: "挤压",
  worsen: "加剧", worsens: "加剧", worsened: "加剧", improve: "改善", improves: "改善", improved: "改善",
  ease: "缓解", eases: "缓解", eased: "缓解", tighten: "收紧", tightens: "收紧", tightened: "收紧",
  loosen: "放松", announce: "宣布", announces: "宣布", announced: "宣布",
  plan: "计划", plans: "计划", consider: "考虑", considers: "考虑", considering: "考虑",
  debate: "讨论", debates: "讨论", sign: "签署", signs: "签署", signed: "签署",
  impose: "加征", imposes: "加征", imposed: "加征", levy: "征收", levies: "征收",
  extend: "延长", extends: "延长", suspend: "暂停", suspends: "暂停", bans: "禁止",
  strike: "打击", strikes: "打击", struck: "打击", threaten: "威胁", threatens: "威胁",
  escalate: "升级", escalates: "升级", cool: "降温", cools: "降温", heat: "升温", heats: "升温",
  stabilize: "企稳", stabilizes: "企稳", rebound: "反弹", rebounds: "反弹",
  recover: "复苏", recovers: "复苏", snap: "中断", snaps: "中断",
  dominate: "主导", dominates: "主导", dominated: "主导",
  lead: "领涨", leads: "领涨", led: "领涨", lag: "落后", lags: "落后",
  find: "寻找", finds: "寻找", became: "已成为", become: "成为",
  coming: "将至", cementing: "强化", cements: "强化", cement: "强化",
  end: "结束", ending: "结束",
  // 名词 / 形容词
  outlook: "前景", estimate: "预期", estimates: "预期",
  expectation: "预期", expectations: "预期",
  high: "高", higher: "走高", highest: "最高", low: "低", lower: "走低", lowest: "最低",
  hot: "高企", strong: "强劲", stronger: "更强", weak: "疲弱", weaker: "更弱",
  sharp: "大幅", sharply: "大幅", steep: "大幅", steeply: "大幅", modest: "温和",
  slight: "小幅", slightly: "小幅", record: "纪录", biggest: "最大", largest: "最大",
  fastest: "最快", worst: "最差", best: "最好", first: "首次",
  key: "关键", major: "主要", fresh: "新", new: "新", big: "大", small: "小",
  sudden: "突然", stable: "稳定", volatile: "波动", disorderly: "无序",
  catastrophic: "灾难性", solid: "稳健", soft: "疲软", robust: "强劲", sluggish: "低迷",
  sticky: "黏性", elevated: "高企", warning: "预警", warnings: "预警", spike: "跳升",
  problem: "问题", problems: "问题", crisis: "危机", turmoil: "动荡",
  fear: "担忧", fears: "担忧", concern: "担忧", concerns: "担忧", optimism: "乐观",
  opportunity: "机会", opportunities: "机会", everyday: "日常", item: "商品", items: "商品",
  entirely: "完全", completely: "完全", everyone: "市场普遍", everybody: "市场普遍",
  industry: "行业", industries: "行业", company: "企业", companies: "企业",
  // 时间
  week: "周", month: "月", quarter: "季度", year: "年", years: "年", months: "月", weeks: "周",
  today: "今日", tomorrow: "明日", yesterday: "昨日",
  // 连接与功能词
  amid: "，在…之际", as: "，因", while: "，同时", despite: "，尽管", although: "，尽管",
  however: "，但", but: "，但", and: "、", or: "或", if: "若", could: "或", would: "将",
  will: "将", may: "可能", might: "可能", must: "必须", not: "不", no: "无",
  because: "，因", after: "后", before: "前", since: "自", until: "直到",
  over: "，就", into: "，进入", still: "仍在",
  more: "更", most: "最", many: "多种", much: "大量", some: "部分", all: "全部",
  up: "上行", down: "下行", above: "高于", below: "低于", near: "接近", around: "约",
  toward: "逼近", towards: "逼近", past: "突破", per: "每",
};
// 保留原文的缩写 / 专有名词
var ZH_KEEP = { AI: 1, PPI: 1, CPI: 1, GDP: 1, IMF: 1, LME: 1, COMEX: 1, ETF: 1, OPEC: 1, IPO: 1, CNBC: 1, WSJ: 1 };
// 无实义功能词：直接丢弃（含被截断标题的残留）
var ZH_DROP = {
  the: 1, a: 1, an: 1, of: 1, in: 1, on: 1, for: 1, to: 1, at: 1, by: 1, with: 1, from: 1,
  into: 1, onto: 1, over: 1, under: 1, about: 1, than: 1, then: 1, there: 1, their: 1,
  theirs: 1, our: 1, ours: 1, we: 1, us: 1, you: 1, he: 1, she: 1, they: 1, them: 1,
  his: 1, her: 1, hers: 1, it: 1, its: 1, this: 1, that: 1, these: 1, those: 1,
  is: 1, are: 1, was: 1, were: 1, be: 1, been: 1, being: 1, am: 1, has: 1, have: 1, had: 1,
  do: 1, does: 1, did: 1, here: 1, what: 1, how: 1, why: 1, when: 1, where: 1, which: 1,
  who: 1, whom: 1, even: 1, too: 1, very: 1,
};
var P_ZH = "«";    // 短语译文保护头
var P_END = "»";   // 短语译文保护尾
var P_COMM = "§";  // 逗号（按两侧长度决定最终呈 、 或 ，）
var P_CLAUSE = "¶"; // 破折号 / 冒号 / 句号 → ，

function normTitle(t) {
  var s = String(t || "");
  s = s.replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ");
  s = s.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/\s*[|·\-–—]\s*(cnbc|marketwatch|wsj|reuters|bloomberg|forbes|yahoo|investing\.com|ap|afp|ft|nytimes)\s*$/i, "");
  s = s.replace(/^(analysis|opinion|exclusive|commentary|first look|watch|video|podcast|report)\s*[:：]\s*/i, "");
  s = s.replace(/\s*\.{2,}$/, "");
  s = s.replace(/\s*[.。]\s*$/, "");
  return s.trim();
}

// 说话人后置于句尾：", NY Fed says" → 前置「纽约联储表示，」
var SPEAKER_TAIL = /,\s*([A-Za-z][A-Za-z0-9'\.\- ]{1,30}?)\s+(says?|said|warns?|warned|reports?|reported|finds?|found)\s*$/i;

function wordToZh(w) {
  var s = String(w || "");
  if (!s) return "";
  if (ZH_KEEP[s]) return s;
  var low = s.toLowerCase();
  if (ZH_DROP[low]) return "";
  if (ZH_LEX_W[low]) return ZH_LEX_W[low];
  var tries = [];
  if (/ies$/i.test(low)) tries.push(low.replace(/ies$/i, "y"));
  if (/(ches|shes|sses|xes|zes)$/i.test(low)) tries.push(low.replace(/es$/i, ""));
  if (/ed$/i.test(low)) { tries.push(low.replace(/ed$/i, "")); tries.push(low.replace(/ed$/i, "e")); }
  if (/ing$/i.test(low)) { tries.push(low.replace(/ing$/i, "")); tries.push(low.replace(/ing$/i, "e")); }
  if (/ers$/i.test(low)) tries.push(low.replace(/ers$/i, ""));
  if (/ly$/i.test(low)) tries.push(low.replace(/ly$/i, ""));
  if (/s$/i.test(low) && !/ss$/i.test(low)) { tries.push(low.replace(/s$/i, "")); tries.push(low.replace(/es$/i, "")); }
  for (var i = 0; i < tries.length; i++) {
    if (ZH_LEX_W[tries[i]]) return ZH_LEX_W[tries[i]];
    if (ZH_DROP[tries[i]]) return "";
  }
  return "";
}

// 可见长度：短语保护符 «» 与空格不计
function visLen(x) { return String(x).replace(/[«»\s]/g, "").length; }

// 纯翻译（不做质量门禁），供整句与说话人片段共用
function zhTranslate(t) {
  for (var i = 0; i < ZH_LEX_P.length; i++) {
    var re = ZH_LEX_P[i][0], zh = ZH_LEX_P[i][1];
    t = t.replace(re, zhCall(zh));
  }
  var segs = t.split(/([A-Za-z][A-Za-z']*|\d[\d.,]*%?)/);
  var out = [];
  var total = 0, missing = 0;
  for (var k = 0; k < segs.length; k++) {
    var seg = segs[k];
    if (k % 2 === 1) {
      if (/^\d/.test(seg)) { out.push(seg); continue; }
      var base = seg.replace(/'s$/i, "").replace(/['’]+$/, "");
      var low = base.toLowerCase();
      if (!ZH_DROP[low]) total++;
      var zhw = wordToZh(base);
      if (!zhw && !ZH_DROP[low] && !ZH_KEEP[base]) missing++;
      out.push(zhw);
    } else {
      var s = seg;
      s = s.replace(/['"`]/g, "");
      s = s.replace(/\s*[-–—]\s*/g, P_CLAUSE);
      s = s.replace(/\s*[:;]\s*/g, P_CLAUSE);
      s = s.replace(/\s*,\s*/g, P_COMM);
      // 句间句点：后面跟「受保护短语」或大写开头的单词才算断句
      // （否则可能吃掉 U.S. 的点、小数点；句点后若是短语，得看同一段内后面的 «）
      s = s.replace(/\s*\.\s*(?=«)/g, P_CLAUSE);
      s = s.replace(/\s*\.\s*/g, /^[A-Z]/.test(segs[k + 1] || "") ? P_CLAUSE : "");
      s = s.replace(/\s+/g, "");
      out.push(s);
    }
  }
  var text = out.join("");
  // 逗号：两侧都短（列名式）用顿号，否则逗号；长度按「去掉保护符与空格后」的可见字符算
  var parts = text.split(P_COMM);
  if (parts.length > 1) {
    var buf = parts[0];
    for (var p = 1; p < parts.length; p++) {
      var pos = Math.max(buf.lastIndexOf("，"), buf.lastIndexOf("、"));
      var leftLen = visLen(buf.slice(pos + 1));
      var cut = parts[p].search(/[，、]/);
      var rightLen = visLen(cut < 0 ? parts[p] : parts[p].slice(0, cut));
      buf += leftLen <= 8 && rightLen <= 8 ? "、" : "，";
      buf += parts[p];
    }
    text = buf;
  }
  text = text.split(P_CLAUSE).join("，");
  text = text.split(P_ZH).join("").split(P_END).join("");
  text = text.replace(/[、，]{2,}/g, "，").replace(/^[、，.]+|[、，.]+$/g, "");
  text = text.replace(/[、，]([。！？])/g, "$1");
  // 中西文之间补空格，读起来不挤（标点后面不补）
  text = text.replace(/([\u4e00-\u9fa5])([A-Za-z0-9])/g, "$1 $2").replace(/([A-Za-z0-9%])([\u4e00-\u9fa5])/g, "$1 $2");
  text = text.replace(/\s+/g, " ").trim();
  zhTranslate.total = total;
  zhTranslate.missing = missing;
  return text;
}
function zhCall(zh) {
  return function () {
    var v = typeof zh === "function"
      ? zh(arguments[0], arguments[1], arguments[2], arguments[3])
      : zh;
    return v ? P_ZH + v + P_END : "";
  };
}

// 英文标题 → 中文事件概况（带质量门禁）
function zhGist(raw) {
  var t = normTitle(raw);
  if (!t) return "";
  // 1) 句尾说话人：", NY Fed says" → 前置「纽约联储表示，」
  var head = "";
  var m = t.match(SPEAKER_TAIL);
  if (m) {
    var w = zhTranslate(m[1].replace(/\s+/g, " ").trim());
    if (/[\u4e00-\u9fa5]/.test(w)) {
      head = w + (/warn/i.test(m[2]) ? "警告，" : "表示，");
      t = t.slice(0, m.index).replace(/[,\s]+$/, "");
    }
  }
  // 2) 正文翻译
  var text = zhTranslate(t);
  if (text) text = head + text;
  // 3) 质量门禁：没译出中文 / 太短 / 译不出来的词太多 → 判定不可用，交给调用方兜底
  if (!/[\u4e00-\u9fa5]/.test(text)) return "";
  var cn = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (cn < 6) return "";
  if (zhTranslate.total >= 4 && zhTranslate.missing / zhTranslate.total > 0.45) return "";
  return text;
}
// 英文源：先讲清「发生了什么」，再给对贵金属的结论；中文源：沿用原文概述
var MONTHS = { january: "1", february: "2", march: "3", april: "4", may: "5", june: "6", july: "7", august: "8", september: "9", october: "10", november: "11", december: "12" };
var MONTH_RE = "january|february|march|april|may|june|july|august|september|october|november|december";
function rx(s, flags) { return new RegExp(s, flags || "i"); }
// 月份：September → 9 月
function monthZh(w) { return (MONTHS[String(w || "").toLowerCase()] || "") + "月"; }

// ---------- 多词短语词典 ----------
// 顺序很关键：
// ① 整句/长搭配先手——此时标题还是原始英文，实体词没被替换成中文，长模式才匹配得上；
// ② 命中后整体用 «» 保护，后面的单词词典不会再动它；
// ③ 词条值可以是字符串，也可以是函数 (m, g1, g2) => 中文（用于月份、数字等动态内容）。
var ZH_LEX_P = [
  // ① 整句 / 长搭配
  [/^economists?\s*[:：]/i, "经济学家："],
  [/^analysts?\s*[:：]/i, "分析师："],
  [/coming, but not this week/i, "将至，但本周不会"],
  [rx("became a ['\"]?fact of life['\"]? in the u\\.s\\.?a?\\.?"), "在美国成为常态"],
  [/fact of life/i, "常态"],
  [rx("one-year outlook in fed survey hits? highest level since (" + MONTH_RE + ")"), function (m, g1) { return "美联储调查中一年期预期触及" + monthZh(g1) + "以来最高"; }],
  [rx("hits? highest level since (" + MONTH_RE + ")"), function (m, g1) { return "触及" + monthZh(g1) + "以来最高水平"; }],
  [rx("hits? highest since (" + MONTH_RE + ")"), function (m, g1) { return "触及" + monthZh(g1) + "以来最高"; }],
  [/flashing (?:a )?warning not seen since (?:the )?great recession/i, "亮起自大衰退以来首见的警示"],
  [/flashing (?:a )?warning signs? just as/i, "亮起预警信号，同时"],
  [/flashing (?:a )?warning signs?|flashing (?:a )?warning/i, "亮起预警信号"],
  [/(?:is |are )?wreaking havoc with|wreaks? havoc with/i, "严重扰乱"],
  [/is dominating|are dominating|dominates?/i, "主导"],
  [/\bjust as\b/i, "，同时"],
  [rx("inflation on many everyday items"), "多种日用品涨价"],
  [/could see a|could see/i, "或出现"],
  [rx("['\"]?disorderly['\"]? spike"), "无序跳升"],
  [/would be catastrophic for (?:the )?industr(?:y|ies)/i, "将对行业造成灾难性冲击"],
  [/catastrophic for (?:the )?industr(?:y|ies)/i, "对行业造成灾难性冲击"],
  [/work is not done|is not done/i, "抗通胀尚未结束"],
  [rx("jumps? to\\s*([\\d.,]+\\s*%?)\\s*in\\s*(" + MONTH_RE + ")"), function (m, g1, g2) { return monthZh(g2) + "升至" + String(g1).replace(/\s/g, ""); }],
  [/jumps? to|jumped to|jumps? by/i, "升至"],
  [/climbs? to|climbed to/i, "升至"],
  [/falls? to|fell to/i, "降至"],
  [/drops? to|dropped to/i, "降至"],
  [/on the rise/i, "升温"],
  [/heats? up|heating up/i, "升温"],
  [/cools? (?:down|off)/i, "降温"],
  [/due to/i, "源于"],
  [/thanks to/i, "得益于"],
  [/auto tariffs?/i, "汽车关税"],
  [rx("u\\.s\\.a?,? colombia tariff spat"), "，因美国与哥伦比亚关税争端"],
  [/tariff spat/i, "关税争端"],
  [/tariff standoff/i, "关税对峙"],
  [/trade war/i, "贸易战"],
  [/settle lower|settles lower|settled lower/i, "收跌"],
  [/settle higher|settles higher|settled higher/i, "收涨"],
  [/hit record|hits record|hit a record|hits a record|hit all-time high/i, "创历史新高"],
  [/record high/i, "历史新高"],
  [/above estimates?|above expectations?|beats? estimates?/i, "高于预期"],
  [/below estimates?|misses? estimates?/i, "低于预期"],
  [/fairly stable/i, "基本稳定"],
  [/crude exports?/i, "原油出口"],
  [/oil exports?/i, "石油出口"],
  [/crude oil/i, "原油"],
  [/will accept/i, "将接收"],
  [/deportees?/i, "被驱逐移民"],
  [rx(":\\s*cnbc survey"), "（CNBC 调查）"],
  // ② 经济 / 政策术语
  [/more (?:interest )?rate hikes?/i, "进一步加息"],
  [rx("holds? rates (?:steady |unchanged |on hold )?in (" + MONTH_RE + ")"), function (m, g1) { return monthZh(g1) + "维持利率不变"; }],
  [/holds? rates?|keeps? rates?|leaves? rates? (?:unchanged|steady|on hold)/i, "维持利率不变"],
  [/(?:interest )?rate hikes?|hikes? (?:interest )?rates?|raises? rates?/i, "加息"],
  [/(?:interest )?rate cuts?|cuts? (?:interest )?rates?/i, "降息"],
  [/rate hike expectations?/i, "加息预期"],
  [/rate cut expectations?/i, "降息预期"],
  [/monetary polic(?:y|ies)/i, "货币政策"],
  [/fiscal polic(?:y|ies)/i, "财政政策"],
  [/yield curve/i, "收益率曲线"],
  [/bond yields?/i, "债券收益率"],
  [/treasury yields?|treasuries/i, "美债收益率"],
  [/10-year|\b10y\b/i, "10 年期"],
  [/retail inflation|consumer inflation|consumer prices?/i, "零售通胀"],
  [/hot ppi/i, "PPI 高企"],
  [/producer prices?|\bppi\b/i, "PPI"],
  [/core inflation/i, "核心通胀"],
  [/inflation fears?/i, "通胀担忧"],
  [/inflation risks?/i, "通胀风险"],
  [/inflation forecasts?|inflation outlook|inflation expectations?/i, "通胀预期"],
  [/jobs report|nonfarm payrolls|payrolls/i, "非农就业"],
  [/unemployment rate/i, "失业率"],
  [/jobless claims/i, "初请失业金人数"],
  [/great recession/i, "大衰退"],
  // ③ 机构 / 人物
  [/goldman sachs/i, "高盛"], [/\bgoldman\b/i, "高盛"],
  [/jp ?morgan|jpmorgan/i, "摩根大通"],
  [/morgan stanley/i, "摩根士丹利"],
  [/kevin warsh/i, "凯文·沃什"],
  [/jerome powell|\bpowell\b/i, "鲍威尔"],
  [/new york fed|\bny fed\b/i, "纽约联储"],
  [/federal reserve|\bthe fed\b|\bfed(?:'s)?\b/i, "美联储"],
  [/philippine central bank|bangko sentral/i, "菲律宾央行"],
  [/european central bank|\becb\b/i, "欧洲央行"],
  [/bank of japan|\bboj\b/i, "日本央行"],
  [/people's bank of china|\bpboc\b/i, "中国人民银行"],
  [/central bank(?:'s)?/i, "央行"],
  [/white house/i, "白宫"],
  [/wall street/i, "华尔街"],
  [/international monetary fund|\bimf\b/i, "IMF"],
  [/\bhonda\b/i, "本田"], [/\btoyota\b/i, "丰田"], [/\btesla\b/i, "特斯拉"],
  [/\bnvidia\b/i, "英伟达"], [/\btrump\b/i, "特朗普"], [/\bbiden\b/i, "拜登"], [/\bmusk\b/i, "马斯克"],
  // ④ 国家 / 地区
  [rx("in the u\\.s\\.?a?\\.?"), "在美国"],
  [/\bu\.s\.?a?\.?(?![a-z])/i, "美国"],
  [/\buk\b|britain|british/i, "英国"],
  [/comex gold/i, "COMEX 黄金"],
  [/comex silver/i, "COMEX 白银"],
  [/coffee prices?/i, "咖啡价格"],
  [/arabica/i, "阿拉比卡"],
  [/el ni(?:ñ|n)o/i, "厄尔尼诺"],
  [/godzilla/i, "超强"],
  [/cnbc survey/i, "CNBC 调查"],
  [/freight|shipping/i, "航运"],
  // ⑤ 时间
  [rx("\\bin (" + MONTH_RE + ")"), function (m, g1) { return monthZh(g1); }],
];

// ---------- 单词词典 ----------
var ZH_LEX_W = {
  // 国家 / 地区
  us: "美国", usa: "美国", america: "美国", american: "美国", americans: "美国人",
  uk: "英国", england: "英格兰", europe: "欧洲", eurozone: "欧元区", eu: "欧盟",
  germany: "德国", france: "法国", italy: "意大利", spain: "西班牙", netherlands: "荷兰",
  japan: "日本", china: "中国", chinese: "中国", india: "印度", russia: "俄罗斯", russian: "俄罗斯",
  ukraine: "乌克兰", iran: "伊朗", israel: "以色列", gaza: "加沙", taiwan: "中国台湾地区", hongkong: "中国香港",
  canada: "加拿大", canadian: "加拿大", mexico: "墨西哥", brazil: "巴西", colombia: "哥伦比亚",
  chile: "智利", peru: "秘鲁", australia: "澳大利亚", korea: "韩国", vietnam: "越南",
  philippines: "菲律宾", philippine: "菲律宾", indonesia: "印尼", turkey: "土耳其",
  saudi: "沙特", emirates: "阿联酋", qatar: "卡塔尔", egypt: "埃及", nigeria: "尼日利亚",
  africa: "非洲", asia: "亚洲", european: "欧洲",
  // 机构
  fed: "美联储", fomc: "美联储", government: "政府", administration: "政府", congress: "国会",
  senate: "参议院", treasury: "财政部", bank: "银行", economist: "经济学家",
  economists: "经济学家", analyst: "分析师", analysts: "分析师", strategists: "策略师",
  survey: "调查", report: "报告", data: "数据",
  // 宏观
  inflation: "通胀", cpi: "CPI", ppi: "PPI", gdp: "GDP", deflation: "通缩", recession: "衰退",
  growth: "增长", slowdown: "放缓", job: "就业", jobs: "就业", payroll: "就业人数",
  unemployment: "失业率", labor: "劳动力", labour: "劳动力", wage: "工资", wages: "工资",
  consumer: "消费者", consumers: "消费者", spending: "支出", retail: "零售", sales: "销售",
  orders: "订单", manufacturing: "制造业", factory: "工厂", output: "产出", production: "产量",
  export: "出口", exports: "出口", imports: "进口", trade: "贸易", deficit: "赤字",
  debt: "债务", debts: "债务", bond: "债券", bonds: "债券", yield: "收益率", yields: "收益率",
  dollar: "美元", euro: "欧元", yuan: "人民币", sterling: "英镑", currency: "汇率",
  economy: "经济", economic: "经济", stimulus: "刺激政策", budget: "预算", tax: "税收",
  taxes: "税收", fiscal: "财政", monetary: "货币", policy: "政策", policies: "政策",
  liquidity: "流动性", credit: "信贷", lending: "信贷", loans: "贷款", default: "违约",
  bankruptcy: "破产", earnings: "财报", revenue: "营收", profit: "利润", ipo: "IPO",
  merger: "并购", acquisition: "收购", hedge: "对冲", fund: "基金", funds: "基金",
  volatility: "波动率", risk: "风险", risks: "风险", sentiment: "市场情绪",
  // 市场 / 商品
  gold: "黄金", silver: "白银", copper: "铜", bullion: "现货金", platinum: "铂金",
  palladium: "钯金", nickel: "镍", zinc: "锌", aluminum: "铝", aluminium: "铝", iron: "铁矿石",
  ore: "矿石", steel: "钢铁", lithium: "锂", metal: "金属", metals: "金属",
  miner: "矿企", miners: "矿企", mining: "矿业", mine: "矿山", mines: "矿山",
  smelter: "冶炼厂", smelters: "冶炼厂", refinery: "精炼厂", inventory: "库存", inventories: "库存",
  supply: "供应", supplies: "供应", demand: "需求", shortage: "短缺",
  oil: "原油", crude: "原油", gas: "天然气", coal: "煤炭", power: "电力", energy: "能源",
  electricity: "电力", opec: "OPEC", bitcoin: "比特币", crypto: "加密货币",
  equities: "股票", stock: "股票", stocks: "股票", shares: "股票",
  market: "市场", markets: "市场", investor: "投资者", investors: "投资者",
  wall: "华尔街", street: "华尔街", boom: "热潮", rally: "反弹", bubble: "泡沫",
  housing: "楼市", home: "住房", homes: "住房", mortgage: "抵押贷款",
  // 政治 / 冲突
  tariff: "关税", tariffs: "关税", duties: "关税", war: "战争", wars: "战争",
  conflict: "冲突", attack: "袭击", attacks: "袭击", missile: "导弹", missiles: "导弹",
  troops: "军队", ceasefire: "停火", talks: "谈判", summit: "峰会", deal: "协议",
  agreement: "协议", sanction: "制裁", sanctions: "制裁", restrictions: "限制",
  curbs: "限制", ban: "禁令", quota: "配额", election: "大选",
  // 动词
  surge: "大涨", surges: "大涨", surged: "大涨", soar: "飙升", soars: "飙升", soared: "飙升",
  jump: "跳升", jumps: "跳升", jumped: "跳升", climb: "上涨", climbs: "上涨", climbed: "上涨",
  rise: "上涨", rises: "上涨", rose: "上涨", gain: "上涨", gains: "上涨", gained: "上涨",
  advance: "上行", advances: "上行",
  fall: "下跌", falls: "下跌", fell: "下跌", drop: "下跌", drops: "下跌", dropped: "下跌",
  decline: "下跌", declines: "下跌", declined: "下跌", sink: "下挫", sinks: "下挫",
  slump: "重挫", slumps: "重挫", slumped: "重挫", plunge: "暴跌", plunges: "暴跌", plunged: "暴跌",
  tumble: "大跌", tumbles: "大跌", tumbled: "大跌", retreat: "回落", retreats: "回落",
  slide: "下滑", slides: "下滑", slid: "下滑",
  hit: "触及", hits: "触及", reach: "触及", reaches: "触及", reached: "触及",
  break: "突破", breaks: "突破", broke: "突破", top: "突破", tops: "突破",
  settle: "收于", close: "收盘", closes: "收盘", closed: "收盘",
  hover: "徘徊", hovers: "徘徊", steady: "企稳",
  warn: "警告", warns: "警告", warned: "警告", say: "表示", says: "表示", said: "表示",
  expect: "预期", expects: "预期", expected: "预期", show: "显示", shows: "显示", showed: "显示",
  forecast: "预测", forecasts: "预测", predict: "预测", predicts: "预测",
  see: "看到", sees: "预计", weigh: "权衡", weighs: "正权衡", weighing: "正权衡",
  signal: "释放信号", signals: "释放信号", suggest: "显示", suggests: "显示",
  cut: "下调", cuts: "下调", raise: "上调", raises: "上调", hike: "上调", hikes: "上调",
  increase: "增加", increases: "增加", increased: "增加", decrease: "减少", decreased: "减少",
  expand: "扩张", expands: "扩张", contract: "收缩", contracts: "收缩",
  slow: "放缓", slows: "放缓", slowed: "放缓", accelerate: "加速", accelerates: "加速",
  add: "增加", adds: "增加", added: "增加", lose: "失去", loses: "失去", lost: "失去",
  remain: "仍", remains: "仍然", remained: "仍然",
  continue: "继续", continues: "继续", continuing: "继续",
  hold: "维持", holds: "维持", held: "维持", pause: "暂停", pauses: "暂停", paused: "暂停",
  resume: "恢复", resumes: "恢复", surprise: "带来意外", surprises: "带来意外",
  drive: "推动", drives: "推动", drove: "推动", push: "推高", pushes: "推高", pushed: "推高",
  lift: "提振", lifts: "提振", lifted: "提振", boost: "提振", boosts: "提振", boosted: "提振",
  drag: "拖累", drags: "拖累", dragged: "拖累", hurt: "打击", hurts: "打击", squeeze: "挤压",
  worsen: "加剧", worsens: "加剧", worsened: "加剧", improve: "改善", improves: "改善", improved: "改善",
  ease: "缓解", eases: "缓解", eased: "缓解", tighten: "收紧", tightens: "收紧", tightened: "收紧",
  loosen: "放松", announce: "宣布", announces: "宣布", announced: "宣布",
  plan: "计划", plans: "计划", consider: "考虑", considers: "考虑", considering: "考虑",
  debate: "讨论", debates: "讨论", sign: "签署", signs: "签署", signed: "签署",
  impose: "加征", imposes: "加征", imposed: "加征", levy: "征收", levies: "征收",
  extend: "延长", extends: "延长", suspend: "暂停", suspends: "暂停", bans: "禁止",
  strike: "打击", strikes: "打击", struck: "打击", threaten: "威胁", threatens: "威胁",
  escalate: "升级", escalates: "升级", cool: "降温", cools: "降温", heat: "升温", heats: "升温",
  stabilize: "企稳", stabilizes: "企稳", rebound: "反弹", rebounds: "反弹",
  recover: "复苏", recovers: "复苏", snap: "中断", snaps: "中断",
  dominate: "主导", dominates: "主导", dominated: "主导",
  lead: "领涨", leads: "领涨", led: "领涨", lag: "落后", lags: "落后",
  find: "寻找", finds: "寻找", became: "已成为", become: "成为",
  coming: "将至", cementing: "强化", cements: "强化", cement: "强化",
  end: "结束", ending: "结束",
  // 名词 / 形容词
  outlook: "前景", estimate: "预期", estimates: "预期",
  expectation: "预期", expectations: "预期",
  high: "高", higher: "走高", highest: "最高", low: "低", lower: "走低", lowest: "最低",
  hot: "高企", strong: "强劲", stronger: "更强", weak: "疲弱", weaker: "更弱",
  sharp: "大幅", sharply: "大幅", steep: "大幅", steeply: "大幅", modest: "温和",
  slight: "小幅", slightly: "小幅", record: "纪录", biggest: "最大", largest: "最大",
  fastest: "最快", worst: "最差", best: "最好", first: "首次",
  key: "关键", major: "主要", fresh: "新", new: "新", big: "大", small: "小",
  sudden: "突然", stable: "稳定", volatile: "波动", disorderly: "无序",
  catastrophic: "灾难性", solid: "稳健", soft: "疲软", robust: "强劲", sluggish: "低迷",
  sticky: "黏性", elevated: "高企", warning: "预警", warnings: "预警", spike: "跳升",
  problem: "问题", problems: "问题", crisis: "危机", turmoil: "动荡",
  fear: "担忧", fears: "担忧", concern: "担忧", concerns: "担忧", optimism: "乐观",
  opportunity: "机会", opportunities: "机会", everyday: "日常", item: "商品", items: "商品",
  entirely: "完全", completely: "完全", everyone: "市场普遍", everybody: "市场普遍",
  industry: "行业", industries: "行业", company: "企业", companies: "企业",
  // 时间
  week: "周", month: "月", quarter: "季度", year: "年", years: "年", months: "月", weeks: "周",
  today: "今日", tomorrow: "明日", yesterday: "昨日",
  // 连接与功能词
  amid: "，在…之际", as: "，因", while: "，同时", despite: "，尽管", although: "，尽管",
  however: "，但", but: "，但", and: "、", or: "或", if: "若", could: "或", would: "将",
  will: "将", may: "可能", might: "可能", must: "必须", not: "不", no: "无",
  because: "，因", after: "后", before: "前", since: "自", until: "直到",
  over: "，就", into: "，进入", still: "仍在",
  more: "更", most: "最", many: "多种", much: "大量", some: "部分", all: "全部",
  up: "上行", down: "下行", above: "高于", below: "低于", near: "接近", around: "约",
  toward: "逼近", towards: "逼近", past: "突破", per: "每",
};
// 保留原文的缩写 / 专有名词
var ZH_KEEP = { AI: 1, PPI: 1, CPI: 1, GDP: 1, IMF: 1, LME: 1, COMEX: 1, ETF: 1, OPEC: 1, IPO: 1, CNBC: 1, WSJ: 1 };
// 无实义功能词：直接丢弃（含被截断标题的残留）
var ZH_DROP = {
  the: 1, a: 1, an: 1, of: 1, in: 1, on: 1, for: 1, to: 1, at: 1, by: 1, with: 1, from: 1,
  into: 1, onto: 1, over: 1, under: 1, about: 1, than: 1, then: 1, there: 1, their: 1,
  theirs: 1, our: 1, ours: 1, we: 1, us: 1, you: 1, he: 1, she: 1, they: 1, them: 1,
  his: 1, her: 1, hers: 1, it: 1, its: 1, this: 1, that: 1, these: 1, those: 1,
  is: 1, are: 1, was: 1, were: 1, be: 1, been: 1, being: 1, am: 1, has: 1, have: 1, had: 1,
  do: 1, does: 1, did: 1, here: 1, what: 1, how: 1, why: 1, when: 1, where: 1, which: 1,
  who: 1, whom: 1, even: 1, too: 1, very: 1,
};
var P_ZH = "«";    // 短语译文保护头
var P_END = "»";   // 短语译文保护尾
var P_COMM = "§";  // 逗号（按两侧长度决定最终呈 、 或 ，）
var P_CLAUSE = "¶"; // 破折号 / 冒号 / 句号 → ，

function normTitle(t) {
  var s = String(t || "");
  s = s.replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ");
  s = s.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/\s*[|·\-–—]\s*(cnbc|marketwatch|wsj|reuters|bloomberg|forbes|yahoo|investing\.com|ap|afp|ft|nytimes)\s*$/i, "");
  s = s.replace(/^(analysis|opinion|exclusive|commentary|first look|watch|video|podcast|report)\s*[:：]\s*/i, "");
  s = s.replace(/\s*\.{2,}$/, "");
  s = s.replace(/\s*[.。]\s*$/, "");
  return s.trim();
}

// 说话人后置于句尾：", NY Fed says" → 前置「纽约联储表示，」
var SPEAKER_TAIL = /,\s*([A-Za-z][A-Za-z0-9'\.\- ]{1,30}?)\s+(says?|said|warns?|warned|reports?|reported|finds?|found)\s*$/i;

function wordToZh(w) {
  var s = String(w || "");
  if (!s) return "";
  if (ZH_KEEP[s]) return s;
  var low = s.toLowerCase();
  if (ZH_DROP[low]) return "";
  if (ZH_LEX_W[low]) return ZH_LEX_W[low];
  var tries = [];
  if (/ies$/i.test(low)) tries.push(low.replace(/ies$/i, "y"));
  if (/(ches|shes|sses|xes|zes)$/i.test(low)) tries.push(low.replace(/es$/i, ""));
  if (/ed$/i.test(low)) { tries.push(low.replace(/ed$/i, "")); tries.push(low.replace(/ed$/i, "e")); }
  if (/ing$/i.test(low)) { tries.push(low.replace(/ing$/i, "")); tries.push(low.replace(/ing$/i, "e")); }
  if (/ers$/i.test(low)) tries.push(low.replace(/ers$/i, ""));
  if (/ly$/i.test(low)) tries.push(low.replace(/ly$/i, ""));
  if (/s$/i.test(low) && !/ss$/i.test(low)) { tries.push(low.replace(/s$/i, "")); tries.push(low.replace(/es$/i, "")); }
  for (var i = 0; i < tries.length; i++) {
    if (ZH_LEX_W[tries[i]]) return ZH_LEX_W[tries[i]];
    if (ZH_DROP[tries[i]]) return "";
  }
  return "";
}

// 可见长度：短语保护符 «» 与空格不计
function visLen(x) { return String(x).replace(/[«»\s]/g, "").length; }

// 纯翻译（不做质量门禁），供整句与说话人片段共用
function zhTranslate(t) {
  for (var i = 0; i < ZH_LEX_P.length; i++) {
    var re = ZH_LEX_P[i][0], zh = ZH_LEX_P[i][1];
    t = t.replace(re, zhCall(zh));
  }
  var segs = t.split(/([A-Za-z][A-Za-z']*|\d[\d.,]*%?)/);
  var out = [];
  var total = 0, missing = 0;
  for (var k = 0; k < segs.length; k++) {
    var seg = segs[k];
    if (k % 2 === 1) {
      if (/^\d/.test(seg)) { out.push(seg); continue; }
      var base = seg.replace(/'s$/i, "").replace(/['’]+$/, "");
      var low = base.toLowerCase();
      if (!ZH_DROP[low]) total++;
      var zhw = wordToZh(base);
      if (!zhw && !ZH_DROP[low] && !ZH_KEEP[base]) missing++;
      out.push(zhw);
    } else {
      var s = seg;
      s = s.replace(/['"`]/g, "");
      s = s.replace(/\s*[-–—]\s*/g, P_CLAUSE);
      s = s.replace(/\s*[:;]\s*/g, P_CLAUSE);
      s = s.replace(/\s*,\s*/g, P_COMM);
      // 句间句点：后面跟「受保护短语」或大写开头的单词才算断句
      // （否则可能吃掉 U.S. 的点、小数点；句点后若是短语，得看同一段内后面的 «）
      s = s.replace(/\s*\.\s*(?=«)/g, P_CLAUSE);
      s = s.replace(/\s*\.\s*/g, /^[A-Z]/.test(segs[k + 1] || "") ? P_CLAUSE : "");
      s = s.replace(/\s+/g, "");
      out.push(s);
    }
  }
  var text = out.join("");
  // 逗号：两侧都短（列名式）用顿号，否则逗号；长度按「去掉保护符与空格后」的可见字符算
  var parts = text.split(P_COMM);
  if (parts.length > 1) {
    var buf = parts[0];
    for (var p = 1; p < parts.length; p++) {
      var pos = Math.max(buf.lastIndexOf("，"), buf.lastIndexOf("、"));
      var leftLen = visLen(buf.slice(pos + 1));
      var cut = parts[p].search(/[，、]/);
      var rightLen = visLen(cut < 0 ? parts[p] : parts[p].slice(0, cut));
      buf += leftLen <= 8 && rightLen <= 8 ? "、" : "，";
      buf += parts[p];
    }
    text = buf;
  }
  text = text.split(P_CLAUSE).join("，");
  text = text.split(P_ZH).join("").split(P_END).join("");
  text = text.replace(/[、，]{2,}/g, "，").replace(/^[、，.]+|[、，.]+$/g, "");
  text = text.replace(/[、，]([。！？])/g, "$1");
  // 中西文之间补空格，读起来不挤（标点后面不补）
  text = text.replace(/([\u4e00-\u9fa5])([A-Za-z0-9])/g, "$1 $2").replace(/([A-Za-z0-9%])([\u4e00-\u9fa5])/g, "$1 $2");
  text = text.replace(/\s+/g, " ").trim();
  zhTranslate.total = total;
  zhTranslate.missing = missing;
  return text;
}
function zhCall(zh) {
  return function () {
    var v = typeof zh === "function"
      ? zh(arguments[0], arguments[1], arguments[2], arguments[3])
      : zh;
    return v ? P_ZH + v + P_END : "";
  };
}

// 英文标题 → 中文事件概况（带质量门禁）
function zhGist(raw) {
  var t = normTitle(raw);
  if (!t) return "";
  // 1) 句尾说话人：", NY Fed says" → 前置「纽约联储表示，」
  var head = "";
  var m = t.match(SPEAKER_TAIL);
  if (m) {
    var w = zhTranslate(m[1].replace(/\s+/g, " ").trim());
    if (/[\u4e00-\u9fa5]/.test(w)) {
      head = w + (/warn/i.test(m[2]) ? "警告，" : "表示，");
      t = t.slice(0, m.index).replace(/[,\s]+$/, "");
    }
  }
  // 2) 正文翻译
  var text = zhTranslate(t);
  if (text) text = head + text;
  // 3) 质量门禁：没译出中文 / 太短 / 译不出来的词太多 → 判定不可用，交给调用方兜底
  if (!/[\u4e00-\u9fa5]/.test(text)) return "";
  var cn = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (cn < 6) return "";
  if (zhTranslate.total >= 4 && zhTranslate.missing / zhTranslate.total > 0.45) return "";
  return text;
}
// 英文源：先讲清「发生了什么」，再给对贵金属的结论；中文源：沿用原文概述
function zhSummary(t, desc, tags, cat) {
  const dir = impactOf(t);
  const dirZh = dir === "up" ? "利多，价格有望获得支撑" : dir === "down" ? "利空，价格面临压力" : "影响偏中性，方向待确认";
  const detail = stripText(desc || "");
  if (/[\u4e00-\u9fa5]/.test(detail)) {
    // 中文源：原文概述（截断到 90 字并去掉尾标点）
    return detail.slice(0, 90).replace(/[，。；、]+$/, "") + "。对贵金属影响：" + dirZh;
  }
  // 分类在卡片顶行已展示、关键词由顶部标签 chips 展示，摘要里都不再重复
  return (zhGist(t) || zhGistFallback(tags, cat)) + "。对贵金属影响：" + dirZh;
}
// 概况译不出来时（生僻标题）的兜底：至少告诉用户这条说的是哪个方向的事
function zhGistFallback(tags, cat) {
  const kw = ((tags || []).filter((x) => x !== "走强" && x !== "走弱")).slice(0, 3);
  return "外媒报道，" + (kw.length ? kw.join("、") : cat || "国际财经") + "方面出现新动向";
}
// 概况译不出来时（生僻标题）的兜底：至少告诉用户这条说的是哪个方向的事
function zhGistFallback(tags, cat) {
  const kw = ((tags || []).filter((x) => x !== "走强" && x !== "走弱")).slice(0, 3);
  return "外媒报道，" + (kw.length ? kw.join("、") : cat || "国际财经") + "方面出现新动向";
}
// 跨源合并：标题词集合 Jaccard 相似度
const STOP = new Set(["the", "a", "an", "of", "in", "on", "for", "to", "and", "or", "is", "are", "as", "at", "by", "with", "from", "its", "his", "their", "this", "that", "after", "before", "amid", "over", "into", "out", "new", "how", "what", "why", "here", "more", "says", "said"]);
function tokSet(t) {
  return new Set(t.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5 ]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w)));
}
function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
}
function authorityOf(sourceName) {
  return /WSJ/i.test(sourceName) ? 2 : 1; // WSJ 优先于 CNBC
}
async function fetchNewsAll() {
  var out = [];
  var health = [];
  var now = Date.now();
  var results = await Promise.all(FEEDS.map((f) =>
    fetch(f.url, { headers: { "User-Agent": "Mozilla/5.0" } })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("http " + r.status))))
      .then((t) => ({ f, t }))
      .catch(() => null)
  ));
  for (const r of results) {
    const f = r && r.f;
    if (!r) {
      health.push({ name: f ? f.name : "未知源", ok: false, items: 0, latest: null, ageDays: null, stale: true });
      continue;
    }
    const items = parseRSS(r.t).slice(0, 30);
    // 源新鲜度：以最新一条 pubDate 计
    let latestTs = 0;
    for (const it of items) { const ts = Date.parse(it.pub || ""); if (!isNaN(ts) && ts > latestTs) latestTs = ts; }
    const ageDays = latestTs ? (now - latestTs) / 86400000 : 9999;
    const stale = ageDays > FEED_STALE_DAYS;
    health.push({
      name: f.name, ok: true, items: items.length,
      latest: latestTs ? new Date(latestTs).toISOString() : null,
      ageDays: Math.round(ageDays * 10) / 10, stale,
    });
    if (stale) {
      console.warn(`[news] 源停更超过 ${FEED_STALE_DAYS} 天，跳过：${f.name}（最新 ${latestTs ? new Date(latestTs).toISOString().slice(0, 10) : "无"}，${Math.round(ageDays)} 天前）`);
      continue;
    }
    for (const it of items) {
      const metals = routeMetal(it.title);
      if (!metals.length) continue;
      const pubTs = Date.parse(it.pub || "");
      for (const m of metals) {
        out.push({
          metal: m,
          date: dateFromUrl(it.link) || isoDate(it.pub),
          title: it.title.slice(0, 90),
          desc: it.desc,
          impact: impactOf(it.title),
          category: catOf(it.title),
          source: r.f.name,
          url: it.link || "",
          pubTs: isNaN(pubTs) ? 0 : pubTs,
        });
      }
    }
  }
  return { items: out, sources: health };
}
function readSeed() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "events.seed.json"), "utf-8")); }
  catch (e) { return null; }
}
// 合并：种子大事记（补中文标签）+ 已自动归纳的历史条目 + 本次新抓取（跨源合并去重）-> events.json
async function buildEvents() {
  const METALS_ARR = ["gold", "silver", "copper"];
  const base = readSeed() || { gold: [], silver: [], copper: [] };
  const res = {};
  const seen = {};
  // 全品种正本标题集合：跨品种去重后正本集中在某品种（宏观事件多在 gold），
  // 若只按各品种数组建 seen，别的品种的正本标题挡不住「旧文在 RSS 滚动窗口里重现」，
  // 会反复重抓、反复跨品种合并（added 虚高、白跑）。全品种 seen 一次挡掉。
  const seenAll = new Set();
  for (const m of METALS_ARR) {
    // 种子条目本身就是中文，补充关键标签
    res[m] = (base[m] || []).map((e) => Object.assign({}, e, { tags: e.tags || zhTags(e.title) }));
    seen[m] = new Set(res[m].map((e) => e.title));
    res[m].forEach((e) => seenAll.add(e.title));
  }
  let cur = null;
  try { cur = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "events.json"), "utf-8")); } catch (e) {}
  // 保留此前自动归纳过的中文条目（旧英文条目弃用，避免中英文重复）
  // 清洗：去掉历史条目摘要里的【分类】前缀（分类在事件卡片顶行已展示，避免重复）
  const stripCatPrefix = (s) => String(s || "").replace(/^【[^】]{1,12}】\s*/, "");
  for (const m of METALS_ARR) {
    for (const e of (cur && cur[m]) || []) {
      seenAll.add(e.title);
      if (e && e.auto && e.title && /[\u4e00-\u9fa5]/.test(e.title) && !seen[m].has(e.title)) {
        if (e.summary) e.summary = stripCatPrefix(e.summary);
        // 摘要升版（C12）：旧条目只有「对贵金属影响：…」一句结论，看不出发生了什么。
        // 英文源条目入库时都存了 origTitle（英文原标题），据此离线重算出事件概况，
        // 不必等下一次抓源——云端库里的存量条目也靠这条自愈到新版格式。
        if (e.origTitle && e.summary && e.summary.indexOf("。对贵金属影响：") < 0) {
          e.summary = zhSummary(e.origTitle, "", e.tags, e.category);
        }
        // 【C19】存量条目的日期回填：历史条目是用旧口径（本地时区）算出来的日期，
        //   一旦入库就被原样沿用 → 日期会一直停在错误那天（实测 CNBC 文章被记成 URL 日期 +1 天，
        //   且随抓取时刻在 10-28/10-29 之间漂移）。这里按 URL 发布路径回填，跨机器确定。
        if (e.url) {
          const dfix = dateFromUrl(e.url);
          if (dfix) e.date = dfix;
        }
        res[m].push(e); seen[m].add(e.title);
      }
    }
  }
  // 抓取全网重大信息（带源健康度：停更超过 7 天的源自动跳过，旧闻不入库）
  var newsRes = await fetchNewsAll().catch(() => ({ items: [], sources: [] }));
  var news = newsRes.items || [];
  var newsSources = newsRes.sources || [];
  var fetchedAt = new Date().toISOString();
  // 按品种分组 -> 跨源聚类（Jaccard≥0.5 视为同一事件）-> 保留权威出处
  let added = 0;
  for (const m of METALS_ARR) {
    const items = news.filter((n) => n.metal === m);
    const clusters = [];
    for (const n of items) {
      const toks = tokSet(n.title);
      let hit = null;
      for (const cl of clusters) { if (jaccard(toks, cl.toks) >= 0.5) { hit = cl; break; } }
      if (hit) { hit.items.push(n); for (const x of toks) hit.toks.add(x); }
      else clusters.push({ toks, items: [n] });
    }
    for (const cl of clusters) {
      cl.items.sort((a, b) => authorityOf(b.source) - authorityOf(a.source));
      const rep = cl.items[0]; // 权威出处（WSJ 优先）
      const tags = zhTags(rep.title);
      const cat = catOf(rep.title);
      const title = zhTitle(rep.title, tags);
      if (seen[m].has(title) || seenAll.has(title)) continue;
      seen[m].add(title);
      seenAll.add(title);
      res[m].push({
        date: rep.date,
        title,
        impact: impactOf(rep.title),
        category: cat,
        source: "自动归纳 · " + Array.from(new Set(cl.items.map((i) => i.source))).join(" / "),
        summary: zhSummary(rep.title, rep.desc, tags, cat),
        url: rep.url || "",
        origTitle: rep.title,
        tags,
        auto: true,
        fetchedAt, // 入库时间（与事件发生日 date 分开，用于展示「事件更新至…」）
      });
      added++;
    }
  }
  // ---- 清洗 · 去重（入库前最后一道闸） ----
  // 1) 品种内去重（P1 标题指纹 / P2 摘要指纹 / P3 同日标题互含 / P4 近日期近义 / P5 同日高度近义）
  const dedupStat = {};
  for (const m of METALS_ARR) {
    const r = ED.dedupeEvents(res[m], { residual: false });
    dedupStat[m] = r.dropped.length;
    if (r.dropped.length) {
      r.dropped.slice(0, 5).forEach((d) => console.log(`[dedupe] ${m} 剔除 [${d.reason}] 《${d.item.title}》 → 已有《${d.keeper}》`));
    }
    res[m] = r.list;
  }
  // 2) 跨品种去重：同一条宏观事件只留一份正本，用 metals[] 记录影响品种
  const xr = ED.dedupeCrossMetal(res, { order: METALS_ARR });
  for (const m of METALS_ARR) res[m] = xr.map[m];
  const dedupTotal = METALS_ARR.reduce((n, m) => n + dedupStat[m], 0);
  if (dedupTotal || xr.merged) {
    console.log(`[dedupe] 品种内剔除 ${dedupTotal} 条，跨品种合并 ${xr.merged} 条副本`);
  }

  for (const m of METALS_ARR) {
    res[m].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    res[m] = res[m].slice(0, 80);
  }
  // 事件数据元信息（独立文件，与价格 meta.json 分开：分数据展示各自更新时间）
  const eventsMeta = {
    updatedAt: fetchedAt,
    count: METALS_ARR.reduce((n, m) => n + res[m].length, 0),
    byMetal: { gold: res.gold.length, silver: res.silver.length, copper: res.copper.length },
    latestEventDate: METALS_ARR.reduce((mx, m) => {
      const d = res[m].length ? res[m][0].date : "";
      return d > mx ? d : mx; // 日期是 YYYY-MM-DD 字符串，直接字典序比较（Math.max 会得到 NaN）
    }, ""),
    addedThisRun: added,
    newsTotal: news.length,
    sources: newsSources,
  };
  // 校验：任一品种不合格则不落盘、不发布，保留上一版已发布事件（与价格数据同门禁）
  const verr = validateEvents(res);
  if (verr.length) {
    console.warn("[events] 校验未通过，保留上一版已发布事件：" + verr.slice(0, 3).join(" | "));
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "events.json"), "utf-8")); } catch (e) {}
    if (prev) return { events: prev, newsTotal: news.length, added: 0, ok: false, reason: verr, sources: newsSources };
    // 连上一版都没有：只发布通过校验的品种，剔除不合格条目后重校验
    for (const m of METALS_ARR) res[m] = (res[m] || []).filter(isEventValid);
    const verr2 = validateEvents(res);
    if (verr2.length) return { events: { gold: [], silver: [], copper: [] }, newsTotal: news.length, added: 0, ok: false, reason: verr2, sources: newsSources };
    writeJSON("events.json", res);
    writeJSON("events.meta.json", eventsMeta);
    return { events: res, newsTotal: news.length, added: 0, ok: true, reason: [], sources: newsSources };
  }
  writeJSON("events.json", res);
  writeJSON("events.meta.json", eventsMeta);
  return { events: res, newsTotal: news.length, added, ok: true, reason: [], sources: newsSources };
}

// ---------- 事件数据校验（真实性门禁） ----------
const EVENT_CATS = ["地缘政治", "货币政策", "供需", "市场"];
const EVENT_IMPACTS = ["up", "down", "mixed", "neutral"];
function isEventValid(e) {
  if (!e || typeof e !== "object") return false;
  if (!e.date || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) return false;
  if (e.date > new Date().toISOString().slice(0, 10)) return false; // 不允许未来日期
  if (!e.title || !String(e.title).trim()) return false;
  if (EVENT_CATS.indexOf(e.category) < 0) return false;
  if (EVENT_IMPACTS.indexOf(e.impact) < 0) return false;
  if (!e.source || !String(e.source).trim()) return false;
  if (e.url && !/^https?:\/\//i.test(e.url)) return false;
  if (e.summary && e.summary.length > 300) return false;
  return true;
}
function validateEvents(res) {
  const errs = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const m of ["gold", "silver", "copper"]) {
    const arr = (res && res[m]) || [];
    if (!arr.length) { errs.push(m + ":事件为空"); continue; }
    if (arr.length > 80) errs.push(m + ":超过80条");
    const seen = new Set();
    let prev = "9999-99-99";
    for (const e of arr) {
      if (!isEventValid(e)) { errs.push(m + ":条目不合格 " + JSON.stringify(String(e && e.title)).slice(0, 40)); continue; }
      if (e.date > today) errs.push(m + ":未来日期 " + e.date);
      // 同题不同天是合法独立事件（连续报道），只有「同日期同标题」才算重复
      const dupKey = e.title + "@" + e.date;
      if (seen.has(dupKey)) errs.push(m + ":标题重复 " + String(e.title).slice(0, 30));
      seen.add(dupKey);
      if (e.date > prev) errs.push(m + ":日期未按倒序 " + e.date);
      prev = e.date;
    }
  }
  // 跨品种重复门禁：合并视图（小程序/手机网页）不允许同一事件出现多次
  const all = ED.eventsAll(res, { dedupe: false });
  const xd = ED.findDuplicates(all, { strict: true });
  if (xd.length) {
    errs.push("跨品种重复 " + xd.length + " 组，例：" + xd[0].items[0] + " ≈ " + xd[0].keeper);
  }
  // 影响品种字段完整性：缺失会导致按品种查看丢事件
  for (const m of ["gold", "silver", "copper"]) {
    const bad = ((res && res[m]) || []).filter((e) => !Array.isArray(e.metals) || !e.metals.length).length;
    if (bad) errs.push(m + ":缺 metals 字段 " + bad + " 条");
  }
  return errs;
}

module.exports = { generateAll, fetchSpotAll, buildEvents, zhGist, zhSummary };
if (require.main === module) generateAll().then((r) => console.log("done", r)).catch((e) => { console.error(e); process.exit(1); });
