// server.js —— 贵金属报价监测 · 云端后端（唯一真源 + 可靠生成器）
// ------------------------------------------------------------------
// 【C18 架构定调】本服务 = 唯一真源 + 生成器，24h 在线、setInterval 可靠（不再依赖 GitHub Actions 的定时任务，
//   后者对低活跃仓库严重延迟，曾导致三端卡死 09:14 达 50+ 分钟）。
//
// 数据生成：每 15 分钟在本地 spawn `node generate.js`（同一仓库，自包含、无外部 API key，
//   价格走东财/新浪/现货，事件走 RSS + 规则模板总结），落盘到 data/*.json 后由本服务对外 serve。
// 三端统一读本服务：
//   · PC 网页          → 同域 /api/
//   · 手机网页(GH Pages)→ 浏览器跨域读本服务 /api/（CORS 已开，非微信 UA）
//   · 微信小程序       → 云函数 → 本服务 /api/bundle（Node UA，绕开微信 UA 网关拦截）
//
// 健壮性：本地生成失败时，回退代理 GitHub Pages 真源（其仍由 Actions 不定期刷新）；
//   若配置了 GH_TOKEN 环境变量，还会主动触发 Actions 刷新，让 GH Pages 也保持新鲜。
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DATA = path.join(ROOT, "data");
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

const FILES = ["gold.json", "silver.json", "copper.json", "meta.json", "events.json", "events.meta.json"];
const GEN_INTERVAL_MS = 15 * 60 * 1000;   // 与数据发布节奏一致：每 15 分钟同步一次真源
// 【C43·根治牵一发而动全身】拉真源的分档超时：
//   探针（meta.json，2.5KB）8s —— 只为快速判断「哪个镜像通」；
//   正文文件 25s —— events.json 约 180KB，慢链路要给足；
//   整轮同步硬预算 150s —— 无论如何必须 settle，绝不允许无限挂起。
const PROBE_TIMEOUT_MS = 8000;
const FILE_TIMEOUT_MS = 25000;
const SYNC_BUDGET_MS = 150000;

// ------------------------------------------------------------------
// 【C43】真源镜像池：按顺序探测，取「最新的一个」为准。
//   GH Pages   —— Actions 直推的主出口（权威、CDN 缓存最短）
//   jsDelivr   —— GitHub 公共 CDN 的第二出口（main 分支同一份 data/，已实测同新鲜度）
//   raw        —— 第三出口（raw.githubusercontent）
//   单一出口被墙 / 黑洞 / CDN 回退到陈旧副本，都不再拖垮整条链路。
// ------------------------------------------------------------------
const CANON_MIRRORS = [
  { name: "gh-pages", base: "https://zsyong2026.github.io/metal-price-monitor/data" },
  { name: "jsdelivr", base: "https://cdn.jsdelivr.net/gh/zsyong2026/metal-price-monitor@main/data" },
  { name: "raw-gh", base: "https://raw.githubusercontent.com/zsyong2026/metal-price-monitor/main/data" },
];

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".map": "application/json",
};

// 内存缓存：{ file -> { body, at, updatedAt } }，生成完成后整体刷新
const cache = {};
let lastGenAt = 0;
let lastGenOk = false;
let lastError = "";
// 【C43】镜像池探测结果（替代 C19 的「平台主动推送 GH Pages」语义）：
//   平台现在是纯只读代理，mirror 表示「本轮从哪个真源镜像取到了数据」。
let mirror = { ok: false, at: 0, error: "", commit: "", ms: 0, credState: "" };
// 【C43】真源可达性状态（替代 C24 的 PAT 预检）：
//   平台不再持 PAT、不再推送，故不再需要凭据预检；改为如实汇报镜像池可达性。
let cred = { state: "unknown", detail: "" };

// ------------------------------------------------------------------
// 【C43·删除】C19 时代的「平台直推 GH Pages」整条链路：
//   ghToken() / checkCredential() / ghApi() / pushMirror() / triggerActions()
//
//   为什么必须删干净（不是「留着不用」）：
//   ① 这套代码是「一处抖动 → 全链路污染」的**闭环开关**。平台拿 PAT 直推 GH Pages，
//      一旦平台自己算出了偏差数据（沙箱网络受限），就会把坏数据反推成「真源」，
//      污染所有读 GH Pages 的设备（手机网页 / 已发布小程序 / PC 兜底）——
//      这正是「不能报一次问题，牵一发而动全身」最恶劣的一种形态：真源被污染后，
//      连「回退到真源」这条退路都没了。
//   ② 现在真源唯一写入者是 GitHub Actions（permissions: contents: write + 自动 GITHUB_TOKEN），
//      平台不再需要任何 PAT。留着这段代码，就留着把平台重新接回「写入真源」通路的能力。
//   ③ GitHub PAT 是长期凭据，平台沙箱持有它就等于持有「改真源」的钥匙；
//      纯只读代理不该持有写凭据。删除后平台只需 .env 里的 token 做只读镜像访问，
//      且 mirror/cred 字段语义改为如实汇报「镜像池可达性」。
//
//   保留的只有 ghToken() —— 它现在仅用于从 .env 读 token 以便（若需要）做只读镜像请求；
//   平台不会用它做任何写操作。
// ------------------------------------------------------------------
function ghToken() {
  if (process.env.GH_TOKEN) return String(process.env.GH_TOKEN).trim();
  try {
    const p = path.join(ROOT, ".env");
    if (fs.existsSync(p)) {
      const m = fs.readFileSync(p, "utf-8").match(/^\s*GH_TOKEN\s*=\s*(\S+)\s*$/m);
      if (m) return String(m[1]).trim().replace(/^["']|["']$/g, "");
    }
  } catch (e) { /* ignore */ }
  return "";
}

function filePath(f) { return path.join(DATA, f); }

function readDisk(f) {
  try {
    const body = fs.readFileSync(filePath(f), "utf-8");
    return { body, updatedAt: updatedAtOf(f, body) };
  } catch (e) { return null; }
}

function updatedAtOf(f, body) {
  try {
    const j = JSON.parse(body);
    if (f === "events.meta.json") return j.updatedAt || "";
    // 价格文件（gold/silver/copper.json）用 lastUpdate 字段标识数据入库时间；meta.json 用 generatedAt
    if (/^(gold|silver|copper)\.json$/.test(f)) return j.lastUpdate || j.generatedAt || (j.meta && j.meta.generatedAt) || "";
    return j.generatedAt || (j.meta && j.meta.generatedAt) || "";
  } catch (e) { return ""; }
}

// JSON 合法性校验：防止读取到 generate.js 写盘瞬间的半截文件
function safeParse(body) {
  try { return JSON.parse(body); } catch (e) { return null; }
}

// 【C43·删除】本地生成器 generateLocal() —— 平台已彻底转为纯只读代理。
//   它是本次事故的「污染源」：真源拉取一旦失败就退化为本地生成，
//   用沙箱受限网络下的残缺数据覆盖磁盘好数据，再经 pushMirror 反推 GH Pages，
//   形成「一处抖动 → 全链路污染」的闭环。保留即保留引信，故整段移除。

// ------------------------------------------------------------------
// 【C43·根治「牵一发而动全身」】取真源：多镜像 + 硬超时 + 新鲜度守卫
//
// 【事故复盘 · 本次线上告警的真实根因】
//   旧实现用 https.get(url, { timeout }) 拉 GH Pages。Node 的这个 timeout
//   **只约束 socket 的空闲时间，不覆盖 DNS 解析与 TCP 建连**。
//   平台沙箱出网对部分域名是「黑洞丢包」：连接既不建立也不返回错误，
//   于是既不触发 'timeout' 也不触发 'error' → Promise 永不 settle →
//   Promise.all 永不 resolve → syncFromPages() 永不返回 →
//   refresh() 走不到任何赋值语句 → /api/health 里
//   lastGenOk / lastError / mirror.at / credential.state **四个状态量同时停在初始值**
//   （这正是本次事故的判定指纹）→ 平台只能吐出部署时烘焙的旧快照 →
//   check_platform 每轮判「平台落后真源」→ 告警风暴。
//
// 【三层修复】
//   ① 硬超时：自建 setTimeout 主动 destroy 请求，覆盖 DNS+建连+响应全过程，
//      保证「任何情况下 Promise 必定 settle」。
//   ② 多镜像：GH Pages / jsDelivr / raw 三路探针取最新一路，单一出口故障不再拖垮全局。
//   ③ 新鲜度守卫：只接受不比现有缓存更旧的数据，CDN 回退到陈旧副本也不会把好数据顶掉。
// ------------------------------------------------------------------

// 单次 HTTP GET（文本）。自带覆盖 DNS/建连/响应的硬超时，绝不无限挂起。
function httpGetText(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try { if (req) req.destroy(); } catch (e) { /* ignore */ }
      done(null);
    }, timeoutMs);
    try {
      req = https.get(url, { headers: { "User-Agent": "metals-canon/1.0" } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); done(null); return; }
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (c) => { body += c; });
        res.on("end", () => done(body || null));
        res.on("error", () => done(null));
      });
      req.on("error", () => done(null));
      req.on("timeout", () => { try { req.destroy(); } catch (e) { /* ignore */ } done(null); });
    } catch (e) {
      done(null);
    }
  });
}

// 探测各镜像的可用性与新鲜度（meta.json 仅 2.5KB，8s 足够）
async function probeMirrors() {
  const probes = await Promise.all(CANON_MIRRORS.map(async (m) => {
    const body = await httpGetText(m.base + "/meta.json?_ts=" + Date.now(), PROBE_TIMEOUT_MS);
    if (!body) return { name: m.name, base: m.base, ok: false, generatedAt: "" };
    const j = safeParse(body);
    return { name: m.name, base: m.base, ok: !!j, generatedAt: (j && j.generatedAt) || "" };
  }));
  // 可用的按新鲜度倒序；同新鲜度时保持声明顺序（GH Pages 优先）
  probes.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    if (a.ok && a.generatedAt !== b.generatedAt) return a.generatedAt < b.generatedAt ? 1 : -1;
    return CANON_MIRRORS.findIndex((m) => m.name === a.name) - CANON_MIRRORS.findIndex((m) => m.name === b.name);
  });
  return probes;
}

// 从镜像池取单个文件：按探针顺序逐个尝试，任一成功即返回
async function fetchFromMirrors(file, probes) {
  for (const p of probes) {
    if (!p.ok) continue;
    const body = await httpGetText(p.base + "/" + file + "?_ts=" + Date.now(), FILE_TIMEOUT_MS);
    if (body && safeParse(body)) return { body, source: p.name };
  }
  return { body: null, source: "" };
}

// 【C43·删除】triggerActions() —— 平台主动 dispatch 刷新 Actions 的能力。
//   真源刷新节奏由 Actions 自己的 schedule 决定（实测约每小时一轮），
//   平台再去 dispatch 只会与 schedule 撞车、放大 Actions 排队（实测曾出现
//   一次 push 触发 4 个 pages build、3 个被取消的噪音）。
//   平台职责收敛为「只读真源 + 托管站点 + 如实健康上报」，不再有写/调度真源的能力。

// 【C37 架构调整】数据真源改由 GitHub Actions 生成（东财/新浪实时均可达）并推送 GH Pages；
// 平台沙箱网络受限（东财被墙、hq.sinajs.cn 被墙），自身无法产出当日实时国内价，
// 故平台退化为「只读真实数据 + 托管站点 + 健康上报」，不再本地生成/推送 data/
// （避免用受限网络下的陈旧/偏差数据覆盖 Actions 产出的真源）。
//
// 【C43】refresh 自愈化：
//   ① 全局硬预算：即便内层逻辑再出意外，整轮也必须在 SYNC_BUDGET_MS 内 settle，
//      绝不让 Promise 悬空（悬空 = 状态量停在初始值 = 平台只吐旧快照）。
//   ② 串行调度：上一轮没结束就不开下一轮（setInterval 会堆积任务）。
//   ③ 失败退避重试：失败后 60s 重试（而不是干等 15 分钟），成功则回到正常节奏。
async function refresh() {
  const t0 = Date.now();
  let ok = false;
  try {
    // 硬预算兜底：任何异常/挂起都在此收敛
    ok = await Promise.race([
      syncFromPages(),
      new Promise((resolve) => setTimeout(() => resolve(false), SYNC_BUDGET_MS)),
    ]);
  } catch (e) {
    ok = false;
    lastError = "真源同步异常：" + ((e && e.message) || String(e));
    console.warn("[refresh] " + lastError);
  }
  if (ok) {
    lastGenOk = true;
    lastError = "（只读真源镜像池，由 GitHub Actions 每轮生成）";
    return true;
  }
  // 【C42 彻底修复·牵一发不动全身】真源同步失败：平台沙箱网络受限，本地生成无法获取
  //   实时行情（东财/新浪被墙），若退化为 generateLocal() 反而会用陈旧/偏差数据覆盖缓存、
  //   乃至 pushMirror 反推 GH Pages，造成连环污染（实测 events.json 曾因此被覆盖成残缺/旧数据而 404）。
  //   故同步失败时，平台只如实标记 lastGenOk=false 并继续服务「上一轮成功缓存 / 部署快照」，
  //   绝不本地生成。真源由 GitHub Actions 维护并直推 GH Pages，平台保持纯只读代理。
  lastGenOk = false;
  lastError = lastError || "真源同步失败（平台仅只读，不本地生成）";
  console.warn("[refresh] 真源同步失败，平台仅服务上一轮缓存/部署快照（不本地生成），耗时 " + (Date.now() - t0) + "ms");
  return false;
}

// 【C43】自愈调度器：串行执行 + 失败退避重试。
//   取代原来的 setInterval(refresh, 15min)——后者在 refresh 挂起时会不断堆积新任务，
//   既是本次事故的放大器，也是修复后仍可能残留的隐患。
const RETRY_DELAY_MS = 60 * 1000;
let refreshTimer = null;
function scheduleRefresh(delayMs) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    const ok = await refresh();
    scheduleRefresh(ok ? GEN_INTERVAL_MS : RETRY_DELAY_MS);
  }, delayMs);
}

// 核心四件套（价格 + 元信息）：缺失任一份都视为真源不可用，必须阻塞并告警。
// 可选事件类（events.json / events.meta.json）：任一份瞬时失败 → 沿用上一轮缓存、不阻塞核心。
// 【C42 根治「牵一发而动全身」】此前 syncFromPages 是「全有或全无」——
//   只要 events.json 一次抖动（瞬间 404/超时），整轮同步被拒，平台死抱部署时的旧磁盘快照，
//   全平台吐出 15h 旧价、check_platform 误报、所有读平台的设备看到旧价。
//   改为核心齐备即接受、事件类失败仅保留旧缓存，把单点抖动隔离在「事件」局部。
const CORE_FILES = ["gold.json", "silver.json", "copper.json", "meta.json"];
const OPTIONAL_FILES = ["events.json", "events.meta.json"];

// 【C43】新鲜度守卫：只接受不比现有缓存更旧的数据。
//   CDN 偶发回退到陈旧副本时，若无条件覆盖，好数据会被旧数据顶掉（另一种「牵一发而动全身」）。
function isNotOlder(newTs, oldTs) {
  if (!newTs) return true;              // 新数据没有时间戳 → 不做判断（交给其它校验）
  if (!oldTs) return true;
  const a = Date.parse(newTs), b = Date.parse(oldTs);
  if (isNaN(a) || isNaN(b)) return true;
  return a >= b;
}

// 从真源镜像池同步数据到本地缓存（平台只读，不写回 data/）
async function syncFromPages() {
  const t0 = Date.now();
  const probes = await probeMirrors();
  const usable = probes.filter((p) => p.ok);
  mirror = {
    ok: usable.length > 0,
    at: Date.now(),
    error: usable.length ? "" : "全部镜像不可达",
    commit: usable.length ? ("(" + usable.map((p) => p.name).join(",") + ")") : "",
    ms: Date.now() - t0,
    credState: "",
  };
  cred = {
    state: usable.length ? "ok" : "network",
    detail: usable.length
      ? ("真源镜像可用：" + usable.map((p) => p.name + "@" + (p.generatedAt || "?")).join(" | "))
      : "三路真源镜像（GH Pages / jsDelivr / raw）全部不可达",
  };
  if (!usable.length) {
    lastError = "真源镜像池全部不可达（GH Pages / jsDelivr / raw）";
    console.warn("[sync] " + lastError);
    return false;
  }

  const all = CORE_FILES.concat(OPTIONAL_FILES);
  // 每个文件独立取，任一失败只影响该文件；整轮受硬预算约束，必定 settle
  const results = await Promise.all(all.map((f) => fetchFromMirrors(f, usable)));
  const next = {};
  let coreOk = 0;
  for (let i = 0; i < all.length; i++) {
    const f = all[i];
    const r = results[i];
    if (!r || !r.body || !safeParse(r.body)) continue;
    const oldTs = (cache[f] && cache[f].updatedAt) || (readDisk(f) || {}).updatedAt || "";
    const newTs = updatedAtOf(f, r.body);
    if (!isNotOlder(newTs, oldTs)) {
      console.warn("[sync] " + f + " 新数据比现有缓存更旧（" + newTs + " < " + oldTs + "），保留现有缓存");
      continue;
    }
    next[f] = r.body;
    if (CORE_FILES.indexOf(f) >= 0) coreOk++;
  }
  if (coreOk < CORE_FILES.length) {
    lastError = "真源核心数据缺失（" + coreOk + "/" + CORE_FILES.length + "），镜像：" +
      usable.map((p) => p.name).join(",");
    console.warn("[sync] " + lastError);
    return false;
  }
  // 核心齐备即接受：事件类可选文件若本次未取到，沿用上一轮缓存（不阻塞核心数据）
  let kept = 0;
  for (const f of all) {
    if (next[f]) {
      cache[f] = { body: next[f], at: Date.now(), updatedAt: updatedAtOf(f, next[f]) };
    } else {
      kept++;
      console.warn("[sync] 文件 " + f + " 本次未取到，沿用上一轮缓存（不阻塞核心数据）");
    }
  }
  lastGenAt = Date.now();
  console.log("[sync] 已从真源镜像池同步核心 " + coreOk + "/" + CORE_FILES.length +
    "，可选沿用缓存 " + kept + "/" + OPTIONAL_FILES.length +
    "，来源 " + usable.map((p) => p.name).join(",") +
    "，耗时 " + (Date.now() - t0) + "ms");
  return true;
}

function getBody(f) {
  const c = cache[f];
  if (c && c.body && safeParse(c.body)) return c;
  const d = readDisk(f);
  if (d && safeParse(d.body)) return d;
  return null;
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(obj));
}
function sendBody(res, body) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  const safe = path.normalize(path.join(ROOT, rel));
  if (!safe.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.stat(safe, (err, st) => {
    if (!err && st.isFile()) {
      const ext = path.extname(safe).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      fs.createReadStream(safe).pipe(res);
    } else {
      if (req.method === "GET") {
        const idx = path.join(ROOT, "index.html");
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        fs.createReadStream(idx).pipe(res);
      } else { res.writeHead(404); res.end("not found"); }
    }
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;

  if (p.startsWith("/data/") && FILES.indexOf(p.slice(6)) >= 0) {
    const item = getBody(p.slice(6));
    if (!item) { sendJSON(res, 404, { error: "canonical unavailable" }); return; }
    sendBody(res, item.body);
    return;
  }

  if (p.startsWith("/api/")) {
    const apiFile = (f) => { const item = getBody(f); if (!item) { sendJSON(res, 404, { error: "no data" }); return null; } return item; };
    if (/^\/api\/data\/(gold|silver|copper)$/.test(p)) {
      const item = apiFile(p.split("/").pop() + ".json"); if (item) sendBody(res, item.body);
      return;
    }
    if (p === "/api/events") { const item = apiFile("events.json"); if (item) sendBody(res, item.body); return; }
    if (p === "/api/events-meta") { const item = apiFile("events.meta.json"); if (item) sendBody(res, item.body); return; }
    if (p === "/api/meta") { const item = apiFile("meta.json"); if (item) sendBody(res, item.body); return; }
    if (p === "/api/health") {
      const ts = {};
      for (const f of FILES) ts[f] = (cache[f] && cache[f].updatedAt) || (readDisk(f) || {}).updatedAt || "";
      // 【C43】events.json 本身无时间戳（只有 gold/silver/copper 三个数组），
      //   但它与 events.meta.json 出自同一轮 Actions 生成，故回退用后者的 updatedAt，
      //   否则健康面板上事件永远显示空值，看不出事件数据到底新不新。
      if (!ts["events.json"]) ts["events.json"] = ts["events.meta.json"] || "";
      sendJSON(res, 200, {
        ok: true, role: "readonly-proxy", generatedAt: lastGenAt ? new Date(lastGenAt).toISOString() : null,
        // 【C43】字段语义澄清：lastGenOk 现在表示「最近一轮真源同步是否成功」，
        //   lastError 为最近一次失败原因（空串 = 当前无异常）。
        //   C37 之前这两个字段表示「平台本地生成器」状态，平台已纯只读，故语义已变但字段名保留
        //   （外部巡检脚本与自测用例仍在读它们）。
        lastGenOk, lastError, updatedAt: ts,
        // 【C43】真源镜像池探测结果（替代 C19 的「平台推送 GH Pages」语义）：
        //   commit 字段现在承载「本轮命中了哪些镜像」，hasToken 保留但仅表示 token 存在性。
        source: {
          mirrors: mirror.commit ? mirror.commit.replace(/[()]/g, "").split(",").filter(Boolean) : [],
          ok: mirror.ok, at: mirror.at ? new Date(mirror.at).toISOString() : null,
          ms: mirror.ms, error: mirror.error,
          hasToken: !!ghToken(),
        },
        // 保留旧字段形状，避免外部消费方（含自测）因结构变化而失效
        mirror: {
          ok: mirror.ok, at: mirror.at ? new Date(mirror.at).toISOString() : null,
          commit: mirror.commit, ms: mirror.ms, error: mirror.error,
          hasToken: !!ghToken(), credState: mirror.credState || "",
        },
        // 【C43】真源可达性（替代 C24 的 PAT 预检语义）
        credential: { state: cred.state, detail: cred.detail },
      });
      return;
    }
    // 聚合包：一次请求返回全部 6 份（云函数 timeout 仅 3 秒，聚合成一次即可）
    if (p === "/api/bundle") {
      const out = {};
      const missing = [];
      for (const f of FILES) {
        const item = getBody(f);
        if (!item) { missing.push(f); continue; }
        const j = safeParse(item.body);
        if (!j) { missing.push(f); continue; }
        out[f] = j;
      }
      if (missing.length) { sendJSON(res, 503, { error: "bundle incomplete", missing }); return; }
      sendJSON(res, 200, { files: out });
      return;
    }
    res.writeHead(404); res.end("api not found");
    return;
  }
  serveStatic(req, res, p);
});

// 启动：先读磁盘快照（冷启动即可用），随后立即同步一轮真源，并按自愈调度器持续同步。
// 【C43】不再用 setInterval(refresh, 15min)：那会在 refresh 挂起时无限堆积任务。
//   改为「上一轮结束再排下一轮」，失败 60s 后重试（而不是干等 15 分钟），
//   成功则回到 15 分钟节奏 —— 平台从「一挂就永久僵死」变成「失败即自愈」。
(function boot() {
  for (const f of FILES) {
    const d = readDisk(f);
    if (d) cache[f] = { body: d.body, at: 0, updatedAt: d.updatedAt };
  }
  (async () => {
    const ok = await refresh();
    scheduleRefresh(ok ? GEN_INTERVAL_MS : RETRY_DELAY_MS);
  })();
})();

server.listen(PORT, HOST, () => {
  console.log("[server] 只读代理已启动 http://" + HOST + ":" + PORT +
    "（真源：GH Pages / jsDelivr / raw 镜像池，由 GitHub Actions 生成；每 " + (GEN_INTERVAL_MS / 60000) +
    " 分钟同步一次，失败则 " + (RETRY_DELAY_MS / 1000) + " 秒后自愈重试）");
});
