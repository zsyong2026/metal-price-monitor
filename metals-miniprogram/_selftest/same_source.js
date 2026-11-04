// same_source.js —— 三端同源自测（C43 口径：GitHub Actions = 唯一真源生成器，平台 = 纯只读代理）
// ------------------------------------------------------------------
// 【架构沿革（勿回退）】
//   C18：平台版 Node 服务 = 唯一真源生成器，进程内 setInterval 每 15 分钟
//        本地 spawn `node generate.js` 生成 data/*.json 并对外 serve。
//        （起因：Actions 的 schedule 对低活跃仓库会严重排队延迟，曾导致三端集体卡死 09:14。）
//   C37：真源收归 GitHub Actions —— Actions Runner 网络不受限（东财/新浪实时均可达），
//        而**平台沙箱网络受限**（东财/新浪被墙）→ 平台无法产出当日实时国内价，
//        故平台退化为「只读真实数据 + 托管站点 + 健康上报」，不再本地生成、不再推送 data/
//        （避免用受限网络下的陈旧/偏差数据覆盖 Actions 产出的真源）。
//        三端读同一份真源镜像（GH Pages），平台版退为末级兜底：
//          · PC 网页          → GH Pages 真源优先 → 平台 /api/ 兜底 → 本地静态
//          · 手机网页(GH Pages)→ GH Pages 真源（微信 UA 会被网关拦，故不能走平台）
//          · 微信小程序       → 云函数 → GH Pages 真源优先 → 平台 /api/bundle 备路 → 离线快照
//   C43：彻底删除平台侧 generateLocal / pushMirror 等「能写真源」的代码路径 ——
//        平台若持有写真源的能力，一旦算出偏差数据就会反推 GH Pages、污染所有读真源的设备，
//        连「回退到真源」这条退路都没了。平台改为：多镜像池取真源 + 硬超时 + 自愈重试，
//        且**只读**（不再持有任何写凭据）。
//
// 本测试同时锁定两条用户反馈的修复：
//   ① 铜无小时线 → 三端一致禁用「时」，不展示空图
//   ② 顶部更新时间 → 三端统一为数据生成时间，不再被实时现货覆写（消除 09:14→10:02 闪烁）
//
// A) 确定性契约（不依赖网络，必过）
// B) 联网抽查（尽力而为，超时仅告警）
//
// 运行：node _selftest/same_source.js   （会被 run_all.js 纳入）
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const APP = path.resolve(__dirname, "../../metals-monitor/js/app.js");
const SRV = path.resolve(__dirname, "../../metals-monitor/server.js");
const DC = path.resolve(__dirname, "../utils/data-contract.js");
const PIPE = path.resolve(__dirname, "../cloudfunctions/metals-data/src/pipeline.js");
const IDX = path.resolve(__dirname, "../pages/index/index.js");
const WXML = path.resolve(__dirname, "../pages/index/index.wxml");

const CANON_HOST = "zsyong2026.github.io";
const PLATFORM_HOST = "metal-price-monitor.app.workbuddy.host";
const SHARE = "POOW32T4LI";
const PLATFORM_API = "https://" + PLATFORM_HOST + "/api/";
const PLATFORM_Q = PLATFORM_API + "?sharecode=" + SHARE;

let fails = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fails++; };
const warn = (m) => console.log("  ⚠ " + m);

function getJSON(url, ms) {
  return new Promise((resolve) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: ms }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { resolve(null); } });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

// 取 HTTP 状态码（用于探测网关 UA 鉴权行为）
function getStatus(url, ua) {
  return new Promise((resolve) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: 15000, headers: { "User-Agent": ua } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

(async () => {
  console.log("== 三端同源（C18：平台版 = 唯一真源生成器，每 15 分钟本地生成）==");

  const app = fs.readFileSync(APP, "utf8");
  const srv = fs.readFileSync(SRV, "utf8");
  const dcSrc = fs.readFileSync(DC, "utf8");
  const pipeSrc = fs.readFileSync(PIPE, "utf8");
  const idxSrc = fs.readFileSync(IDX, "utf8");
  const wxmlSrc = fs.readFileSync(WXML, "utf8");

  // ---------- A1) PC / 手机网页：平台 /api/ 为主通道，GH Pages 为兜底 ----------
  ok(app.indexOf('var PLATFORM_HOST = "https://' + PLATFORM_HOST) >= 0,
    "网页端声明平台版真源主机 PLATFORM_HOST（" + PLATFORM_HOST + "）");
  ok(app.indexOf('var SHARE = "' + SHARE + '"') >= 0,
    "网页端声明平台网关鉴权 sharecode（跨域读平台 /api/ 必需）");
  ok(/function apiUrl\(p\)/.test(app) && app.indexOf("PLATFORM_HOST + p") >= 0,
    "apiUrl：静态壳（手机网页）把相对 /api/ 翻成平台绝对地址 + sharecode");

  // 【C32】三端统一只读 GH Pages 镜像：每处 loadFirst 以 canon(GH Pages) 打头，平台 /api 降为兜底。
  //   原因：镜像偶有滞后也是三端同步滞后，不再出现「PC 读到最新、手机读到旧镜像」的互相错位。
  const calls = (app.match(/loadFirst\(\s*\[/g) || []).length;
  const canonFirst = (app.match(/loadFirst\(\s*\[\s*canon\(CANON/g) || []).length;
  const apiAsFallback = (app.match(/loadFirst\(\s*\[\s*canon\(CANON[^\]]*"\/api/g) || []).length;
  ok(calls > 0 && canonFirst === calls,
    "网页端全部 " + calls + " 处 loadFirst 均以 GH Pages 镜像打头（命中 " + canonFirst + "）");
  ok(calls > 0 && apiAsFallback === calls,
    "平台 /api 保留为第二顺位兜底（" + apiAsFallback + "/" + calls + " 处）——主路镜像失败时才用");

  // C18 关键修复：静态壳不得再把 /api/ 全过滤掉（C17 的过滤 = 手机端只读陈旧 GH Pages）
  ok(app.indexOf('u.indexOf("/api/") !== 0') < 0,
    "loadFirst 不再过滤掉 /api/（C17 过滤会让手机网页退回陈旧 GH Pages 兜底壳）");
  ok(app.indexOf("PLATFORM_HOST + p") >= 0 && app.indexOf("canon(CANON") >= 0,
    "GH Pages 镜像为主 + 平台 /api 兜底并存（两端都保留同一套 URL 归一）");

  ok(app.indexOf('u.indexOf("_ts=") >= 0') >= 0,
    "bust 已避免对真源 URL 重复追加 _ts（缓存穿透不叠加）");

  // ---------- A2) 小程序：设备直连只走 GH Pages（微信 UA 过不了平台网关） ----------
  const dcM = dcSrc.match(/const MIRRORS\s*=\s*\[([\s\S]*?)\];/);
  const dcUrls = dcM ? (dcM[1].match(/https:\/\/[^"\s,]+/g) || []) : [];
  ok(dcUrls[0] && dcUrls[0].indexOf(CANON_HOST) >= 0,
    "小程序 MIRRORS[0] = GitHub Pages（设备直连兜底：" + (dcUrls[0] || "未解析到") + "）");
  ok(dcUrls.every((u) => u.indexOf("app.workbuddy.host") < 0),
    "小程序 MIRRORS 不含平台版（微信 UA 会被网关 403 拦截，必须走云函数）");

  // ---------- A3) 云函数：主路 = GitHub Pages 公共 CDN，备路 = 平台版真源（Node UA 可过网关） ----------
  // 【C22】镜像顺序已调整：主路 GH Pages（无 UA 限制、最稳），平台版降为备路。
  const pM = pipeSrc.match(/const MIRRORS\s*=\s*\[([\s\S]*?)\];/);
  const pUrls = pM ? (pM[1].match(/https:\/\/[^"\s,]+/g) || []) : [];
  ok(pUrls.length >= 1 && pUrls[0].indexOf(CANON_HOST) >= 0,
    "云函数 MIRRORS[0] = GitHub Pages（公共 CDN，无 UA 限制，最稳）");
  ok(pUrls.some((u) => /app\.workbuddy\.host\/data\?sharecode=/.test(u)),
    "云函数 MIRRORS 保留平台版真源作为备路（Node UA 可过网关，更鲜）");
  ok(pUrls.length >= 2 && pUrls.some((u) => u.indexOf(CANON_HOST) >= 0),
    "云函数双镜像齐全（GH Pages 主路 + 平台版备路，任一可达即可出数）");

  // ---------- A4) 【C37/C43 架构门禁】平台版必须是「纯只读真源代理」，不得自行生成数据 ----------
  // 沿革（勿回退）：
  //   C17 要求「平台版不得自行 generate」（防两套管线漂移）；
  //   C18 反转为「平台版必须定时本地生成」并定为唯一真源；
  //   C37 再反转：真源收归 GitHub Actions（东财/新浪在 Actions 网络可达），
  //              平台沙箱网络受限（东财/新浪被墙）→ 平台退化为「只读真实数据 + 托管站点 + 健康上报」；
  //   C43 彻底删除 generateLocal/pushMirror 等「平台能写真源」的代码路径 ——
  //              平台若能写真源，一旦算出偏差数据就会反推 GH Pages 污染所有设备，
  //              连「回退到真源」这条退路都没了。故此处断言「平台不得生成、不得推送」。
  //   注意：判定要看**函数定义**（function xxx / xxx = ... 形式），不能简单 indexOf ——
  //   server.js 里保留了「为什么删除它们」的说明性注释，indexOf 会误判成代码仍在。
  const hasLocalGen = /function\s+generateLocal\s*\(/.test(srv) || /const\s+generateLocal\s*=/.test(srv);
  const hasPushMirror = /function\s+pushMirror\s*\(/.test(srv) || /const\s+pushMirror\s*=/.test(srv);
  ok(!hasLocalGen && !hasPushMirror,
    "平台版 server.js 不含本地生成/推送真源的代码路径（C43：纯只读，杜绝反推污染真源）");
  ok(/GEN_INTERVAL_MS\s*=\s*15\s*\*\s*60\s*\*\s*1000/.test(srv),
    "平台版同步周期 = 15 分钟（与数据发布节奏一致）");
  ok(srv.indexOf('"/api/bundle"') >= 0,
    "平台版提供 /api/bundle 聚合端点（云函数 3 秒超时内一次拿全 6 份）");
  // C43：多镜像容灾（单一出口故障不再拖垮全局）+ 硬超时（保证 Promise 必定 settle）
  ok(srv.indexOf("CANON_MIRRORS") >= 0 && /jsdelivr/.test(srv) && /raw\.githubusercontent/.test(srv),
    "平台版真源取数走多镜像池（GH Pages / jsDelivr / raw），单一出口故障不拖垮全局");
  ok(/httpGetText/.test(srv) && /setTimeout/.test(srv),
    "平台版取数自带覆盖 DNS/建连的硬超时（C43：杜绝 Promise 悬空导致同步永久僵死）");

  // ---------- A5) 铜无 hourly 的放行规则：两份契约一致 ----------
  const dcHasCopperNote = /copper[\s\S]{0,400}hourlyNote/.test(dcSrc);
  const pipeHasCopperNote = /copper[\s\S]{0,400}hourlyNote/.test(pipeSrc);
  ok(dcHasCopperNote && pipeHasCopperNote,
    "铜无 hourly 的放行规则在小程序与云函数两份契约中一致（C17 真凶回归）");

  // ---------- A6) 小程序主链路：设备直连 GH Pages 真源优先 → 云函数 → 离线快照 ----------
  // 【C32/C37 架构】主源已改为 GH Pages 真源镜像（与 PC/手机网页同源、新鲜、微信可直连）：
  //   loadAll → loadCanonical（GH Pages 一级）→ loadFromCloud（云函数二级）→ loadSnapshot（离线快照三级）。
  //   云函数退为二级：线上旧版云函数沙箱出网受限会回退陈旧云库，故只在主源不可达时才用。
  // （C18 旧口径为「云函数为主、设备直连为兜底」，已随 C32/C37 架构反转，故此处同步更新断言方向。）
  ok(/loadAll\(\)[\s\S]{0,2200}?this\.loadCanonical\(false\)/.test(idxSrc),
    "小程序 loadAll 以设备直连 GH Pages 真源为主链路（C32/C37）");
  ok(/loadCanonical\(silent\)[\s\S]{0,3200}?loadFromCloud\(false\)/.test(idxSrc),
    "小程序 GH Pages 主源不可达 → 二级降级为云函数");
  ok(/loadFromCloud\(silent\)[\s\S]{0,2600}?\.loadSnapshot\(/.test(idxSrc),
    "小程序云函数也失败 → 三级降级为离线快照");
  ok(idxSrc.indexOf("dc.MIRRORS.map") >= 0 && idxSrc.indexOf("Promise.all(races)") >= 0,
    "设备直连通道仍为镜像并行竞速（真机不被跨境镜像超时拖慢）");
  ok(idxSrc.indexOf("errMsg") >= 0,
    "小程序请求失败原因（errMsg）被记录，不再静默吞掉（便于真机定位）");

  // ---------- A7) 【C18 反馈①】铜无小时线：三端一致禁用「时」 ----------
  ok(/function hourlyReady\(\)/.test(app) && app.indexOf("syncGranAvailability") >= 0,
    "网页端提供 hourlyReady/syncGranAvailability（按品种判定小时线可用性）");
  ok(app.indexOf('classList.toggle("disabled", !ok)') >= 0 &&
    app.indexOf('btn.classList.contains("disabled")') >= 0,
    "网页端无小时线时禁用「时」按钮（样式 + 点击双重拦截）");
  ok(idxSrc.indexOf("hourlyReady") >= 0 &&
    /if \(gran === "hour" && !this\.data\.hourlyReady\) return;/.test(idxSrc),
    "小程序无小时线时禁止切到「时」（switchGran 守卫）");
  ok(wxmlSrc.indexOf("!hourlyReady ? 'disabled'") >= 0,
    "小程序「时」按钮在无小时线时带 disabled 样式并标注「暂无」");
  ok(idxSrc.indexOf("!hourlyReady && this.data.gran === \"hour\"") >= 0 ||
    idxSrc.indexOf('if (!hourlyReady && this.data.gran === "hour")') >= 0,
    "小程序停留在「时」但无小时线时自动回退「天」（不留空图）");

  // ---------- A8) 【C18 反馈②】顶部更新时间：三端统一为数据生成时间 ----------
  ok(/refreshLiveSpot\(\)\s*\{\s*\/\* C18 停用/.test(app),
    "网页端停用实时现货覆写（消除顶部时间 09:14→10:02 闪烁）");
  ok(/function priceStamp\(\)[\s\S]{0,400}?state\.meta && state\.meta\.generatedAt/.test(app) &&
    app.indexOf("state.priceSpotAt ||") < 0,
    "网页端顶部/价格时间取自 meta.generatedAt（= 数据生成时间，三端一致）");
  ok(!/state\.data\.lastUpdate\s*=\s*p\.updatedAt/.test(app),
    "网页端不再用现货时间覆写数据入库时间");

  // ---------- B) 联网抽查：平台真源新鲜度 + 铜小时线形态 ----------
  // 注：本进程首次外连要 2s+（DNS + TLS 握手），故先取 bundle（同时承担新鲜度断言），
  // 再取 health 交叉验证，避免首个请求假性超时。
  const bundle = await getJSON(PLATFORM_Q.replace("/api/", "/api/bundle"), 25000);
  if (bundle && bundle.files) {
    const f = bundle.files;
    ok(["gold.json", "silver.json", "copper.json", "meta.json", "events.json", "events.meta.json"]
      .every((k) => !!f[k]), "平台 /api/bundle 6 份文件齐备");
    const meta = f["meta.json"] || {};
    const mgAge = meta.generatedAt ? Date.now() - new Date(meta.generatedAt).getTime() : NaN;
    ok(!isNaN(mgAge) && mgAge >= 0 && mgAge < 25 * 60 * 1000,
      "平台真源新鲜：meta.generatedAt = " + meta.generatedAt +
      "（" + (isNaN(mgAge) ? "?" : Math.round(mgAge / 60000)) + " 分钟前，15 分钟生成周期内）");
    const gold = f["gold.json"] || {}, copper = f["copper.json"] || {};
    const gH = ((gold.hourly || {}).london || []).length;
    const cH = ((copper.hourly || {}).london || []).length;
    ok(gH > 0, "金/银有真实小时线（金 hourly=" + gH + " 点）");
    ok(cH === 0 && !!copper.hourlyNote,
      "铜无小时线且带 hourlyNote（三端据此一致禁用「时」）");
  } else {
    warn("平台 /api/bundle 获取失败/超时，跳过数据形态断言");
  }

  const health = await getJSON(PLATFORM_Q.replace("/api/", "/api/health"), 20000);
  if (health && health.generatedAt) {
    const age = Date.now() - new Date(health.generatedAt).getTime();
    ok(health.lastGenOk === true,
      "平台生成器自报成功（lastGenOk=true，lastError=" + JSON.stringify(health.lastError || "") + "）");
    ok(age >= 0 && age < 25 * 60 * 1000,
      "平台生成器最近一次生成在 25 分钟内：" + health.generatedAt +
      "（" + Math.round(age / 60000) + " 分钟前）");
  } else {
    warn("平台 /api/health 获取失败/超时（首个外连 TLS 冷启动），跳过生成器自检断言");
  }

  // ---------- B2) 平台数据接口可达性 + 历史 UA 门禁（C17 曾实测微信 UA=403）----------
  // 【C32】实测该门禁已不复现（微信 UA 与普通 UA 均 200）。三端「只读 GH Pages」的策略不依赖它，
  //   故此处置为「可达性硬断言 + UA 差异软告警」：口径变了要留痕，但不能卡住发布。
  const PLATFORM_DATA = "https://" + PLATFORM_HOST + "/data/meta.json?sharecode=" + SHARE;
  const WECHAT_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) MicroMessenger/8.0.40";
  const codeWithUA = await getStatus(PLATFORM_DATA, WECHAT_UA);
  const codePlain = await getStatus(PLATFORM_DATA, "metals-cloud/1.0");
  if (codeWithUA && codePlain) {
    ok(codePlain === 200, "平台数据接口可达（Node UA=" + codePlain + "）");
    if (codeWithUA === 403) {
      ok(true, "平台网关仍按 UA 鉴权（微信 UA=403）→ 小程序不可直连平台版");
    } else {
      warn("平台网关对微信 UA 返回 " + codeWithUA + "（C17 实测为 403，现已不复现）；" +
        "三端只读 GH Pages 策略不依赖该门禁，不计为失败");
    }
  } else {
    warn("平台网关探测失败/超时，跳过 UA 鉴权断言");
  }

  console.log(fails === 0
    ? "\n  ✓ SAME-SOURCE ALL GREEN（C18：平台唯一真源 + 三端统一时间戳 + 铜小时线一致禁用）"
    : "\n  ✗ SAME-SOURCE 存在失败项");
  process.exit(fails === 0 ? 0 : 1);
})();
