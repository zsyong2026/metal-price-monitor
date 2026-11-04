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
const { execFile } = require("child_process");

const ROOT = __dirname;
const DATA = path.join(ROOT, "data");
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

const FILES = ["gold.json", "silver.json", "copper.json", "meta.json", "events.json", "events.meta.json"];
const GEN_INTERVAL_MS = 15 * 60 * 1000;   // 与数据发布节奏一致：每 15 分钟一版
const GEN_TIMEOUT_MS = 180000;            // generate.js 单次运行超时（含多源抓取+校验）
const GH_PAGES_CANON = "https://zsyong2026.github.io/metal-price-monitor/data";
// 【C42】真源同步超时放宽到 30s 并支持重试：events.json 达 172KB，
//   在平台沙箱→GH Pages 的慢链路上 12s 常超时失败，导致事件数据 404。
//   放宽 + 重试后大文件也能稳定拉取；小文件（meta/events.meta）本就快，无副作用。
const PROXY_TIMEOUT_MS = 30000;
const PROXY_RETRY = 1;

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
let generating = false;
// C19 镜像状态：平台生成后直推 GitHub Pages（微信 UA 唯一可读的公共静态源）
// 【C24】增加 credState：区分「凭据失效(401)」「网络/其它错误」——
//   GH PAT 到期是本项目最可能的单点故障（一旦失效 → GH Pages 停更 →
//   微信端读到旧数据），必须让巡检一眼看出是「要换 PAT」而非「网络抖动」。
let mirror = { ok: false, at: 0, error: "", commit: "", ms: 0, credState: "" };
// 【C24】GitHub 凭据状态（ok / expired / missing / error / network）
let cred = { state: "unknown", detail: "" };

const GH_REPO = "zsyong2026/metal-price-monitor";

// ------------------------------------------------------------------
// C19：真源镜像推送（解决「三端更新时间差 20 分钟」）
//
// 背景：微信内置浏览器的 UA 含 MicroMessenger → 平台网关按 UA 鉴权返回 403，
//   故手机网页（微信内打开）与「已发布的小程序」实际读的是 GitHub Pages。
//   而 GitHub Pages 原先靠 Actions 的 schedule 刷新 —— 那个定时器对低活跃仓库
//   会严重延迟甚至停摆（实测 5 次触发 0 次提交，且非快进 push 被拒）→ 镜像停在 11:05。
//   结果：PC 读平台（11:25）、手机/小程序读 GH Pages（11:05），三端时间戳对不上。
//
// 方案：平台生成器（24h 在线、setInterval 可靠）生成完就**直接调 GitHub REST API 推送**
//   data/*.json 到 GH Pages —— 不再依赖 Actions 的定时调度（Actions 改为只做健康巡检）。
//   推的是同一份字节，meta.generatedAt 与平台完全一致 → 三端显示同一个更新时间。
//
// 凭据：优先环境变量 GH_TOKEN；否则读项目根目录 .env（部署时随源码上传进沙箱）。
//   注意：.env 不在 dist-ghpages/ 内，故不会随静态包发布到公开仓库。
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

// 【C24】凭据主动预检：不等镜像推送失败才发现 PAT 已失效。
//   PAT 到期是本项目最可能的单点故障——失效后 GH Pages 停更，
//   而 GH Pages 仍是手机网页/已发布小程序**唯一可直连**的公开静态源。
//   故每轮生成前先用一个轻量请求（GET /user）验证凭据，
//   把「401 失效」提前暴露到 /api/health 与巡检告警，而不是等到推送才报错。
async function checkCredential() {
  const token = ghToken();
  if (!token) return { state: "missing", detail: "未配置 GH_TOKEN（检查 .env）" };
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "User-Agent": "metals-canon-server",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (res.status === 401) {
      return { state: "expired", detail: "HTTP 401 Bad credentials（PAT 已到期或被吊销）" };
    }
    if (!res.ok) return { state: "error", detail: "HTTP " + res.status };
    const j = await res.json().catch(() => ({}));
    return { state: "ok", detail: j.login ? ("login=" + j.login) : "" };
  } catch (e) {
    return { state: "network", detail: (e && e.message) || String(e) };
  }
}

async function ghApi(method, apiPath, body) {
  const token = ghToken();
  if (!token) throw new Error("no-token");
  const res = await fetch("https://api.github.com" + apiPath, {
    method: method,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "User-Agent": "metals-canon-server",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(method + " " + apiPath + " -> HTTP " + res.status + " " + txt.slice(0, 200));
  return txt ? JSON.parse(txt) : null;
}

// 把本地生成的 data/*.json 推送到 GH Pages（base_tree 继承 → 快进提交，不重写历史）
// 并发安全：静态包发布也会动 main（两者撞车 → 非快进被拒）→ 失败后重读 ref 重试一次。
async function pushMirror() {
  const t0 = Date.now();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ref = await ghApi("GET", "/repos/" + GH_REPO + "/git/ref/heads/main");
      const baseCommit = ref.object.sha;
      const baseTree = (await ghApi("GET", "/repos/" + GH_REPO + "/git/commits/" + baseCommit)).tree.sha;
      const entries = [];
      for (const f of FILES) {
        const body = fs.readFileSync(filePath(f), "utf-8");
        const blob = await ghApi("POST", "/repos/" + GH_REPO + "/git/blobs", {
          content: Buffer.from(body, "utf-8").toString("base64"), encoding: "base64",
        });
        entries.push({ path: "data/" + f, mode: "100644", type: "blob", sha: blob.sha });
      }
      const tree = await ghApi("POST", "/repos/" + GH_REPO + "/git/trees", { base_tree: baseTree, tree: entries });
      const commit = await ghApi("POST", "/repos/" + GH_REPO + "/git/commits", {
        message: "chore: 同步真源数据 " + new Date().toISOString(),
        tree: tree.sha, parents: [baseCommit],
      });
      await ghApi("PATCH", "/repos/" + GH_REPO + "/git/refs/heads/main", { sha: commit.sha });
      mirror = { ok: true, at: Date.now(), error: "", commit: String(commit.sha).slice(0, 8), ms: Date.now() - t0, credState: "" };
      console.log("[mirror] 已推送 GH Pages：" + mirror.commit + "（" + mirror.ms + "ms）");
      return;
    } catch (e) {
      const msg = (e && e.message) || String(e);
      // 409/422 = ref 被别人推进（并发推送）→ 重读后重试；其它错误（如 401 凭据失效）直接放弃
      if (attempt < 3 && /HTTP (409|422)/.test(msg)) {
        console.warn("[mirror] main 被并发推进，重试第 " + (attempt + 1) + " 次");
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      // 【C24】识别 GitHub 凭据失效（PAT 过期/被吊销 → HTTP 401 Bad credentials）
      const credState = /HTTP 401|Bad credentials/i.test(msg) ? "expired" : "";
      mirror = { ok: false, at: Date.now(), error: msg, commit: "", ms: Date.now() - t0, credState };
      console.warn("[mirror] 推送失败：" + mirror.error + (credState ? "（GitHub 凭据失效，需更换 GH_TOKEN）" : ""));
      return;
    }
  }
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

// 本地生成：spawn `node generate-all.js`（与本服务同仓库，自包含无外部 key）
// 用 generate-all.js 而非 generate.js：后者只出价格、不刷新重大事件，
// 会导致「价格时间前进、事件时间停更」的三端不一致（用户反馈 09:14 卡死）。
function generateLocal() {
  if (generating) return Promise.resolve(false);
  generating = true;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = execFile("node", [path.join(ROOT, "generate-all.js")], {
      cwd: ROOT,
      timeout: GEN_TIMEOUT_MS,
      env: Object.assign({}, process.env, { NODE_ENV: "production" }),
    }, (err, stdout, stderr) => {
      generating = false;
      if (err) {
        lastError = "本地生成失败：" + (err.message || String(err));
        console.warn("[gen] " + lastError);
        resolve(false);
        return;
      }
      // 读取落盘结果，校验 6 个文件齐备且合法
      let ok = 0;
      const next = {};
      for (const f of FILES) {
        const d = readDisk(f);
        if (d && safeParse(d.body)) { next[f] = d; ok++; }
      }
      if (ok === FILES.length) {
        for (const f of FILES) cache[f] = { body: next[f].body, at: Date.now(), updatedAt: next[f].updatedAt };
        lastGenAt = Date.now();
        lastGenOk = true;
        lastError = "";
        console.log("[gen] 本地生成完成：" + FILES.length + " 文件，" + ((Date.now() - t0) / 1000).toFixed(1) + "s");
        resolve(true);
      } else {
        lastError = "生成后文件校验不全（" + ok + "/" + FILES.length + "）";
        console.warn("[gen] " + lastError);
        resolve(false);
      }
    });
  });
}

// GH Pages 真源代理（本地生成失败时的兜底；其仍由 Actions 不定期刷新）
function fetchUpstreamOnce(f) {
  return new Promise((resolve) => {
    const url = GH_PAGES_CANON + "/" + f + "?_ts=" + Date.now();
    const req = https.get(url, { timeout: PROXY_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve(body || null));
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

// 【C42】大文件（events.json 172KB）在慢链路偶尔超时：失败时重试一次，提升同步成功率
async function fetchUpstream(f) {
  let last = null;
  for (let i = 0; i <= PROXY_RETRY; i++) {
    last = await fetchUpstreamOnce(f);
    if (last) return last;
  }
  return null;
}

// 触发 GitHub Actions 刷新（需 GH_TOKEN 环境变量；可选，让 GH Pages 兜底也保持新鲜）
function triggerActions() {
  const token = process.env.GH_TOKEN;
  if (!token) return;
  const body = JSON.stringify({ ref: "main" });
  const req = https.request({
    hostname: "api.github.com",
    path: "/repos/zsyong2026/metal-price-monitor/actions/workflows/refresh.yml/dispatches",
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Accept": "application/vnd.github+json",
      "User-Agent": "metals-canon-server",
      "Content-Type": "application/json",
    },
  }, (res) => { res.resume(); });
  req.on("error", () => {});
  req.write(body);
  req.end();
}

// 【C37 架构调整】数据真源改由 GitHub Actions 生成（东财/新浪实时均可达）并推送 GH Pages；
// 平台沙箱网络受限（东财被墙、hq.sinajs.cn 被墙），自身无法产出当日实时国内价，
// 故平台退化为「只读真实数据 + 托管站点 + 健康上报」，不再本地生成/推送 data/
// （避免用受限网络下的陈旧/偏差数据覆盖 Actions 产出的真源）。仅在 GH Pages 真源不可达时，
// 才退化为本地尽力生成并推送兜底。
async function refresh() {
  const ok = await syncFromPages();
  if (ok) {
    lastGenOk = true;
    lastError = "（只读 GH Pages 真源，由 Actions 每 15 分钟生成）";
    return;
  }
  // 【C42 彻底修复·牵一发不动全身】GH Pages 真源同步失败：平台沙箱网络受限，本地生成无法获取
  //   实时行情（东财/新浪被墙），若退化为 generateLocal() 反而会用陈旧/偏差数据覆盖缓存、
  //   乃至 pushMirror 反推 GH Pages，造成连环污染（实测 events.json 曾因此被覆盖成残缺/旧数据而 404）。
  //   故同步失败时，平台只如实标记 lastGenOk=false 并继续服务「上一轮成功缓存 / 部署快照」，
  //   绝不本地生成。真源由 GitHub Actions 维护并直推 GH Pages，平台保持纯只读代理。
  lastGenOk = false;
  lastError = lastError || "GH Pages 真源同步失败（平台仅只读，不本地生成）";
  console.warn("[refresh] GH Pages 真源同步失败，平台仅服务上一轮缓存/部署快照（不本地生成）");
}

// 核心四件套（价格 + 元信息）：缺失任一份都视为真源不可用，必须阻塞并告警。
// 可选事件类（events.json / events.meta.json）：任一份瞬时失败 → 沿用上一轮缓存、不阻塞核心。
// 【C42 根治「牵一发而动全身」】此前 syncFromPages 是「全有或全无」——
//   只要 events.json 一次抖动（瞬间 404/超时），整轮同步被拒，平台死抱部署时的旧磁盘快照，
//   全平台吐出 15h 旧价、check_platform 误报、所有读平台的设备看到旧价。
//   改为核心齐备即接受、事件类失败仅保留旧缓存，把单点抖动隔离在「事件」局部。
const CORE_FILES = ["gold.json", "silver.json", "copper.json", "meta.json"];
const OPTIONAL_FILES = ["events.json", "events.meta.json"];

// 从 GH Pages 真源同步数据到本地缓存（平台只读，不写回 data/）
async function syncFromPages() {
  const all = CORE_FILES.concat(OPTIONAL_FILES);
  const results = await Promise.all(all.map((f) => fetchUpstream(f)));
  const next = {};
  let coreOk = 0;
  for (let i = 0; i < all.length; i++) {
    const f = all[i];
    if (results[i] && safeParse(results[i])) next[f] = results[i];
    if (CORE_FILES.indexOf(f) >= 0 && next[f]) coreOk++;
  }
  if (coreOk < CORE_FILES.length) {
    lastError = "GH Pages 真源核心数据缺失（" + coreOk + "/" + CORE_FILES.length + "）";
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
      console.warn("[sync] 可选文件 " + f + " 本次未取到，沿用上一轮缓存（不阻塞核心数据）");
    }
  }
  lastGenAt = Date.now();
  // 数据由 Actions 管理，平台只读；镜像状态标记为「真源在 GH Pages（Actions 维护）」
  mirror = { ok: true, at: Date.now(), error: "", commit: "(actions)", ms: 0, credState: "" };
  cred = { state: "ok", detail: "data 由 GitHub Actions 生成并推送 GH Pages，平台只读" };
  console.log("[sync] 已从 GH Pages 真源同步核心 " + coreOk + "/" + CORE_FILES.length +
    "，可选沿用缓存 " + kept + "/" + OPTIONAL_FILES.length);
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
      sendJSON(res, 200, {
        ok: true, role: "readonly-proxy", generatedAt: lastGenAt ? new Date(lastGenAt).toISOString() : null,
        lastGenOk, lastError, updatedAt: ts,
        // C19：GH Pages 镜像推送状态（微信 UA 唯一可读源的 freshness 取决于它）
        mirror: {
          ok: mirror.ok, at: mirror.at ? new Date(mirror.at).toISOString() : null,
          commit: mirror.commit, ms: mirror.ms, error: mirror.error,
          hasToken: !!ghToken(),
          // 【C24】"expired" = GitHub 凭据失效（PAT 到期/被吊销）→ 必须换 token
          credState: mirror.credState || "",
        },
        // 【C24】凭据预检结果（平台主动探测，比等推送失败更早暴露）
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

// 启动：先读磁盘快照（冷启动即可用），随后立即生成一版，并每 15 分钟持续生成
(function boot() {
  for (const f of FILES) {
    const d = readDisk(f);
    if (d) cache[f] = { body: d.body, at: 0, updatedAt: d.updatedAt };
  }
  refresh();
  setInterval(refresh, GEN_INTERVAL_MS);
})();

server.listen(PORT, HOST, () => {
  console.log("[server] 只读代理已启动 http://" + HOST + ":" + PORT +
    "（真源：GH Pages / GitHub Actions，每 " + (GEN_INTERVAL_MS / 60000) + " 分钟尝试从真源同步）");
});
