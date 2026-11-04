// check_platform.js —— 平台只读代理健康巡检（C37 架构）
// ==================================================================
// 背景（C37，2026-11-03）：数据真源已收归 GitHub Actions —— 每 15 分钟抓取真实行情
// （东财/新浪/现货）生成 data/*.json 并推送 GH Pages（zsyong2026.github.io/metal-price-monitor/data）。
// 平台（metal-price-monitor.app.workbuddy.host）因此退化为「只读代理 + 托管站点 + 健康上报」：
//   · 自身不再本地生成、也不再推送 GH Pages 镜像（避免用沙箱受限网络下的陈旧数据覆盖真源）；
//   · 启动即从 GH Pages 真源同步数据到缓存；若真源不可达，则退化为服务「部署时随包注入的 data/ 快照」。
//
// 因此本巡检的判定基准必须改变：
//   ① 真源新鲜度 = GH Pages meta.generatedAt（Actions 每 15 分钟产出），这是整条链路的命门；
//   ② 平台吐出的数据只需与 GH Pages 真源对齐（落后不超过一个部署窗口），平台落后即说明未同步/未重发；
//   ③ 平台不再持有推送凭据、不再推送镜像 —— 旧检查里的 mirror.ok / credential.expired /
//      lastGenOk（作为「生成器失败」）均为「平台自建生成器」时代的产物，C37 后全部失真，已移除。
//
// 运行：node tools/check_platform.js
const notify = require("./notify");
const path = require("path");
const ED = require(path.join(__dirname, "..", "js", "event-dedupe.js"));

const PLATFORM_HOST = "metal-price-monitor.app.workbuddy.host";
const SHARE = "POOW32T4LI";
const GH_PAGES_CANON = "https://zsyong2026.github.io/metal-price-monitor/data";
// 【阈值口径（按实测校准，勿再按「每 15 分钟一轮」的假设设阈）】
//   GitHub Actions 的 schedule 写的是 */15，但低活跃仓库会被排队合并 —— 实测真实触发间隔为
//   52~81 分钟（2026-11-03/04 连续 22 轮 schedule 的 created_at 差值），即「约每小时一轮」。
//   故真源新鲜度阈值取 90 分钟（覆盖一次真实间隔 + 余量），否则每轮都会误报「真源陈旧」。
//
// 【C43·告警判据重写】此前只看「平台吐出的数据落后真源多少分钟」，阈值 60 分钟。
//   问题：① 60 分钟太松 —— 平台每 15 分钟同步一次，正常漂移应 < 15 分钟，
//   真正该抓的是「同步链路挂了」而不是「慢了一点点」；
//   ② 判据只看数据漂移，看不出**为什么**漂移 —— 平台同步失败、真源更新、真源被污染
//   三种完全不同的病因开出同一张告警，处置方式却相反（真源更新 → 什么都不用做；
//   平台挂了 → 要修平台；真源被污染 → 要回滚）。这是典型的「报了一堆但没法处置」。
//   现改为：先看平台自报状态（lastGenOk/lastError/source），再算漂移，
//   并按病因分类给出不同的处置指引。
const MAX_AGE_MIN = 90;         // 真源新鲜度：Actions 实测约每小时一轮，取 90 分钟
// 平台漂移：平台每 15 分钟同步一次真源，正常漂移 < 15 分钟。
//   60 分钟 = 落后 4 个同步周期，足以判定链路异常；再放宽就会漏报真正的卡死。
const DRIFT_WARN_MIN = 60;
// 平台冷启动宽限期：平台进程启动后这段时间内，若还没成功同步过一次真源，
//   视为「刚起来还没同步完」而非故障（避免部署后误报 + 无效处置建议）。
//   超时仍未同步成功 → 判真故障。
const COLD_START_GRACE_MIN = 20;
// 【C44】平台采样次数：部署滚动更新窗口内新旧副本并存，单次采样会随机命中
//   尚未同步好的新副本 → 误报「平台落后真源」（实测真发生过，且该告警会给出
//   错误的处置建议「重发平台版」，把人引向反方向）。
//   采样 4 次取「数据最新」的副本作为判定依据，兼顾准确与耗时（约 2 秒）。
const PROBE_SAMPLES = 4;
// 【C44】真源读取的重试确认：Actions runner 偶发网络抖动会让单次读取失败，
//   而真源是"最不该误报"的对象（它一挂全端受影响，误报代价高）。
//   单次失败 → 重试 2 次（间隔 2.5 秒）；仍失败才判「真源不可达」。
const CANON_RETRY = 2;
const CANON_RETRY_GAP_MS = 2500;
// 平台自报同步失败（lastGenOk=false）时，**无论漂移多少分钟都立即报**——
//   这是最强的信号：平台自己都说没同步上，哪怕数据暂时还新鲜也该报（否则真源一旦
//   同时停更，会因为"漂移还没超阈值"而静默，直到双故障叠加才暴露）。
const TIMEOUT_MS = 15000;


function getJSON(url) {
  return new Promise((resolve) => {
    // 【C43】与平台侧同源的隐患加固：req 必须先声明再引用（避免 TDZ），
    //   且超时路径要 clearTimeout，避免定时器泄漏拖慢 Actions 轮次。
    let req = null;
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; clearTimeout(t); resolve(v); };
    const t = setTimeout(() => { try { if (req) req.destroy(); } catch (e) { /* ignore */ } done(null); }, TIMEOUT_MS);
    try {
      req = require("https").get(url, { headers: { "User-Agent": "metals-check/1.0" } }, (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          // 网关可能返回 403/404 的 JSON 错误体：能解析但字段全缺（generatedAt=null 等），
          //   若当成功解析就会误报「数据不新鲜」。故非 2xx 一律按不可达处理。
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) { done(null); return; }
          try { done(JSON.parse(body)); } catch (e) { done(null); }
        });
        res.on("error", () => done(null));
      });
      req.on("error", () => done(null));
    } catch (e) {
      done(null);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// 【C44】平台采样：连发 N 次请求，观察网关把流量分给了哪些实例。
//   每次同时取 /api/health 与 /api/data/gold（同一次采样内尽量相邻，
//   但仍可能落在不同副本上 → 因此两者都收，取 gold 的时间戳做参考）。
//   目的：部署滚动更新期间存在新旧副本并存，单次采样会随机命中旧副本 → 误报。
//   返回数组，调用方取「数据最新」的那份作为判定依据。
// ─────────────────────────────────────────────────────────────
async function samplePlatform(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const h = await getJSON("https://" + PLATFORM_HOST + "/api/health?sharecode=" + SHARE);
    const g = await getJSON("https://" + PLATFORM_HOST + "/api/data/gold?sharecode=" + SHARE);
    if (h) out.push(Object.assign({}, h, { gold: g }));
    if (i < n - 1) await new Promise((r) => setTimeout(r, 400));
  }
  return out;
}

function ageMin(iso) {
  if (!iso) return NaN;
  const t = Date.parse(iso);
  if (isNaN(t)) return NaN;
  return (Date.now() - t) / 60000;
}

(async () => {
  const problems = [];
  const info = [];

  // ── ① 真源 GH Pages 新鲜度（最关键）──
  //
  // 【C44·重试确认】单次取不到真源就报「真源异常」过于敏感：
  //   实测 Actions runner 偶发一次网络抖动（前一秒刚成功读到），巡检就立刻告警。
  //   真源是"最不该误报"的对象 —— 它一旦真挂，所有设备（手机网页/小程序/PC）都受影响，
  //   误报的代价是让人以为整条链路崩了，而实际只需等下一轮。
  //   故：单次失败先重试（最多 CANON_RETRY 次、间隔 CANON_RETRY_GAP_MS），
  //   仍失败才判「真源不可达」；若期间任一次成功 → 完全正常。
  let canon = null;
  let canonAttempts = 0;
  for (let i = 0; i <= CANON_RETRY; i++) {
    canonAttempts++;
    canon = await getJSON(GH_PAGES_CANON + "/meta.json");
    if (canon) break;
    if (i < CANON_RETRY) await new Promise((r) => setTimeout(r, CANON_RETRY_GAP_MS));
  }
  if (!canon) {
    problems.push("【真源异常】GH Pages 元数据不可达（已重试 " + canonAttempts + " 次，" + GH_PAGES_CANON + "/meta.json），" +
      "GitHub Actions（refresh.yml）可能未运行或网络故障，手机网页与已发布小程序会读到旧数据");
  } else {
    const age = ageMin(canon.generatedAt);
    console.log("[canon] generatedAt=" + canon.generatedAt +
      " (" + (isNaN(age) ? "?" : Math.round(age)) + " 分钟前) dataMode=" + (canon.dataMode || "?"));
    if (isNaN(age) || age > MAX_AGE_MIN) {
      problems.push("【真源陈旧】GH Pages 数据不新鲜：generatedAt=" + canon.generatedAt +
        "（" + (isNaN(age) ? "?" : Math.round(age)) + " 分钟前，上限 " + MAX_AGE_MIN + " 分钟）。" +
        "通常是 GitHub Actions（refresh.yml）未运行/失败，手机网页与已发布小程序会读到旧数据。");
    }

    // ── ② 平台吐出的数据是否与真源对齐 ──
    //
    // 【C44·多次采样取最优】此前只采样一次。实测在**部署滚动更新窗口**内，
    //   网关会把请求分发到新旧两个实例：老实例吐旧部署快照（落后 133 分钟），
    //   新实例已同步好（漂移 0）。单次采样随机命中老实例 → 误报「平台落后真源」，
    //   而平台其实完全正常 —— 这类误报比真故障更伤，因为处置建议是「重发平台版」，
    //   会把人引向错误方向（实际不需要任何处置）。
    //   故改为：采样 N 次，按「数据最新」取最优副本作为判定依据；
    //   同时记录是否见到副本不一致（有则作为 info 提示，不算故障）。
    const samples = await samplePlatform(PROBE_SAMPLES);
    const distinct = new Set(samples.map((s) => (s.processStartAt || "?") + "|" + ((s.updatedAt || {})["meta.json"] || "-")));
    let health = null;
    let gold = null;
    for (const s of samples) {
      if (!s) continue;
      const sTs = ((s.updatedAt || {})["meta.json"]) || "";
      const hTs = (health && ((health.updatedAt || {})["meta.json"] || "")) || "";
      // 取「数据更新时间最新」的那份；同样新则取 lastGenOk=true 的那份
      const better = !health
        || (sTs > hTs)
        || (sTs === hTs && s.lastGenOk === true && health.lastGenOk !== true);
      if (better) { health = s; gold = s.gold; }
    }
    if (samples.length && distinct.size > 1) {
      info.push("平台存在 " + distinct.size + " 个副本（部署滚动更新窗口内），已按数据最新的副本判定");
      console.log("[platform] 副本分布：" + Array.from(distinct).join(" | "));
    }
    if (!health) {
      problems.push("平台 /api/health 不可达（" + PLATFORM_HOST + "）");
    } else {
      console.log("[platform] role=" + health.role + " lastGenOk=" + health.lastGenOk +
        " updatedAt.gold=" + ((health.updatedAt || {})["gold.json"] || "-") +
        "（采样 " + samples.filter(Boolean).length + " 次）");
      if (health.role && health.role !== "readonly-proxy") {
        info.push("平台仍运行旧架构（role=" + health.role + "），建议重发 C37 只读代理版");
      }

      // ── ②a 平台自报同步状态（最强信号，优先于漂移计算）──
      // 【C43】lastGenOk=false 表示平台最近一轮真源同步失败。
      //   这是「平台侧链路故障」的直接证据，且能区分病因：
      //     · source.mirrors 全空 → 真源镜像池（GH Pages/jsDelivr/raw）全部不可达 → 平台出网问题
      //     · source.mirrors 非空但仍失败 → 镜像可用但取文件失败 → 单文件/大文件问题
      //   无论漂移多少分钟都要报：否则「平台已挂 + 真源恰好更新」时会因漂移未超阈值而静默，
      //   等双故障叠加才暴露 —— 那正是「牵一发而动全身」被延误的典型形态。
      const src = health.source || {};
      // ── 冷启动宽限 ──
      // 【C43·修正误判】平台容器刚重启时，boot() 的首轮真源同步尚未完成，
      //   此时 /api/health 的状态量仍停在初始值（lastGenOk=false、lastError 空、
      //   镜像列表空）—— 与「真源镜像池全部不可达」的指纹**完全一样**。
      //   实测：部署后十几秒内巡检会误报「三路镜像全部不可达 → 重发平台版」，
      //   而平台其实 2 秒后就同步成功了 → 假警报 + 无效处置建议。
      //   判据：generatedAt 为空 = 平台**从未成功同步过**（刚起来）→ 给宽限期；
      //   真故障平台跑过一阵后 generatedAt 一定有值（哪怕那次成功是很久以前），
      //   此时再报才是真告警。
      //   注意不能用「updatedAt 是否有值」判断：部署包自带的磁盘快照也有时间戳，
      //   冷启动期间 updatedAt 非空，但同步确实还没成功过一次。
      // 【C44·宽限不能被滥用】用 lastSuccessAt（跨重启持久化的「最近一次成功同步时间」）：
      //   · 本进程没成功过、但历史上成功过 → 真冷启动 → 宽限；
      //   · 连历史记录都没有 → 该实例从上线起就没成功同步过 → 真故障，不宽限；
      //   · 进程启动已超 COLD_START_GRACE_MIN 分钟仍未成功 → 真故障。
      //   否则「反复重启、每次都没同步成功」会被冷启动宽限无限掩盖。
      const coldStart = !health.generatedAt;
      const everSynced = !!(health.lastSuccessAt || health.generatedAt);
      const upMin = health.processStartAt ? ageMin(health.processStartAt) : NaN;
      const coldStartExpired = coldStart
        && (!everSynced || (!isNaN(upMin) && upMin > COLD_START_GRACE_MIN));
      if (coldStart && !coldStartExpired) {
        info.push("平台刚启动（尚未完成首轮真源同步，状态量仍为初值），本次不判定为故障");
      } else if (health.lastGenOk === false) {
        const mirrors = (src.mirrors || []).join(",");
        const head = coldStartExpired
          ? "【平台同步失败·冷启动超时】平台启动已 " + Math.round(upMin) + " 分钟仍未成功同步过一次真源"
            + "（超过 " + COLD_START_GRACE_MIN + " 分钟宽限期）"
          : "【平台同步失败】平台自报最近一轮真源同步失败（lastGenOk=false）";
        problems.push(
          head + "。" +
          "lastError=" + JSON.stringify(health.lastError || "(空)") +
          "；可用镜像=" + (mirrors || "无（三路真源镜像全部不可达）") +
          "。平台当前只能服务上一轮缓存/部署快照，PC 网页与小程序云函数可能读到陈旧价格。" +
          (mirrors
            ? "处置：平台可连通真源镜像但取文件失败 → 检查 events.json 等大文件是否被链路掐断（当前已加多镜像+硬超时+局部隔离，应已自愈；仍失败则重发平台版）。"
            : "处置：平台沙箱无法连通 GH Pages/jsDelivr/raw 任一出口 → 重发平台版以带上新固件（多镜像+硬超时+自愈重试）。"));
      } else if (health.lastGenOk === true && health.lastError) {
        info.push("平台同步正常（lastError=" + JSON.stringify(health.lastError) + "）");
      }

      // ── ②b 数据漂移 ──
      // 平台吐出的实际数据时间戳（gold 末值入库时间），而非缓存时间戳
      const platTs = (gold && (gold.lastUpdate || (gold.meta && gold.meta.generatedAt))) ||
        ((health.updatedAt || {})["gold.json"]);
      if (platTs) {
        const drift = ageMin(platTs) - ageMin(canon.generatedAt); // 正 = 平台落后于真源
        console.log("[platform] served lastUpdate=" + platTs + " 落后真源约 " + Math.round(drift) + " 分钟");
        // 平台同步已失败 / 冷启动中时，漂移告警并入上面那条或直接跳过
        // （避免同一病因报两次、噪音翻倍；也避免冷启动期误报"落后真源"）
        if (coldStart && !coldStartExpired) {
          info.push("平台冷启动中，本轮不判定漂移");
        } else if (health.lastGenOk !== false) {
          if (drift > DRIFT_WARN_MIN) {
            problems.push("【平台落后真源】平台吐出数据（" + platTs + "）落后 GH Pages 真源（" + canon.generatedAt +
              "）约 " + Math.round(drift) + " 分钟，超出 " + DRIFT_WARN_MIN + " 分钟阈值。" +
              "平台每 15 分钟同步一次真源，正常漂移应 < 15 分钟，故此为异常。" +
              "处置：重发平台版（随包注入最新 data/，或确保平台能同步 GH Pages 真源）。");
          } else if (drift > 20) {
            info.push("平台数据落后真源约 " + Math.round(drift) + " 分钟（平台每 15 分钟同步一次，阈值 " + DRIFT_WARN_MIN + " 分钟）");
          }
        }
      } else {
        problems.push("平台未返回可用数据时间戳（gold.lastUpdate 缺失，/api/data/gold 可能异常）");
      }
    }
  }

  // ── ③ 事件体检（视觉同形重复 + 日期漂移）—— 沿用 C19/C24 逻辑 ──
  const events = await getJSON("https://" + PLATFORM_HOST + "/api/events?sharecode=" + SHARE);
  if (events && events.gold) {
    for (const metal of ["gold", "silver", "copper"]) {
      const arr = events[metal] || [];
      let drift = 0;
      for (const e of arr) {
        const m2 = String(e.url || "").match(/\/(\d{4})\/(\d{2})\/(\d{2})(?:\/|-|_)/);
        if (m2 && (m2[1] + "-" + m2[2] + "-" + m2[3]) !== e.date) drift++;
      }
      if (drift) problems.push("事件日期漂移：" + metal + " 有 " + drift + " 条的日期与 URL 发布日不一致");
      const dup = [];
      for (let i = 0; i < arr.length; i++) {
        for (let k = i + 1; k < arr.length; k++) {
          const a = arr[i], b = arr[k];
          if (Math.abs(new Date(a.date) - new Date(b.date)) / 86400000 > 1) continue;
          const sa = ED.skeletonKey(a.summary, a.tags), sb = ED.skeletonKey(b.summary, b.tags);
          if (sa && sa === sb && sa.length >= 12 && ED.tagsOverlap(a.tags, b.tags)) {
            dup.push("《" + a.title + "》(" + a.date + ") vs 《" + b.title + "》(" + b.date + ")");
          }
        }
      }
      if (dup.length) {
        problems.push("事件列表存在视觉同形重复（" + metal + "，" + dup.length + " 对）：" + dup.slice(0, 3).join("；"));
      }
    }
    console.log("[platform] 事件体检完成（gold " + events.gold.length + " 条）");
  } else {
    console.warn("[platform] 事件数据不可达，跳过事件体检");
  }

  // ── 汇总 ──
  if (problems.length) {
    console.error("[check_platform] 发现 " + problems.length + " 项异常：");
    problems.forEach((p) => console.error("  ✗ " + p));
    try {
      await notify.alert("贵金属监测 · 平台真源巡检异常",
        problems.join("\n") + (info.length ? "\n\n附：\n" + info.join("\n") : ""),
        "platform-health");
    } catch (e) {
      console.warn("[check_platform] 告警发送失败：" + (e && e.message));
    }
    process.exit(1);
  }
  console.log("[check_platform] 全部正常（GH Pages 真源新鲜" +
    (info.length ? "；" + info.join("；") : "") + "）");
})();
