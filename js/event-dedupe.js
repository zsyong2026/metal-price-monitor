/**
 * event-dedupe.js —— 重大事件去重规范（收集 → 清洗 → 入库 全链路唯一去重口径）
 *
 * 约定：本文件是「唯一去重实现」，PC 网页（generate.js 管线）、手机网页（同一份
 * data/events.json）、微信小程序（同一份数据）三端共用同一套规则，避免各端各自
 * 实现导致口径漂移。
 *
 * 运行环境：Node（module.exports）与浏览器/小程序（挂载到 global）双兼容。
 *
 * 去重六原则（命中任意一条即判定为重复，按「保留优先级」留一条）：
 *   P1 标题指纹相同        —— 归一化标题完全一致，且事件日期相差 ≤2 天（同题不同天=连续报道，不算重复）
 *   P2 摘要指纹相同        —— 归一化摘要前 40 字完全一致且日期相近；仅当摘要有实质内容（≥20 字）
 *                            才启用，通用短摘要（如"对贵金属影响：影响偏中性"）不含判别信息，不参与判重
 *   P3 同日期 · 标题互含   —— 同一天，且一条标题是另一条的子串（≥8 字）
 *   P4 近日期 · 近义标题   —— 日期相差 ≤2 天，且标题 token Jaccard ≥ 0.62
 *   P5 同日期 · 高度近义   —— 同一天，且标题 token Jaccard ≥ 0.72（跨源同一事件措辞不同）
 *   P6 同日/相邻日 · 同模板摘要且标签重叠（C19）—— 规则化归纳出的条目，摘要常退化成同一句模板
 *                            （"外媒报道，X方面出现新动向。对贵金属影响：…"），两条不同原文可能
 *                            只差一个关键词，标题 Jaccard 约 0.60（卡在 P5 阈值 0.72 之下）而漏判，
 *                            但展示上完全同形（连相关性数值都因同一事件窗而相同）→ 用户看到「重复」。
 *                            判定：同日或相邻日 + 摘要剔除各自标签后骨架完全一致 + 两条标签集合有交集
 *                            （交集保证是同一话题，如「美联储·冲突」与「美联储·楼市」判重，
 *                             而「美联储·冲突」与「通胀·关税」骨架虽同但标签无交集，不判重）
 *
 * 保留优先级（谁留下）：人工/种子 > 摘要信息量足 > 来源权威度高 > 有原文链接 > 日期更新
 * 被剔除条目的标签会并入保留条目（信息不丢：合并后 tags 同时含「冲突」「楼市」）
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.EDedupe = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var PUNCT_RE = /[\s\u3000!-\/:-@\[-`{-~\u2000-\u206f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65\u00b7\u2022\u2026\u2013\u2015]*/g;

  /** 全角 → 半角 */
  function toHalf(s) {
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 0x3000) out += " ";
      else if (c >= 0xff01 && c <= 0xff5e) out += String.fromCharCode(c - 0xfee0);
      else out += s.charAt(i);
    }
    return out;
  }

  /** 去掉摘要/标题里的【分类】前缀（分类在卡片顶行已单独展示） */
  function stripCatPrefix(s) {
    return String(s || "").replace(/^\s*[\u3010\[][^\u3011\]]{1,12}[\u3011\]]\s*/, "");
  }

  /** 标题指纹：去前缀 + 全角转半角 + 去标点空格 + 小写 */
  function normTitle(s) {
    var t = stripCatPrefix(s);
    t = toHalf(t).toLowerCase();
    t = t.replace(/[（(][^）)]*[）)]/g, ""); // 去括号补充语
    t = t.replace(PUNCT_RE, "");
    return t;
  }

  /** 摘要指纹：去前缀 + 去标点空格 + 取前 40 字 */
  function descKey(s, n) {
    var t = stripCatPrefix(s);
    t = toHalf(t).toLowerCase().replace(PUNCT_RE, "");
    return t.slice(0, n || 40);
  }

  /** 标题 token 集合：英文按词，中文按 2-gram（避免单字噪声） */
  function tokSet(s) {
    var t = normTitle(s);
    var set = Object.create(null);
    var i;
    // 英文/数字词
    var words = t.match(/[a-z0-9]{2,}/g) || [];
    for (i = 0; i < words.length; i++) set[words[i]] = 1;
    // 中文 2-gram
    var han = t.replace(/[a-z0-9]/g, "");
    for (i = 0; i + 2 <= han.length; i++) set[han.substr(i, 2)] = 1;
    return Object.keys(set);
  }

  /**
   * 摘要骨架（C19 / P6）：剔除本条自己的标签词后的残余文本。
   * 规则化归纳的通用模板摘要（"外媒报道，X方面出现新动向。对贵金属影响：…"）去掉变量关键词后，
   * 剩下的模板部分完全一致 → 即「同一模板」；据此识别视觉同形的重复条目。
   */
  function skeletonKey(summary, tags) {
    var t = String(summary || "");
    var arr = Array.isArray(tags) ? tags : (tags ? [tags] : []);
    for (var i = 0; i < arr.length; i++) {
      var tag = String(arr[i] || "").trim();
      if (!tag) continue;
      t = t.split(tag).join("");
    }
    return descKey(t, 60);
  }

  /** 两个标签集合是否有交集（同一话题判定） */
  function tagsOverlap(a, b) {
    var A = Array.isArray(a) ? a : (a ? [a] : []);
    var B = Array.isArray(b) ? b : (b ? [b] : []);
    for (var i = 0; i < A.length; i++) {
      if (A[i] && B.indexOf(A[i]) >= 0) return true;
    }
    return false;
  }

  /** 把被剔除条目的标签并入保留条目（信息不丢） */
  function mergeTags(keeper, dropped) {
    if (!keeper) return keeper;
    var kt = Array.isArray(keeper.tags) ? keeper.tags : (keeper.tags = []);
    var dt = Array.isArray(dropped && dropped.tags) ? dropped.tags : [];
    for (var i = 0; i < dt.length; i++) {
      if (dt[i] && kt.indexOf(dt[i]) < 0) kt.push(dt[i]);
    }
    return keeper;
  }

  function jaccard(a, b) {
    if (!a.length || !b.length) return 0;
    var A = Object.create(null), B = Object.create(null), i;
    for (i = 0; i < a.length; i++) A[a[i]] = 1;
    var inter = 0;
    for (i = 0; i < b.length; i++) {
      if (B[b[i]]) continue;
      B[b[i]] = 1;
      if (A[b[i]]) inter++;
    }
    var na = Object.keys(A).length, nb = Object.keys(B).length;
    return inter / (na + nb - inter);
  }

  function dayDiff(d1, d2) {
    if (!d1 || !d2) return 999;
    var a = Date.parse(d1 + "T00:00:00Z"), b = Date.parse(d2 + "T00:00:00Z");
    if (isNaN(a) || isNaN(b)) return 999;
    return Math.abs(a - b) / 86400000;
  }

  /** 保留优先级打分：越大越该留下 */
  function keepScore(e) {
    var s = 0;
    if (!e || typeof e !== "object") return -1e9;
    if (!e.auto) s += 1000;                                  // 人工/种子条目优先
    s += Math.min(String(e.summary || e.desc || "").length, 200); // 摘要信息量
    s += authorityOf(e.source) * 20;                          // 来源权威度
    if (e.url) s += 30;
    if (e.category) s += 10;
    return s;
  }

  var AUTHORITY = [
    ["wsj", 5], ["wall street", 5],
    ["reuters", 5], ["路透", 5],
    ["cnbc", 4],
    ["bloomberg", 4], ["彭博", 4],
    ["fed", 4], ["美联储", 4],
    ["ft", 3], ["financial times", 3],
    ["新华社", 4], ["人民", 3], ["央视", 3],
    ["自动归纳", 1],
  ];
  function authorityOf(src) {
    var s = String(src || "").toLowerCase();
    for (var i = 0; i < AUTHORITY.length; i++) {
      if (s.indexOf(AUTHORITY[i][0]) >= 0) return AUTHORITY[i][1];
    }
    return 2;
  }

  /**
   * 核心：给一批事件去重（同一 metal 内）
   * @param {Array} arr 原始事件数组
   * @param {Object} [opt] { jaccardNear:0.62, jaccardSame:0.75, nearDays:2, descLen:40, verbose:false }
   * @returns {{list:Array, dropped:Array}} list 已按保留优先级剔除重复；dropped 为被剔除项及原因
   *
   * 日期守卫（重要）：P1/P2 指纹命中还要求事件日期相差 ≤ nearDays 天。
   * 规则化归纳标题粒度粗（"加息·美联储：多空交织"），同一话题不同日期的新闻
   * 会生成相同标题——那是两条独立事件（连续报道），不是重复；
   * 只有「同题且同期」才判重（也覆盖跨品种入库的同一事件同日期副本）。
   */
  function dedupeEvents(arr, opt) {
    opt = opt || {};
    var wantResidual = opt.residual === true;
    var J_NEAR = opt.jaccardNear == null ? 0.62 : opt.jaccardNear;
    var J_SAME = opt.jaccardSame == null ? 0.72 : opt.jaccardSame;
    var NEAR_DAYS = opt.nearDays == null ? 2 : opt.nearDays;
    var DESC_LEN = opt.descLen == null ? 40 : opt.descLen;
    var DESC_MIN = opt.descMinLen == null ? 20 : opt.descMinLen; // 摘要指纹最短有效长度

    // 先按保留优先级降序，保证「更该留下的先占位」
    var src = (arr || []).slice().sort(function (a, b) {
      return keepScore(b) - keepScore(a);
    });

    var kept = [];      // 已保留条目
    var dropped = [];   // { item, reason, keeper }
    var byTitle = Object.create(null);   // P1：tk -> [events]（同指纹可能有多条，按日期近邻匹配）
    var byDesc = Object.create(null);    // P2：dk -> [events]
    var bySkel = Object.create(null);     // P6：摘要骨架（剔除标签后的模板）-> [events]

    // 指纹命中后，还要日期相近才算重复（防止同题不同天的连续报道互撞）
    function nearHit(bucket, date) {
      if (!bucket) return null;
      for (var i = 0; i < bucket.length; i++) {
        if (dayDiff(date, bucket[i].date) <= NEAR_DAYS) return bucket[i];
      }
      return null;
    }
    function pushBucket(bucketMap, key, e) {
      if (!key) return;
      (bucketMap[key] || (bucketMap[key] = [])).push(e);
    }

    for (var i = 0; i < src.length; i++) {
      var e = src[i];
      if (!e) continue;
      var tk = normTitle(e.title);
      var dk = descKey(e.summary || e.desc, DESC_LEN);
      var date = e.date || "";
      var toks = null;
      var hit = null, reason = "";

      var tHit = nearHit(byTitle[tk], date);
      if (tk && tHit) { hit = tHit; reason = "P1标题指纹相同"; }
      else {
        var dHit = (dk && dk.length >= DESC_MIN) ? nearHit(byDesc[dk], date) : null;
        if (dHit) { hit = dHit; reason = "P2摘要指纹相同"; }
      }

      // strict=true 时只跑强指纹（P1/P2），不做模糊判定（用于门禁校验，避免误判堵住发布）
      if (!hit && !opt.strict) {
        toks = tokSet(e.title);
        for (var j = 0; j < kept.length && !hit; j++) {
          var k = kept[j];
          var dd = dayDiff(date, k.date);
          var ka = normTitle(k.title);
          // P3 同日期·标题互含
          if (dd === 0 && tk.length >= 8 && ka.length >= 8 && (tk.indexOf(ka) >= 0 || ka.indexOf(tk) >= 0)) {
            hit = k; reason = "P3同日期标题互含"; break;
          }
          if (dd <= NEAR_DAYS) {
            var sim = jaccard(toks, tokSet(k.title));
            if (sim >= J_SAME) { hit = k; reason = "P5同/近日期高度近义(" + sim.toFixed(2) + ")"; break; }
            if (sim >= J_NEAR && dd > 0) { hit = k; reason = "P4近日期近义(" + sim.toFixed(2) + ",±" + dd + "天)"; break; }
          }
        }
      }

      // P6（C19）：同日/相邻日 · 摘要同模板（剔除各自标签后骨架一致）· 标签有交集
      // —— 抓「标题只差一个词、摘要同一句模板」的视觉同形重复（标题 Jaccard 约 0.60，够不到 P5 阈值）
      // 容差 ±1 天：同一话题的报道常跨 UTC 日界发布（且 RSS 的 pubDate 会被发布方刷新）
      if (!hit && !opt.strict) {
        var sk = skeletonKey(e.summary || e.desc, e.tags);
        if (sk && sk.length >= 12) {
          var sb = bySkel[sk] || [];
          for (var s = 0; s < sb.length; s++) {
            if (dayDiff(date, sb[s].date) > 1) continue;
            if (!tagsOverlap(e.tags, sb[s].tags)) continue;
            hit = sb[s]; reason = "P6同/相邻日同模板摘要且标签重叠"; break;
          }
        }
      }

      if (hit) {
        mergeTags(hit, e); // 被剔除条目的标签并入保留条目（信息不丢）
        dropped.push({ item: e, reason: reason, keeper: hit.title }); continue;
      }

      kept.push(e);
      pushBucket(byTitle, tk, e);
      if (dk && dk.length >= 8) pushBucket(byDesc, dk, e);
      var skKeep = skeletonKey(e.summary || e.desc, e.tags);
      if (skKeep && skKeep.length >= 12) pushBucket(bySkel, skKeep, e);
    }

    // 输出前复核：kept 内部不应再有任何重复（仅显式要求时才算，避免与 findDuplicates 互相递归）
    var residual = [];
    if (wantResidual) residual = findDuplicates(kept, opt);
    return { list: kept, dropped: dropped, residual: residual };
  }

  /**
   * 只做「检测」不改数据：返回所有重复组（用于门禁校验 / 自测）
   * @returns {Array} [{ reason, items:[...] }]
   */
  function findDuplicates(arr, opt) {
    var r = dedupeEvents(arr, Object.assign({}, opt || {}, { residual: false }));
    var groups = Object.create(null);
    (r.dropped || []).forEach(function (d) {
      var ktitle = normTitle(d.keeper) || "_";
      var key = d.reason.replace(/\(.*\)/, "") + "|" + ktitle;
      (groups[key] = groups[key] || { reason: d.reason, keeper: d.keeper, items: [] }).items.push(d.item.title);
    });
    return Object.keys(groups).map(function (k) { return groups[k]; });
  }

  /**
   * 跨品种去重：同一条宏观事件被自动归纳同时写入 gold / silver / copper 时，
   * 只保留一份「正本」，并在正本上用 metals[] 记录它影响的全部品种；
   * 其余品种数组里删除副本。这样「合并展示」不会重复，「按品种查看」也不丢事件。
   *
   * 合并前提（防误伤人工条目）：
   *   - 两者指纹（标题指纹 / 摘要指纹 / 原文链接）命中，且
   *   - 两者同为 auto（自动归纳）或原文链接完全相同
   *
   * @param {Object} map { gold:[], silver:[], copper:[] }
   * @param {Object} [opt] { order:["gold","silver","copper"] }
   * @returns {{map:Object, dropped:Array, merged:Number}}
   */
  function dedupeCrossMetal(map, opt) {
    opt = opt || {};
    var order = opt.order || ["gold", "silver", "copper"];
    var src = {};
    order.forEach(function (m) { src[m] = ((map && map[m]) || []).slice(); });

    // 先做品种内去重
    order.forEach(function (m) { src[m] = dedupeEvents(src[m], { residual: false }).list; });

    var byTitle = Object.create(null);
    var byDesc = Object.create(null);
    var byUrl = Object.create(null);
    var out = {};
    var dropped = [];
    // 跨品种合并同样要求摘要有实质内容（与品种内 P2 同口径）
    var DESC_MIN = 20;
    // 日期守卫（与品种内 P1/P2 同口径）：同题不同天是两条独立事件，不跨品种合并
    var NEAR_DAYS = 2;
    order.forEach(function (m) { out[m] = []; });

    function mergeMetals(e, m) {
      var ms = Array.isArray(e.metals) ? e.metals.slice() : [e._m || m];
      if (ms.indexOf(m) < 0) ms.push(m);
      // 固定顺序，便于比对与展示
      ms.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
      e.metals = ms;
    }

    // 指纹桶里找日期相近的正本（桶可能是多条：同题不同天的独立事件各占一条）
    function nearKeeper(bucket, date) {
      if (!bucket) return null;
      for (var i = 0; i < bucket.length; i++) {
        if (dayDiff(date, bucket[i].date) <= NEAR_DAYS) return bucket[i];
      }
      return null;
    }
    function pushBucket(bucketMap, key, e) {
      if (!key) return;
      (bucketMap[key] || (bucketMap[key] = [])).push(e);
    }

    for (var i = 0; i < order.length; i++) {
      var m = order[i];
      for (var j = 0; j < src[m].length; j++) {
        var e = src[m][j];
        if (!e) continue;
        var tk = normTitle(e.title);
        var dk = descKey(e.summary || e.desc, 40);
        var url = String(e.url || "").trim();
        var date = e.date || "";
        var keeper = null, reason = "";

        var tKeeper = tk ? nearKeeper(byTitle[tk], date) : null;
        if (tKeeper) { keeper = tKeeper; reason = "跨品种·标题指纹相同"; }
        else {
          var dKeeper = (dk && dk.length >= 8) ? nearKeeper(byDesc[dk], date) : null;
          if (dKeeper) { keeper = dKeeper; reason = "跨品种·摘要指纹相同"; }
          else if (url && byUrl[url] !== undefined) { keeper = byUrl[url]; reason = "跨品种·原文链接相同"; }
        }

        if (keeper && keeper !== e) {
          var canMerge = (!!keeper.auto && !!e.auto) ||
            (url && String(keeper.url || "").trim() === url);
          if (!canMerge) { // 人工/种子条目不做跨品种合并，避免误删策展内容
            out[m].push(e);
            continue;
          }
          mergeMetals(keeper, m);
          dropped.push({ metal: m, reason: reason, item: e, keeper: keeper.title });
          continue;
        }

        if (!Array.isArray(e.metals) || !e.metals.length) e.metals = [m];
        out[m].push(e);
        pushBucket(byTitle, tk, e);
        if (dk && dk.length >= DESC_MIN) pushBucket(byDesc, dk, e);
        if (url) byUrl[url] = e;
      }
    }
    return { map: out, dropped: dropped, merged: dropped.length };
  }

  /** 按品种取事件（渲染层统一用这个方法，兼容「正本+metals[]」与历史无 metals 字段的数据） */
  function eventsFor(map, metal) {
    var res = [];
    var keys = Object.keys(map || {});
    for (var i = 0; i < keys.length; i++) {
      var m = keys[i], arr = (map[m] || []);
      for (var j = 0; j < arr.length; j++) {
        var e = arr[j];
        if (!e) continue;
        var ms = (Array.isArray(e.metals) && e.metals.length) ? e.metals : [m];
        if (ms.indexOf(metal) >= 0) res.push(e);
      }
    }
    res.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    return res;
  }

  /** 全量合并（跨品种已去重，可直接用于「全部」视图） */
  function eventsAll(map, opt) {
    var res = [];
    var keys = Object.keys(map || {});
    for (var i = 0; i < keys.length; i++) {
      (map[keys[i]] || []).forEach(function (e) { if (e) res.push(Object.assign({}, e, { _m: keys[i] })); });
    }
    res.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    if (opt && opt.dedupe !== false) res = dedupeEvents(res, { residual: false }).list;
    return res;
  }

  /** 清洗：去摘要里的【分类】前缀（与去重同源，保证指纹稳定） */
  function cleanEvent(e) {
    if (!e) return e;
    if (e.summary) e.summary = stripCatPrefix(e.summary);
    if (e.desc) e.desc = stripCatPrefix(e.desc);
    if (e.title) e.title = String(e.title).replace(/^\s+|\s+$/g, "").slice(0, 90);
    return e;
  }

  return {
    toHalf: toHalf,
    stripCatPrefix: stripCatPrefix,
    normTitle: normTitle,
    descKey: descKey,
    tokSet: tokSet,
    skeletonKey: skeletonKey,
    tagsOverlap: tagsOverlap,
    mergeTags: mergeTags,
    jaccard: jaccard,
    dayDiff: dayDiff,
    keepScore: keepScore,
    authorityOf: authorityOf,
    dedupeEvents: dedupeEvents,
    dedupeCrossMetal: dedupeCrossMetal,
    findDuplicates: findDuplicates,
    eventsFor: eventsFor,
    eventsAll: eventsAll,
    cleanEvent: cleanEvent,
  };
});
