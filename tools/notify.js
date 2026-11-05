// notify.js —— 消息推送（企业微信 Webhook 机器人 主通道 / Server酱 备选）
// 设计原则：
//   1) 最便宜有效：企业微信群机器人 webhook 一个 URL 即可，免费无限量，微信域内触达，无需审核；
//      Server酱（sctapi）作备选，免费 5 条/天，微信服务号通知。
//   2) 全部经环境变量/Secrets 配置，未配置时静默跳过——绝不阻塞数据管线；
//   3) 告警节流：同一告警 key 60 分钟内不重复发送（Actions 每 15 分钟一轮，避免轰炸）。
// 用法：
//   const notify = require("./notify");
//   await notify.send("标题", "正文（支持 markdown）");        // 数据简报等
//   await notify.alert("价格数据停更", "meta.generatedAt 已 52 分钟未更新"); // 异常告警（带节流）
const https = require("https");
const http = require("http");

const WECOM_WEBHOOK = process.env.WECOM_WEBHOOK || "";       // 企业微信群机器人 webhook URL
const SERVERCHAN_SENDKEY = process.env.SERVERCHAN_SENDKEY || ""; // Server酱 SendKey
const THROTTLE_MS = 60 * 60 * 1000; // 同类告警 1 小时内不重复

const _lastAlert = {}; // key -> timestamp（进程内节流；Actions 每轮是新进程，停更类告警天然按轮节流）

function post(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeout: timeoutMs || 10000,
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d.slice(0, 300) }));
      }
    );
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

// 企业微信群机器人：markdown 消息（微信域内直接可达）
async function sendWecom(text) {
  if (!WECOM_WEBHOOK) return { ok: false, via: null, why: "未配置 WECOM_WEBHOOK" };
  try {
    const r = await post(WECOM_WEBHOOK, { msgtype: "markdown", markdown: { content: text } });
    const okv = r.status === 200 && /"errcode":0/.test(r.body);
    return { ok: okv, via: "wecom", status: r.status, body: r.body };
  } catch (e) {
    return { ok: false, via: "wecom", why: String(e.message || e) };
  }
}

// Server酱：微信服务号通知（备选通道）
async function sendServerChan(title, text) {
  if (!SERVERCHAN_SENDKEY) return { ok: false, via: null, why: "未配置 SERVERCHAN_SENDKEY" };
  try {
    const r = await post(
      "https://sctapi.ftqq.com/" + SERVERCHAN_SENDKEY + ".send",
      { title: String(title).slice(0, 32), desp: text },
      15000
    );
    const okv = r.status === 200 && /"code":0/.test(r.body);
    return { ok: okv, via: "serverchan", status: r.status, body: r.body };
  } catch (e) {
    return { ok: false, via: "serverchan", why: String(e.message || e) };
  }
}

// 统一发送：企业微信 → Server酱 → 都未配置则仅记录日志
async function send(title, text) {
  const full = "**" + title + "**\n" + text;
  let r = await sendWecom(full);
  if (r.ok) return r;
  r = await sendServerChan(title, text);
  if (r.ok) return r;
  // 都不可用：本地留痕（Actions 日志可见），不抛异常
  console.log("[notify] 无可用推送通道（未配置 WECOM_WEBHOOK / SERVERCHAN_SENDKEY），内容仅在日志留痕：");
  console.log("[notify] " + title + " | " + String(text).replace(/\n/g, " / ").slice(0, 200));
  return { ok: false, via: "log" };
}

// 异常告警：带节流（同 key 60 分钟一次）。返回是否真正发出。
//
// 【C43·根治告警风暴】原实现只有**进程内**节流（_lastAlert 是模块变量），
//   而 GitHub Actions 每轮都是全新进程 → 节流 100% 失效 → 同一个持续性异常
//   会被每一轮重复播报（实测平台卡死期间每轮都推一条「平台落后真源」）。
//   这正是「不能报一次问题，牵一发而动全身」的另一种形态：不是数据故障扩散，
//   而是**告警本身在扩散**，用噪音把真问题淹掉。
//   改为：跨进程持久化节流（状态落 data/.notify-throttle.json，随数据一起提交，
//   故下一轮 Actions 能读到上一轮的记录）+ 保留进程内节流作为快速路径。
//   另加「异常指纹」：同一指纹持续期间只在首次与每小时整点播报，状态变化立即播报。
const fs = require("fs");
const path = require("path");

const THROTTLE_STATE_FILE = path.resolve(__dirname, "..", "data", ".notify-throttle.json");

function readThrottleState() {
  try { return JSON.parse(fs.readFileSync(THROTTLE_STATE_FILE, "utf-8")); }
  catch (e) { return {}; }
}
function writeThrottleState(s) {
  try {
    fs.mkdirSync(path.dirname(THROTTLE_STATE_FILE), { recursive: true });
    fs.writeFileSync(THROTTLE_STATE_FILE, JSON.stringify(s));
  } catch (e) { /* 忽略：节流状态写不进去不应阻塞告警 */ }
}

// 异常指纹：同一类异常的稳定标识（不含时间戳等易变字段）
function fingerprint(text) {
  const s = String(text || "")
    .replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z?/g, "T")   // 时间戳归一
    .replace(/[0-9]+\s*分钟/g, "N分钟")                        // 相对时长归一
    .replace(/\d+/g, "#");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

async function alert(title, detail, key) {
  const k = key || title;
  const now = Date.now();
  const state = readThrottleState();
  const fp = fingerprint(title + "|" + detail);
  const rec = state[k] || {};

  // ── ① 发送失败优先重试（仅限「通道已配置但本次发送失败」的瞬时故障）──
  //   上一轮尝试发送、通道是配置好的、但没发出去（网络抖动/机器人限流）→ 不节流，
  //   下一轮立即重试。真实故障必须能报出来，不能被节流机制吞掉。
  //   注意：若**压根没配置推送通道**（本地/自测环境），那是永久性不可发，
  //   反复重试毫无意义 → 走下面的常规节流路径，避免日志被刷爆。
  const channelConfigured = !!(process.env.WECOM_WEBHOOK || process.env.SERVERCHAN_SENDKEY);
  if (channelConfigured && rec.lastFailedAt && (now - rec.lastFailedAt) < 10 * 60 * 1000) {
    const r = await send("⚠️ " + title, detail + "\n\n> 时间：" + new Date().toISOString());
    state[k] = { fingerprint: fp, lastSentAt: now, lastSeenAt: now, lastFailedAt: r.ok ? 0 : now, lastOk: !!r.ok };
    writeThrottleState(state);
    return r;
  }

  // ── ② 进程内快速节流 ──
  if (_lastAlert[k] && now - _lastAlert[k] < THROTTLE_MS) {
    console.log("[notify] 告警节流跳过（1 小时内已发过）：" + k);
    return { ok: true, throttled: true };
  }

  // ── ③ 跨进程持久化节流 ──
  // 同一异常指纹在窗口内只播报一次；异常内容变了（指纹不同）→ 立即播报，
  // 保证「问题性质发生变化」时不会被节流掩盖。
  const sameFingerprint = rec.fingerprint === fp;
  const withinWindow = rec.lastSentAt && (now - rec.lastSentAt) < THROTTLE_MS;
  if (sameFingerprint && withinWindow) {
    console.log("[notify] 告警节流跳过（跨进程，1 小时内同一异常已发过）：" + k);
    // 【2026-11-05】不再写 lastSeenAt：该字段没有任何读取方，却会让状态文件每轮都变，
    //   导致 refresh.yml 的「状态回写」步骤每 15 分钟制造一次无意义提交。
    //   节流命中即文件无变化 → 仓库保持干净。
    return { ok: true, throttled: true };
  }

  // ── ④ 实际发送 ──
  _lastAlert[k] = now;
  const r = await send("⚠️ " + title, detail + "\n\n> 时间：" + new Date().toISOString());
  // 记录「已尝试发送」的时间（而非仅成功时间）：否则推送通道未配置时 lastSentAt 恒为 0，
  // 节流窗口恒不成立 → 告警风暴照旧（正是要根治的问题）。
  // 发送失败则记 lastFailedAt，让下一轮可立即重试（见分支①）。
  state[k] = {
    fingerprint: fp,
    lastSentAt: now,
    lastSeenAt: now,
    lastFailedAt: r.ok ? 0 : now,
    lastOk: !!r.ok,
  };
  writeThrottleState(state);
  return r;
}

module.exports = { send, alert, sendWecom, sendServerChan };
