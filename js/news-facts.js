/**
 * news-facts.js —— 事件「具体化」能力包（网页版 generate.js 与云函数 generate-core.js 共用）
 *
 * 【C20 需求】① 事件摘要要让人知道「具体发生了什么」（原来只有关键词拼装 + 通用兜底模板）
 *              ② 事件源要国内 + 国外都抓（原来 7 个源全是国外，且 2 个已停更 639 天）
 *
 * 本模块提供三块能力：
 *   A. zhFact()        —— 英文标题 → 具体中文事实（规则化抽取，如「Fed leaves rates unchanged」
 *                        → 「美联储维持利率不变（不加息）」）。这是「用户知道是个啥事」的核心。
 *   B. zhImpact()      —— 已知事实时给出更具体的影响结论（而不是笼统的「方向待确认」）。
 *   C. 国内源解析      —— 东方财富快讯 / 华尔街见闻 快讯（JSON/JSONP）→ 统一条目结构，
 *                        并对「国内快讯噪声」做门禁（地方债/逆回购/个股公告等非贵金属事件不入库）。
 *
 * 运行环境：纯 CommonJS（Node），网页版与云函数两端共用同一份文件 → 口径天然一致。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NewsFacts = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* ================= A. 英文标题 → 具体中文事实 ================= */

  // 实体小译（用于关税对象等专有名词）；多对象时逐个翻译并用「和」连接
  var ENT = {
    canada: "加拿大", china: "中国", mexico: "墨西哥", japan: "日本", india: "印度",
    eu: "欧盟", europe: "欧洲", uk: "英国", britain: "英国", germany: "德国", france: "法国",
    russia: "俄罗斯", ukraine: "乌克兰", brazil: "巴西", korea: "韩国", australia: "澳大利亚",
    vietnam: "越南", taiwan: "台湾", israel: "以色列", iran: "伊朗", saudi: "沙特",
    automobiles: "汽车", auto: "汽车", steel: "钢铁", aluminum: "铝", semiconductor: "半导体",
    chips: "芯片", pharmaceuticals: "医药", ev: "电动车",
  };
  function ent(s) {
    var w = String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!w) return "";
    if (ENT[w]) return ENT[w];                       // 整串就是一个实体
    var out = w;
    Object.keys(ENT).forEach(function (k) {
      if (k.length < 4) return;                       // 短词（eu/uk/ev）只做整词匹配，避免误替换
      out = out.replace(new RegExp("\\b" + k + "\\b", "g"), ENT[k]);
    });
    out = out.replace(/\band\b/g, "和").replace(/\s+/g, " ");
    return out.slice(0, 24);
  }

  // 规则表：按顺序匹配，命中即用（第一条命中即返回）
  var RULES = [
    // —— 美联储利率决定（用户最关心的「不加息/加息/降息」）——
    { re: /\bfed\b[\s\S]{0,50}?(leaves?|holds?|kept|keeps?)\s+(its\s+)?rates?\s+(unchanged|steady|on hold|put on hold)/i,
      zh: "美联储维持利率不变（不加息）" },
    { re: /(leaves?|holds?|kept|keeps?)\s+(interest\s+)?rates?\s+(unchanged|steady)/i,
      zh: "央行维持利率不变" },
    { re: /\bfed\b[\s\S]{0,50}?(raises?|raised|hikes?|hiked|increasing|increase)\s+(interest\s+)?rates?/i,
      zh: "美联储加息" },
    { re: /\bfed\b[\s\S]{0,50}?(cuts?|cut|lowers?|lowered|reduces?|reduced)\s+(interest\s+)?rates?/i,
      zh: "美联储降息" },
    { re: /(no|not any)\s+(rate\s+)?hike(s)?\s+expected|no\s+rate\s+hike|expects?\s+the\s+fed\s+to\s+(pause|hold|stand\s+pat)/i,
      zh: "市场预计美联储暂不加息" },
    { re: /\bfed\b[\s\S]{0,30}?(meeting|decision|announcement|statement|news conference|press conference|rate decision)/i,
      zh: "美联储议息会议", gen: true },
    { re: /news conference|press conference/i, zh: "美联储新闻发布会", gen: true },
    { re: /warsh/i, zh: "美联储主席人选沃什" },
    { re: /\bfed\b[\s\S]{0,40}?(signals?|signaled|points? to|seen)\s+[\s\S]{0,30}?(cut|hike|rate)/i,
      zh: "美联储释放降息信号" },
    // —— 通胀 / 就业 / 经济数据 ——
    { re: /\bcpi\b[\s\S]{0,40}?(\d+(?:\.\d+)?)\s*%/i,
      zh: function (m) { return "美国 CPI 同比 " + m[1] + "%"; } },
    { re: /consumer prices?[\s\S]{0,40}?(\d+(?:\.\d+)?)\s*%/i,
      zh: function (m) { return "美国消费者物价指数 " + m[1] + "%"; } },
    { re: /inflation[\s\S]{0,50}?(\d+(?:\.\d+)?)\s*%/i,
      zh: function (m) { return "美国通胀率 " + m[1] + "%"; } },
    { re: /inflation[\s\S]{0,40}?(cools?|eases?|slows?|falls?|drops?|rises?|accelerates?|hotter)/i,
      zh: "美国通胀数据出现变化", gen: true },
    { re: /payrolls?|nonfarm|jobs report[\s\S]{0,30}?(\d{1,3})[,\s]+(\d{3})\s*(k|thousand)?/i,
      zh: function (m) { return "美国非农就业新增 " + m[1] + "." + m[2] + " 万人"; } },
    { re: /unemployment rate[\s\S]{0,30}?(\d+(?:\.\d+)?)\s*%/i,
      zh: function (m) { return "美国失业率 " + m[1] + "%"; } },
    { re: /\bgdp\b[\s\S]{0,40}?(\d+(?:\.\d+)?)\s*%/i,
      zh: function (m) { return "美国 GDP " + m[1] + "%"; } },
    // —— 利率 / 债券 / 美元 ——
    { re: /treasury yields?[\s\S]{0,30}?(higher|rise|rose|tick(?:ed)? up|jump)/i,
      zh: "美债收益率上行" },
    { re: /treasury yields?[\s\S]{0,30}?(lower|fall|fell|tick(?:ed)? down|drop|slide)/i,
      zh: "美债收益率下行" },
    { re: /\bdollar[\s\S]{0,30}?(rall|surge|soar|jump|climb|strengthen|appreciat)/i,
      zh: "美元走强" },
    { re: /\bdollar[\s\S]{0,30}?(slump|tumble|sink|fall|slide|weaken|depreciat|retreat)/i,
      zh: "美元走弱" },
    { re: /\byen\b[\s\S]{0,20}?(weak|fall|drop|tumble|slide|sink)/i, zh: "日元走弱" },
    { re: /\byuan\b|\brmb\b|人民币[\s\S]{0,20}?(weaken|appreciat|strengthen|weaken)/i, zh: "人民币汇率波动", gen: true },
    // —— 关税 / 贸易 ——
    { re: /(\d+)%\s*tariffs?\s+on\s+([a-z ]{3,30})/i,
      zh: function (m) { return "美国对 " + ent(m[2]) + " 加征 " + m[1] + "% 关税"; } },
    { re: /tariffs?\s+on\s+([a-z ]{3,30})/i,
      zh: function (m) { return "美国对 " + ent(m[1]) + " 加征关税"; } },
    { re: /tariffs?[\s\S]{0,40}?(\d+)%/i,
      zh: function (m) { return "关税税率升至 " + m[1] + "%"; } },
    { re: /tariffs?|trade war/i, zh: "关税与贸易政策出现变化", gen: true },
    { re: /trade deal|trade agreement/i, zh: "达成贸易协议", gen: true },
    // —— 央行（境外） ——
    { re: /central bank[\s\S]{0,40}?(hike|raises?|raised|increase[sd]?)/i, zh: "央行加息" },
    { re: /central bank[\s\S]{0,40}?(cut|cuts?|lowers?|lowered|reduce[sd]?)/i, zh: "央行降息" },
    { re: /quantitative easing|\bqe\b/i, zh: "央行启动量化宽松" },
    // —— 贵金属自身 ——
    { re: /\bgold\b[\s\S]{0,30}?(surge|soar|jump|record high|climb|rally|spike)/i, zh: "金价大涨" },
    { re: /\bgold\b[\s\S]{0,30}?(slump|fall|slide|drop|tumble|sink|plunge|retreat)/i, zh: "金价下跌" },
    { re: /\bsilver\b[\s\S]{0,30}?(surge|soar|jump|rally|spike)/i, zh: "银价大涨" },
    { re: /\bsilver\b[\s\S]{0,30}?(slump|fall|slide|drop|tumble|sink|plunge)/i, zh: "银价下跌" },
    { re: /\bcopper\b[\s\S]{0,30}?(surge|soar|jump|rally|spike)/i, zh: "铜价大涨" },
    { re: /\bcopper\b[\s\S]{0,30}?(slump|fall|slide|drop|tumble|sink|plunge)/i, zh: "铜价下跌" },
    // —— 地缘 / 其它 ——
    { re: /\bwar\b|strike|military action|missile|invasion|airstrike/i, zh: "地缘冲突升级" },
    { re: /sanction/i, zh: "制裁措施出台" },
    { re: /oil prices?|crude[\s\S]{0,20}?(surge|soar|jump|plunge|surge|slump)/i, zh: "油价出现大幅波动", gen: true },
    { re: /stock[\s\S]{0,20}?(selloff|rout|plunge|crash|sell-off)/i, zh: "股市遭遇抛售" },
    { re: /stocks?[\s\S]{0,20}?(rally|surge|record high|jump)/i, zh: "股市大幅上涨" },
  ];

  /**
   * 英文标题 → 具体中文事实句；未命中返回 ""（由调用方回落到词典翻译/通用模板）
   */
  function zhFactDetail(raw) {
    var t = String(raw || "");
    if (!t) return { text: "", generic: false };
    // 已经是中文标题 → 不走事实抽取（中文源直接用原文）
    if (/[\u4e00-\u9fa5]/.test(t)) return { text: "", generic: false };
    for (var i = 0; i < RULES.length; i++) {
      var m = t.match(RULES[i].re);
      if (m) {
        var v = typeof RULES[i].zh === "function" ? RULES[i].zh(m) : RULES[i].zh;
        if (v && /[\u4e00-\u9fa5]/.test(v)) return { text: v, generic: !!RULES[i].gen };
      }
    }
    return { text: "", generic: false };
  }
  function zhFact(raw) { return zhFactDetail(raw).text; }

  /**
   * 词典译文的「可读性」门禁：有些标题词典能译出中文，但译得是碎片（"特朗普美国关税，因、表示需求纪录"），
   * 用户看了也不知道发生了什么 → 这类译文要弃用，改用规则化事实抽取。
   * 可读判定：① 无残留英文单词；② 以「，、；」切分后每段中文不少于 2 字（避免"因、"这种 1 字碎片）。
   */
  function zhGistReadable(t) {
    var s = String(t || "");
    if (!/[\u4e00-\u9fa5]/.test(s)) return false;
    if (/[a-zA-Z]{3,}/.test(s)) return false;                 // 残留英文单词 → 译砸了
    var frags = s.split(/[，、；]/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (!frags.length) return false;
    for (var i = 0; i < frags.length; i++) {
      var cn = (frags[i].match(/[\u4e00-\u9fa5]/g) || []).length;
      if (cn < 2) return false;                              // 出现 1 字碎片 → 译砸了
    }
    return true;
  }

  /* ================= B. 已知事实 → 更具体的影响结论 ================= */

  // 事实 → 对贵金属影响（比通用的「影响偏中性，方向待确认」更具体）
  var IMPACT_RULES = [
    { re: /维持.{0,10}利率|利率.{0,6}不变|不加息|按兵不动|维持利率/, zh: "美联储按兵不动，金价缺少明确方向指引" },
    { re: /^美联储加息|央行加息/, zh: "美联储转鹰，实际利率上行压制金价" },
    { re: /美联储降息|央行降息/, zh: "美联储转鸽，实际利率下行支撑金价" },
    { re: /议息|利率决议|利率决定/, zh: "美联储议息结果落地，市场重新定价利率路径" },
    { re: /通胀|CPI|PPI/, zh: "通胀是金价定价的核心变量，实际利率随之变化" },
    { re: /非农|失业率|就业/, zh: "就业数据决定降息预期，进而影响金价" },
    { re: /美债收益率上行/, zh: "美债收益率上行抬高持有黄金的机会成本，金价承压" },
    { re: /美债收益率下行/, zh: "美债收益率下行降低持金机会成本，金价偏强" },
    { re: /美元走强/, zh: "美元走强压制以美元计价的金价" },
    { re: /美元走弱/, zh: "美元走弱对金价构成支撑" },
    { re: /地缘冲突升级/, zh: "地缘风险推升避险买盘，金价偏强" },
    { re: /金价大涨|金价下跌|银价|铜价/, zh: "贵金属自身价格波动，注意与基本面脱节的风险" },
  ];

  /**
   * 影响结论：优先用事实推出的具体结论，否则用原有多空判定
   * @param {String} fact  zhFact() 的结果（可为空）
   * @param {String} dir   impactOf() 的 up/down/mixed
   */
  function zhImpact(fact, dir) {
    var f = String(fact || "");
    if (f) {
      for (var i = 0; i < IMPACT_RULES.length; i++) {
        if (IMPACT_RULES[i].re.test(f)) return IMPACT_RULES[i].zh;
      }
    }
    return dir === "up" ? "利多，价格有望获得支撑"
      : dir === "down" ? "利空，价格面临压力"
      : "影响偏中性，方向待确认";
  }

  /* ================= C. 国内源解析 + 噪声门禁 ================= */

  // 国内快讯：贵金属 / 顶层宏观关键词（比境外源的关键词更严，避免噪声淹没）
  var CN_HIT = /黄金|金价|白银|银价|铜价|贵金属|稀土|美联储|议息|不加息|加息|降息|利率决定|利率决议|通胀|CPI|PPI|非农|失业率|关税|贸易战|货币政策|美联储主席|经济数据|GDP|衰退|避险|量化宽松|缩表|央行降息|央行加息/;
  // 国内快讯噪声：日常操作/个股公告类，与贵金属定价无直接关系
  // 注意：词要「精确」——CN_HIT 已经挡掉绝大多数噪声，这里只补「含宏观关键词但实为噪声」的条目。
  // 反例：/基金/ 会误杀「联邦基金利率」（美联储议息类必被误杀），故改为基金产品专用词。
  var CN_NOISE = /地方债|专项债|逆回购|同业存单|中期借贷便利|\bMLF\b|\bSLF\b|中标|缴款|招标|买断式回购|票据发行|净值|份额|申购|赎回|私募|公募|\bETF\b|涨停|跌停|龙虎榜|个股|股东户数|减持|增持|股东大会|回购股份|新股|\bIPO\b|配股|分红|专利|诉讼|直播|带货|销量|门店|加盟/;

  /** 中文标题清洗：把【标题】改成「标题：」，去掉零散空白 */
  function cleanCnHeadline(s) {
    var t = String(s || "").replace(/<!\[CDATA\[|\]\]>/g, "");
    t = t.replace(/【([^】]{1,40})】/g, "$1：");
    t = t.replace(/\[([^\]]{1,40})\]/g, "$1：");
    t = t.replace(/\s+/g, " ").trim();
    return t;
  }

  /** 中文快讯：是否属于「值得入库」的贵金属/顶层宏观事件 */
  function cnRelevant(title, desc) {
    var s = String(title || "") + " " + String(desc || "");
    if (CN_NOISE.test(s)) return false;
    return CN_HIT.test(s);
  }

  function isoUtc(ms) {
    var d = new Date(ms);
    if (isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  }

  /** 东方财富快讯（JSONP：var ajaxResult={...}）→ 标准条目 */
  function parseEastmoney(body) {
    var out = [];
    var m = String(body || "").match(/\{[\s\S]*\}/);
    if (!m) return out;
    var j;
    try { j = JSON.parse(m[0]); } catch (e) { return out; }
    var list = j.LivesList || (j.data && j.data.list) || [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i] || {};
      var title = cleanCnHeadline(it.title || "");
      var digest = cleanCnHeadline(it.digest || "");
      if (!title) continue;
      var ms = Number(it.sort || 0) / 1000;          // sort = 微秒时间戳
      var date = ms ? isoUtc(ms) : "";
      out.push({ title: title, desc: digest, link: it.url_w || it.url_unique || "", date: date, pub: date, kind: "cn" });
    }
    return out;
  }

  /** 华尔街见闻 快讯（JSON：data.items[]）→ 标准条目 */
  function parseWallstreetcn(body) {
    var out = [];
    var j;
    try { j = JSON.parse(String(body || "")); } catch (e) { return out; }
    var items = (j.data && j.data.items) || [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var text = cleanCnHeadline(it.content_text || it.content || "");
      if (!text) continue;
      var sec = Number(it.display_time || 0);        // display_time = 秒级时间戳
      var date = sec ? isoUtc(sec * 1000) : "";
      out.push({
        title: text.slice(0, 40),
        desc: text,
        link: (it.uri || it.url || (it.article && it.article.uri)) || "",
        date: date, pub: date, kind: "cn",
      });
    }
    return out;
  }

  /** 快讯类国内源：只保留最近 windowHours 小时内的条目（避免老条目长期占位） */
  function withinHours(dateStr, windowHours) {
    if (!dateStr) return false;
    var t = Date.parse(dateStr + "T00:00:00Z");
    if (isNaN(t)) return false;
    var now = Date.now();
    var ageH = (now - t) / 3600000;
    return ageH >= -1 && ageH <= (windowHours || 36);
  }

  return {
    zhFact: zhFact,
    zhFactDetail: zhFactDetail,
    zhGistReadable: zhGistReadable,
    zhImpact: zhImpact,
    cleanCnHeadline: cleanCnHeadline,
    cnRelevant: cnRelevant,
    parseEastmoney: parseEastmoney,
    parseWallstreetcn: parseWallstreetcn,
    withinHours: withinHours,
    CN_HIT: CN_HIT,
    CN_NOISE: CN_NOISE,
    RULES: RULES,
  };
});
