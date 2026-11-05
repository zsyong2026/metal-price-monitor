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
async function alert(title, detail, key) {
  const k = key || title;
  const now = Date.now();
  if (_lastAlert[k] && now - _lastAlert[k] < THROTTLE_MS) {
    console.log("[notify] 告警节流跳过（1 小时内已发过）：" + k);
    return { ok: true, throttled: true };
  }
  _lastAlert[k] = now;
  return send("⚠️ " + title, detail + "\n\n> 时间：" + new Date().toISOString());
}

module.exports = { send, alert, sendWecom, sendServerChan };
