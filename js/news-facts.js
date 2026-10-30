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
    // —— C22 补·末路兜底补漏（这三条曾落到「XX相关动向公布」的含糊标题）——
    { re: /five key takeaways[\s\S]{0,80}(fed|rate decision)[\s\S]{0,60}(news conference|press conference)/i,
      zh: "美联储议息结果与沃什记者会要点解读" },
    { re: /where to put your money/i, zh: "美联储利率走向下的资产配置讨论" },
    { re: /tokyo cpi[\s\S]{0,60}boj|boj decision[\s\S]{0,80}(yen|central bank week)/i,
      zh: "东京CPI与日本央行议息落定" },
    { re: /fed meeting keeps? dollar steady|dollar[\s\S]{0,40}fed meeting[\s\S]{0,30}steady/i,
      zh: "美联储议息会议后美元维持平稳" },
    { re: /gundlach[\s\S]{0,60}(rate pause|fed)/i,
      zh: "债券投资人古德勒奇质疑美联储按兵不动" },
    // —— C22 补·权威官方源标题具体化（官方源标题极简，不具体化就是「一句废话」）——
    // 美联储官方 RSS：FOMC 声明 / 会议纪要 / 经济预测（SEP）—— 金银定价最权威的一手来源
    { re: /federal reserve issues fomc statement/i, zh: "美联储发布FOMC利率决议声明" },
    { re: /minutes of the federal open market committee/i, zh: "美联储公布FOMC会议纪要" },
    { re: /minutes of the board'?s discount rate meetings/i, zh: "美联储公布贴现率会议纪要" },
    { re: /federal open market committee release economic projections/i, zh: "美联储发布经济预测摘要与点阵图" },
    { re: /federal reserve issues .*statement/i, zh: "美联储发布政策声明" },
    // 欧洲央行官方 RSS：货币政策决议 / 调查数据
    { re: /monetary policy decisions/i, zh: "欧洲央行公布货币政策决议" },
    { re: /euro area bank lending survey/i, zh: "欧洲央行发布欧元区银行信贷调查" },
    { re: /access to finance of enterprises/i, zh: "欧洲央行发布企业融资条件调查" },
    { re: /consumer expectations survey/i, zh: "欧洲央行发布消费者预期调查" },
    // —— C22 补·铜一手行情（SMM/交易所口径）——
    { re: /矿端[^，。]{0,12}沪铜|沪铜[^，。]{0,10}(偏强|偏弱|震荡|上涨|下跌|涨|跌)|伦铜[^，。]{0,10}(涨|跌|收涨|收跌)/, zh: "铜价行情：矿端与现货博弈" },
    { re: /沪铜|伦铜|LME铜/,
      zh: function (m) { return "铜价与库存动态更新"; } },
    // —— C22 补·高优先（必须排在通用规则之前，否则会被下方泛化规则抢走）——
    // RBA（澳洲联储）专属：澳洲 CPI / 加息预期 ≠ 美国通胀，必须先于「hot CPI → 美国CPI」判定
    { re: /\bRBA\b|reserve bank of australia|澳洲联储|澳大利亚央行/i, zh: "澳洲央行加息预期升温" },
    // IMF 警告：全球流动性风险（比下方泛化的「美债收益率飙升」更准确）
    { re: /\bIMF\b[\s\S]{0,90}(bond yields?|disorderly|spike|surge|warn)/i, zh: "IMF警告债券收益率可能无序飙升" },
    // FOMC 议息会议频次调整（Fed meeting recap / fewer rate-setting meetings）
    { re: /fewer rate-setting meetings|host fewer/i, zh: "美联储拟减少议息会议次数" },
    // 财长贝森特定调（条件句，不能直接说成「美联储将加息」）
    { re: /\bbessent\b[\s\S]{0,90}hike/i, zh: "财长贝森特谈美联储再加息风险" },
    // 特朗普谈关税用途（政治评论，具体化才不至于沦为「关税政策变化」）
    { re: /trump[\s\S]{0,110}tariffs?[\s\S]{0,70}(grift|tool)/i, zh: "特朗普称关税被用作牟利工具" },
    // 通胀担忧 + 关税退税调整
    { re: /four reasons[\s\S]{0,140}inflation|tariff refunds?/i, zh: "通胀担忧升温，关税退税政策面临调整" },
    // PPI 偏热：比「美国PPI升温」多一层「抗通胀尚未结束」的判断
    { re: /\bhot\s*PPI\b|\bPPI\b[\s\S]{0,40}hot/i, zh: "美国PPI超预期，美联储抗通胀尚未结束" },
    // COMEX 金银同时收涨 / 收跌（必须排在下方单金属 settle 规则之前）
    { re: /comex[\s\S]{0,30}(gold|黄金)[\s\S]{0,30}silver[\s\S]{0,45}settle[sd]?\s+higher/i, zh: "COMEX黄金、白银集体收涨" },
    { re: /comex[\s\S]{0,30}(gold|黄金)[\s\S]{0,30}silver[\s\S]{0,45}settle[sd]?\s+lower/i, zh: "COMEX黄金、白银集体收跌" },
    // 现货银价关键位（XAG/USD）
    { re: /XAG\/USD[\s\S]{0,40}(slips|falls|drops|below|above)/i, zh: "现货银价跌破关键位" },
    { re: /\bsilver\b[\s\S]{0,25}\$([\d,]+(?:\.\d+)?)/i, zh: function (m) { return "银价报 " + m[1] + " 美元/盎司"; } },
    // 加息在即但本周不动（CNBC 调查类）
    { re: /rate hikes? are coming, but not this week/i, zh: "美联储加息在即但本周不会加息" },
    // —— C22 补：英文标题「具体事实」抽取（覆盖此前只能拼标签的硬骨头，消除「通胀·加息：利多驱动」类不知所云标题）——
    { re: /\bgold\b[\s\S]{0,25}?(settles?|settled|closes?)\s+(lower|down|under)/i, zh: "金价下跌" },
    { re: /\bgold\b[\s\S]{0,25}?(settles?|settled|closes?)\s+(higher|up|above)/i, zh: "金价上涨" },
    { re: /\bsilver\b[\s\S]{0,25}?(settles?|settled|closes?)\s+(lower|down|under)/i, zh: "银价下跌" },
    { re: /\bsilver\b[\s\S]{0,25}?(settles?|settled|closes?)\s+(higher|up|above)/i, zh: "银价上涨" },
    { re: /\bhot\b[\s\S]{0,12}(cpi|ppi)\b/i, zh: function (m) { return "美国" + (/cpi/i.test(m[1]) ? "CPI" : "PPI") + "升温"; } },
    { re: /(cpi|ppi)\b[\s\S]{0,30}(hot|heats?|(?:re)?accelerates?|surge|jumps?|rises?)/i, zh: function (m) { return "美国" + (/cpi/i.test(m[1]) ? "CPI" : "PPI") + "升温"; } },
    { re: /rate hikes? are coming/i, zh: "美联储加息在即" },
    // 【C22 修复方向反转】原规则 /\bfed\b[\s\S]{0,45}(hikes?|will hike|to hike)/i 会把
    //   「Fed meeting live updates: No hike expected」（市场预计**不**加息）误判成「美联储将加息」，
    //   方向完全说反。改为排除否定语境：no hike / not hike / hike is not / without a hike / hike odds。
    { re: /\bfed\b[\s\S]{0,45}(hikes?|will hike|to hike)/i, zh: "美联储将加息",
      not: /\bno\s+(rate\s+)?hike|\bnot\s+(a\s+)?hike|hike\s+is\s+not|hikes?\s+is\s+not|without\s+a\s+hike|hike\s+odds|\bno\s+hikes\b|不加息|没有加息/i },
    { re: /fed'?s (work|job) is not done/i, zh: "美联储抗通胀任务未竟" },
    { re: /bond yields?\b[\s\S]{0,30}(spike|surge|jump|rise|climb|soar)/i, zh: "美债收益率飙升" },
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
        // 【C22】否定语境护栏：规则可带 not 正则，命中否定表述时本规则跳过（继续往下找更准确的规则）。
        //   例：「Fed ... No hike expected」不应被「美联储将加息」规则抢走。
        if (RULES[i].not && RULES[i].not.test(t)) continue;
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

  /* ================= D. 金属差异化相关性（铜 vs 金银） ================= */

  /**
   * 【C22 用户要求】金银铜属性不同、使用场景不同，抓取与相关性计算必须有差异。
   *   · 金银 = 货币属性：避险 / 实际利率 / 美元 / 央行 / 通胀 → 宏观事件归金银
   *   · 铜   = 工业金属：中国基建 / 制造业 / 供需 / 矿端供应 → 宏观事件不归铜
   * 铜专属关键词命中铜自身行情时，铜才独立成条；否则铜只收「明确提到铜」的条目。
   */
  var COPPER_CORE = /铜价|沪铜|伦铜|LME铜|LME 铜|COMEX铜|COMEX 铜|铜主力|铜期货|精铜|阴极铜|电解铜|废铜|铜精矿|铜矿|铜冶炼|铜加工|铜杆|铜管|铜箔|铜棒|铜库存|铜需求|铜消费|铜供应|铜产能|铜产量|铜加工费|铜期权|\bcopper\b|\blme copper\b|comex copper/;
  // 铜的「工业属性」信号（用于给铜条目的影响结论与相关性加权，不用于把宏观事件拉进铜）
  var COPPER_INDUSTRY = /电网|电缆|基建|制造业|工业需求|新能源车|光伏|风电|数据中心|房地产|建筑|汽车产量|冶炼|精矿|加工费|TC\/RC|库存|矿端|减产|罢工|产能|开工率|出口|进口|中国|宏观|刺激/;

  /**
   * 该文本是否明确在讲铜（铜自身行情 / 铜产业）
   * 【C22 强化】铜的「一手行情语言」必须能识别，否则铜列表只能靠宏观凑数：
   *   沪铜/伦铜/LME铜/COMEX铜/铜价/A股沪铜主力/铜主力合约 —— 这些是铜行情的固定表述。
   */
  function copperRelevant(t) {
    var s = String(t || "");
    if (COPPER_CORE.test(s)) return true;
    // 铜行情固定表述（沪铜主力 / 伦铜 / LME 铜 / COMEX 铜 / 铜价）
    // 【C22】不收录裸「铜」单字 —— 「宝祺铜业」「铜缆」「铜棒」这类企业名/品类名
    //   会把无关条目（展会邀约、个股预中标、报价流水）误判成铜事件。
    //   只有「铜 + 供需/行情语义」组合才算真正在讲铜。
    if (/沪铜|伦铜|LME铜|LME 铜|COMEX铜|COMEX 铜|铜价|铜主力|铜期货/.test(s)) return true;
    if (/铜/.test(s) && /矿|冶炼|精矿|库存|加工费|产能|产量|供应|需求|消费|减产|罢工|价格|涨|跌|升|降|供需|开工|吨|指引|财报|季报|半年报/.test(s)) return true;
    return false;
  }

  /**
   * 铜的事件相关性评分：铜自身行情 / 铜产业供需为强信号；
   * 纯宏观（美联储 / 美元 / 通胀）不计入 —— 这正是「铜的信息展示到金里」的判定依据。
   * 【C22 强化】新增「铜一手行情」识别：沪铜/伦铜/LME铜/铜价 → 强信号，
   *   否则像「矿端干扰较多 沪铜偏强运行」这种铜的核心行情评论会被漏判。
   * @returns {number} 0 = 与铜无关
   */
  function copperRelevance(t) {
    var s = String(t || "");
    if (!copperRelevant(s)) return 0;
    var score = 2;
    if (/铜价|沪铜|伦铜|LME铜|LME 铜|COMEX铜|COMEX 铜|\bcopper\b|comex copper|精铜|阴极铜|电解铜|铜主力/i.test(s)) score += 2;   // 铜价行情
    if (COPPER_INDUSTRY.test(s)) score += 1;                                    // 铜产业/供需
    if (/产量|库存|加工费|开工率|减产|罢工|供应|需求|产能|矿端|冶炼|精矿/i.test(s)) score += 1; // 供需变量
    return score;
  }

  /**
   * 金银的货币属性相关性评分：宏观（央行/利率/美元/通胀/避险/地缘）+ 贵金属自身。
   * @returns {number} 0 = 与金银无关
   */
  function preciousRelevance(t) {
    var s = String(t || "");
    var score = 0;
    if (/美联储|联储|议息|利率决议|利率决定|加息|降息|不加息|按兵不动|央行|货币政策|\bfed\b|fomc|central bank|rate hike|rate cut/i.test(s)) score += 2;
    if (/通胀|inflation|\bcpi\b|\bppi\b|\bpce\b|非农|失业率|就业|\bgdp\b|pmi/i.test(s)) score += 2;
    if (/美元|\bdollar\b|美债|收益率|实际利率|treasury|yield/i.test(s)) score += 1;
    if (/避险|地缘|冲突|战争|制裁|避险需求|safe haven|geopolit/i.test(s)) score += 1;
    if (/黄金|金价|白银|银价|贵金属|\bgold\b|\bsilver\b|comex|bullion|precious metal/i.test(s)) score += 2;
    if (/关税|tariff|贸易战|trade war/i.test(s)) score += 1;
    return score;
  }

  /**
   * 【C22 用户要求】市井信息一律不要：只要「不产生金银铜定价变化」就属噪音。
   * 命中即视为市井 → 不入库（含资讯体裁噪音：会议/展会/人物轶事/生活消费/无关行业行情）。
   */
  var MUNDANE = /大会|论坛|峰会|研讨会|博览会|晨会|策略会|发布会|发布会|年会|沙龙|路演|招商|签约|揭牌|剪彩|开业|奠基|落成|投产仪式|表彰|颁奖|履新|出任|任职|离任|人事变动|女子|男子|小伙|大爷|大妈|情侣|婚礼|结婚|离婚|手镯|金店|金饰|项链|珠宝|钻戒|黄金饰品|首饰|买金|打金|金价下跌.*买|银饰|典当|回收|直播|带货|销量|门店|加盟|优惠券|促销|旅游|景区|票价|电影|票房|球队|球员|比赛|夺冠|综艺|明星|演唱会|生肖|彩票|星座|养生|减肥|美食|菜谱|天气|气温|降雨|台风|地震|车祸|坠机|爆炸事故|火灾|讣告|遇难|车祸|彩票|展会邀约|邀您共聚|诚邀|参展|预中标|中标公告|招聘|专利|论文|课程|讲座|直播预告|【SMM价格】|价格快讯|每日报价|归母净利润|扣非净利润|每股收益|营业收入|业绩快报|业绩预告|forex today|here is what you need to know|what you need to know|daily recap|市场综述|今日综述|每日综述/;
  // 与金属定价完全无关的行情题材（个股/其它大宗/加密货币/汇率中间价/股市播报）
  // 【C22 补】SMM 等有色资讯站会发「XX企业Q3净利大增」「XX资源产量增X%」这类**其它有色品种**的业绩/产量快讯，
  //   与铜定价无关（钼/钴/锌/镍/铝）→ 一律剔除，否则铜列表会被非铜有色信息占满。
  var OFF_TOPIC = /个股|股票|股价|涨停|跌停|龙虎榜|大宗商品期货|主力合约|沪锡|沪镍|沪铅|碳酸锂|热轧卷|螺纹钢|铁矿石期货|棕榈油|豆粕|白糖期货|生猪期货|尿素|红枣|鸡蛋|苹果期货|原油期货|布伦特|WTI|布油|咖啡|可可|白糖|棉花|人民币中间价|在岸人民币|离岸人民币|数字人民币|比特币|以太坊|区块链|加密货币|稳定币|元宇宙|AI股|科技股|芯片股|光模块|机器人概念|钼价|钼矿|钼产量|钴价|钴矿|钴产量|镍价|镍矿|锌价|锌矿|锌产量|锡价|锡矿|伦铅|伦锌|伦镍|伦锡|伦铝|铝价|铝锭|电解铝|铝合金|铅价|铅矿|稀土|锂矿|碳酸锂价|硅料|多晶硅|钨价|钨矿|dividend|\bearnings\b|analyst|price target|buyback|shareholder|\bacquisition\b|\bmerger\b|\bstocks?\b|\bIPO\b/;

  /**
   * 是否为「市井 / 与金属定价无关」的条目（用户要求：只展示权威正式事件）。
   * @returns {boolean} true = 市井或无关，应丢弃
   */
  // 【C22】英文每日综述栏目（大小写不敏感）：FXStreet「Forex Today: …」、
  //   「Here is what you need to know…」这类是每日综述/预告，不是事件 → 剔除。
  var MUNDANE_EN = /forex today|here is what you need to know|what you need to know|daily recap|market wrap|economic calendar|what to watch/i;
  // 【C22】无信息量标题（兜底拼装）：「黄金相关动向公布」等于没说 → 不入库
  var VAGUE_TITLE = /相关动向公布|相关动向|情况公布|消息公布/;
  function isMundane(t) {
    var s = String(t || "");
    if (MUNDANE.test(s)) return true;
    if (MUNDANE_EN.test(s)) return true;
    if (OFF_TOPIC.test(s)) return true;
    if (VAGUE_TITLE.test(s)) return true;
    // 【C22】标题党：一句里两个以上感叹号（「沃什最新表态！美联储，重大变革！美元指数，瞬间跳水！」）
    //   —— 这类是资讯站引流标题，不是权威正式事件 → 不入库。
    if ((s.match(/！/g) || []).length >= 2) return true;
    return false;
  }

  /* ================= E. 行情快照 vs 事件（用户要「事件」，不要「今天多少钱」） ================= */

  /**
   * 【C22】纯行情快照门禁：只播报「现在多少钱/涨跌多少」，没有「发生了什么」，
   *   不是用户要的「权威事件」。典型：
   *   「今日黄金：跌至4030美元附近」「快讯：现货黄金跌超1%，现报4025.15美元/盎司」
   *   「金价下跌」「现货黄金下跌1% 现货白银跌超2%」「India Gold price today: Gold falls」
   *   → 这些条目既拉低信息密度，也会把当天列表灌满、挤掉真正的事件。
   *   判定口径：标题主体是「今日/快讯/盘中/收评 + 价格」，且**不含任何事件性要素**
   *   （决策/决议/政策/产量/罢工/数据公布/机构表态/关税/冲突…）。
   */
  var QUOTE_ONLY = /^(今日|快讯|现货|盘中|早盘|午盘|尾盘|收评|日评|盘面|行情|价格|报价|期金|期银|沪金|沪银|沪铜|伦铜|金价|银价|铜价|黄金|白银|铜)/;
  // 【C22 英文源】英文标题的「纯报价页」前缀：Gold/Silver/Copper price today、price update 等
  var QUOTE_ONLY_EN = /^(gold|silver|copper|spot gold|spot silver|gold price|silver price|copper price|india gold price|price update|price forecast)/i;
  var EVENT_SIGNAL = /决议|决定|宣布|发布|通过|否决|上调|下调|加息|降息|不加息|按兵不动|议息|政策|制裁|关税|协议|签署|产量|减产|罢工|停产|复产|库存|数据|公布|同比|环比|增长|下降|上升|回落|走高|走低|跌破|突破|触及|创.*新高|创.*新低|财报|业绩|指引|预测|预计|预期|讲话|表态|回应|声明|记者会|听证|会议|访华|访美|冲突|战争|袭击|制裁|疫情|选举|投票|辞职|任命|调查|起诉|罚款|收购|并购|IPO|财报季|开局|收官|收盘|开盘|刷新|创纪录|领涨|领跌|跳水|暴涨|暴跌|飙升|重挫|反弹|回升|承压|支撑|压力|新高|新低/;
  function isQuoteOnly(t) {
    var s = String(t || "").replace(/^[\s【\[（(]+/, "");
    if (QUOTE_ONLY_EN.test(s)) {
      // 英文「纯报价页」：Gold price today / Silver price update …
      //   含观点/预测的（forecast / outlook / analysts / expect）→ 是分析事件，保留
      if (/\b(forecast|outlook|analysts?|expect|predict|target|why|what|how|view|views|opinion|analysis|guide|strategy)\b/i.test(s)) {
        return false;
      }
      // 否则若同时出现事件性要素（联储决议/通胀/关税/产量…）→ 保留
      if (!/\b(fed|fomc|rate|decision|policy|tariff|inflation|cpi|ppi|war|conflict|sanction|central bank|production|output|strike|announce|report|data release|hike|cut)\b/i.test(s)) {
        return true;
      }
      return false;
    }
    if (!QUOTE_ONLY.test(s)) return false;
    // 【C22 英文原文】英文源的「今日金价」类报价页也要判：
    //   "India Gold price today: Gold falls, according to FXStreet data" → 纯报价，不是事件。
    //   判据：含 price today / price today / according to <source> data，且无事件性动词。
    if (/\b(price|prices)\s+today\b|\btoday'?s\s+(gold|silver|copper)\s+price\b|according to .* data\b/i.test(s)) {
      if (!/\b(fed|fomc|rate|decision|policy|tariff|inflation|cpi|ppi|war|conflict|sanction|central bank|production|output|strike|sanction|announce|report|data release)\b/i.test(s)) {
        return true;
      }
    }
    // 【C22】只看**首段**（冒号前）是否纯报价：
    //   「今日黄金：跌至4030美元附近，市场等待美国通胀数据」首段是纯报价（后续的「通胀数据」
    //   是背景，不是这件事本身）→ 判为快照。
    //   「金价突破4000美元后高位震荡」无冒号 → 整段看，有「突破/震荡」等事件性词 → 保留。
    var head = s.split(/[：:，,]/)[0];
    if (EVENT_SIGNAL.test(head)) return false;
    // 无冒号时，整段都要有事件性词才保留
    if (head === s && EVENT_SIGNAL.test(s)) return false;
    return true;
  }

  /**
   * 【C22】英文标题的「主体」是否丢失：原文说的是金/银/铜价，
   *   但规则化抽取只给出了「美联储将加息」这类**驱动因素**、丢了价格主体 →
   *   用户看到「美联储将加息」不知道说的是金还是银。修复方式：给这类抽取加主语。
   *   返回应补的主语（"" = 无需补）。
   */
  function priceSubjectHint(raw) {
    var s = String(raw || "");
    if (/\bgold\b|gold price|gold prices|bullion|金价|黄金/i.test(s)) return "金价";
    if (/\bsilver\b|silver price|银价|白银/i.test(s)) return "银价";
    if (/\bcopper\b|copper price|铜价|沪铜|伦铜/i.test(s)) return "铜价";
    return "";
  }

  /* ================= F. 纯外汇 / 碎片译文 门禁 ================= */

  /**
   * 【C22】纯外汇事件门禁：「印尼盾连跌六日后迎来反弹」「纽元跌至…」
   *   这类是交叉盘行情，与金银铜定价没有直接关系 → 不入库。
   *   但若同时提到黄金/白银/铜/美元/美联储，则仍与贵金属定价相关 → 保留。
   */
  var FX_ONLY = /印尼盾|里拉|比索|卢比|卢布|兹罗提|福林|克朗|瑞郎|法郎|林吉特|盾|拉美货币|泰铢|新元|澳元|纽元|加元|日元|欧元|英镑|韩元|美元指数|交叉盘/;
  var FX_KEEP = /黄金|金价|白银|银价|铜价|沪铜|伦铜|贵金属|美联储|联储|议息|加息|降息|通胀|CPI|PPI|美元|收益率|避险|地缘|关税|\bgold\b|\bsilver\b|\bcopper\b|fed\b|fomc|inflation|dollar|yield/i;
  function isForexOnly(t) {
    var s = String(t || "");
    // 【C22 关键】先剥掉**我们自己追加的结论后缀**（「。对贵金属影响：…」「。对铜价影响：…」）：
    //   这个后缀每条都有，若参与判定会让 FX_KEEP 里的「贵金属」永远命中 → 外汇条目永远放行。
    s = s.replace(/。对(贵金属|铜价)影响：[\s\S]*$/, "");
    // 【C22】英文原文也要判：门禁在入库前跑，此时标题可能是英文
    //   （例："Swiss Franc remains calm as US Dollar steadies on Fed outlook uncertainty"）。
    if (/swiss franc|new zealand dollar|australian dollar|canadian dollar|euro zone|sterling|yen\b|won\b|rupee|rand\b|real\b|peso|rupiah|baht/i.test(s)) {
      // 标题主体就是该货币 → 纯外汇事件 → 剔除。
      // 注意：「US Dollar」「Fed」多只是背景（如 "Swiss Franc remains calm as US Dollar steadies on Fed outlook"），
      //   主体是瑞郎 → 剔除；背景提及不作为「仍相关」的证据。
      // 但**货币区的通胀/利率数据本身是有意义的宏观事件**（如 "Euro zone inflation cools to 2.1%"）
      //   —— 主体是 euro 但说的是通胀 → 不按纯外汇剔。
      var headEn = (s.split(/[\s,:;—–-]+/).slice(0, 2).join(" ") || "");
      var isFxSubject = /swiss|new zealand|australian|canadian|euro|sterling|yen|won|rupee|rand|real|peso|rupiah|baht/i.test(headEn);
      // 【C22】「货币区的宏观数据」是有意义的（欧元区通胀 → 影响美元/贵金属），
      //   但「该货币区央行的利率决议」对金银铜影响有限（如 BOJ 议息）→ 仍按纯外汇剔。
      //   例外：**加息/降息预期**是全球实际利率的定价因子，对贵金属有直接含义 → 保留。
      var isForeignCentralBank = /\b(boj|ecb|rba|boe|bnp|snb)\b|bank of japan|european central bank/i.test(s);
      var isRateExpectation = /\b(hike|rate hike|cut|rate cut|hike odds|rate path|monetary policy)\b/i.test(s);
      var isMacroData = (/\b(inflation|cpi|ppi|output|gdp|pmi|unemployment)\b/i.test(s) && !isForeignCentralBank)
        || isRateExpectation;
      if (isFxSubject && !isMacroData && !/gold|silver|copper|bullion|precious/i.test(headEn)) return true;
    }
    if (!FX_ONLY.test(s)) return false;
    // 【C22】中文侧同样按「主体」判定：
    //   「印尼盾连跌六日后迎来反弹」摘要里提到「美联储主席沃什讲话偏鸽派」→ FX_KEEP 命中「美联储」，
    //   但这条的主体是印尼盾、美联储只是背景 → 仍应剔除。
    //   做法：若标题**首句**（到第一个句读为止）的主体就是那个外汇货币 → 剔除。
    var headCn = (s.split(/[。！？；\n]/)[0] || "").trim();
    var fxSubjectCn = /印尼盾|里拉|比索|卢比|卢布|兹罗提|福林|克朗|瑞郎|法郎|林吉特|泰铢|新元|澳元|纽元|加元|日元|欧元|英镑|韩元|交叉盘/.test(headCn);
    if (fxSubjectCn) return true;
    if (FX_KEEP.test(s)) return false;   // 提到贵金属/美联储/美元 → 仍相关
    return true;
  }

  /**
   * 【C22】碎片译文门禁：词典译出的中文若以「仍然」「同时」「此外」「因」等连接词开头，
   *   或首段只有 1-2 个中文字，说明译文是从句子中间截出来的碎片，
   *   例如「仍然，因美元企稳美联储前景」→ 用户看不懂 → 不可入库。
   */
  function isFragmentZh(t) {
    var s = String(t || "");
    if (!/[\u4e00-\u9fa5]/.test(s)) return false;
    var frags = s.split(/[，,、；;：:]/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (!frags.length) return false;
    // 【C22】首段过短（≤3 字）判碎片 —— 但「金价：美联储将加息」这类「主语：结论」是合法结构，
    //   首段是价格主语（金价/银价/铜价/黄金/白银/铜）→ 不算碎片。
    var SHORT_SUBJ = /^(金价|银价|铜价|黄金|白银|铜|金|银|美联储|联储|央行|美元|欧央行|关税|地缘|避险)$/;
    if (frags[0].length <= 3 && !SHORT_SUBJ.test(frags[0])) return true;
    // 以连接词开头 → 片段（连接词开头说明译文从句子中间截出来的）
    if (/^(仍然|依然|同时|此外|另外|而且|但是|不过|然而|因此|所以|由于|因为|因|则|就|将|已|据|至|在|与|和|及|对|从|把|被|让|使|为|以|于|其|该|此|这|那|它|他|她|他们|它们)/.test(frags[0])) return true;
    // 存在 1 字碎片段
    for (var i = 0; i < frags.length; i++) {
      var cn = (frags[i].match(/[\u4e00-\u9fa5]/g) || []).length;
      if (cn <= 1) return true;
    }
    return false;
  }

  /**
   * 【C22】低质译文门禁：中文里残留**整句英文**，说明翻译失败/拼接错乱。
   *   典型：FXStreet「Forex Today: Major pairs fail to break out after Fed...」
   *         → 中文标题「今日，主要突破后美联储，欧洲央行、关键数据」
   *         → 摘要后面还挂着 "Here is what you need to know on Thursday, October 29:"。
   *   这类条目看不懂、还占位 → 不入库。
   *   判定：文本里含中文，且存在 ≥6 个连续英文词（英文源原文不算，只有译错才命中）。
   */
  var EN_CLAUSE = /[A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z0-9][A-Za-z0-9'’\-:,\.]*){5,}/;
  function isJunk(t) {
    var s = String(t || "");
    if (!/[\u4e00-\u9fa5]/.test(s)) return false;  // 纯英文（原文）不算低质
    return EN_CLAUSE.test(s);
  }

  /**
   * 权威性分级：官方机构 > 通讯社/一线财经 > 门户聚合。
   * 用于展示时标注来源层级，也是「只要权威信息」的落地依据。
   * @returns {string} "official" | "wire" | "portal" | "unknown"
   */
  function authorityTier(src) {
    var s = String(src || "");
    if (/美联储官方|federal reserve|欧洲央行|\becb\b|国家统计局|人民银行|中国央行|海关总署|工信部|发改委|统计局|官方|公告/i.test(s)) return "official";
    if (/路透|Reuters|彭博|Bloomberg|华尔街日报|WSJ|金融时报|FT|新华|人民|央视|美联储|Fed\b/i.test(s)) return "wire";
    if (/CNBC|华尔街见闻|财联社|金十|第一财经|新浪财经|东方财富|证券时报|中国证券报|经济观察报|MarketWatch|SeekingAlpha|FXStreet|21世纪/i.test(s)) return "portal";
    return "unknown";
  }

  /* ================= B. 已知事实 → 更具体的影响结论 ================= */

  // 事实 → 对贵金属影响（比通用的「影响偏中性，方向待确认」更具体）
  // 【C22 重排】顺序原则：**先看利率方向（决定金价的总开关）→ 再看通胀/就业等数据 → 最后兜底**。
  //   原顺序里「通胀|CPI|PPI」排在前面，导致「安本预计美联储将在12月和3月加息」
  //   这类**加息预期**条目被误判成「通胀是核心变量」——结论与标题对不上（用户反馈的 bug）。
  /**
   * 【C22】识别事件主体央行 —— 影响结论里的「谁加息/降息」必须与标题一致。
   *   反例（修复前）：「澳洲央行加息预期升温」→ 结论写「美联储转鹰」→ 结论与标题对不上。
   */
  function cbSubject(t) {
    var s = String(t || "");
    if (/欧洲央行|欧洲中央银行|\becb\b/i.test(s)) return "欧洲央行";
    if (/日本央行|日本银行|\bboj\b/i.test(s)) return "日本央行";
    if (/英国央行|英格兰银行|\boe\b/i.test(s)) return "英国央行";
    if (/加拿大央行|\bboc\b/i.test(s)) return "加拿大央行";
    if (/澳洲央行|澳大利亚央行|澳洲联储|\brba\b/i.test(s)) return "澳洲央行";
    if (/新西兰联储|新西兰央行|\brbnz\b/i.test(s)) return "新西兰联储";
    if (/瑞士央行|\bsnb\b/i.test(s)) return "瑞士央行";
    if (/中国央行|中国人民银行|央行行长|\bpboc\b/i.test(s)) return "中国央行";
    if (/美联储|联储|沃什|鲍威尔|\bfed\b/i.test(s)) return "美联储";
    return "央行";
  }
  // 【C23】IMPACT_RULES 前 6 条 = 「方向类」结论（按兵不动/维持利率/降息/加息/加息预期/降息预期），
  //   其后才是「事件类」泛化结论（议息/决议/声明全文…）。
  //   方向类结论比事件类更具体 → 选取逻辑据此决定「标题优先」还是「正文兜底」。
  var DIR_COUNT = 6;
  var IMPACT_RULES = [
    // ① 按兵不动 + 内部分歧（比「按兵不动」更具体）
    { re: /按兵不动[^。；]{0,14}(分歧|反对票|异议|鹰派|鸽派|内部分歧)/, zh: "{CB}按兵不动但内部分歧加剧，利率路径重定价放大金价波动" },
    // ② 维持利率 / 不加息 / 暂缓加息（**必须排在「加息」规则之前**，否则「暂缓加息」会被判成转鹰）
    { re: /维持[^。；]{0,14}(利率|区间)|利率维持|维持利率|利率区间|利率不变|预期维持|维持不变|维持现状|不加息|按兵不动|暂缓加息|暂停加息|推迟加息|延后加息|暂不加息|未加息|放弃加息|停止加息/,
      zh: "{CB}按兵不动，金价缺少明确方向指引" },
    // ③ 降息 → 转鸽
    { re: /降息|转鸽|鸽派/, zh: "{CB}转鸽，实际利率下行支撑金价" },
    // ④ 加息 → 转鹰（排在通胀规则之前）
    { re: /加息|鹰派|收紧|紧缩/, zh: "{CB}转鹰，实际利率上行压制金价" },
    // ⑤ 加息/降息预期
    { re: /加息预期|预期[^。；]{0,12}加息|加息可能|加息风险|加息概率/, zh: "市场预期{CB}加息，实际利率上行压制金价" },
    { re: /降息预期|预期[^。；]{0,12}降息|降息可能|降息概率/, zh: "市场预期{CB}降息，实际利率下行支撑金价" },
    // ⑥ 议息结果
    { re: /议息|决议|利率决定|利率决议|声明全文/, zh: "{CB}议息结果落地，市场重新定价利率路径" },
    // ⑦ 政策路径 / 点阵图 / 会议纪要
    { re: /前瞻指引|政策路径|点阵图|经济预测摘要/, zh: "{CB}政策路径指引改变降息预期，直接作用于金价" },
    { re: /纪要/, zh: "{CB}会议纪要揭示内部立场分歧，加剧金价波动" },
    // ⑧ 数据面（【C29】改为函数：把命中的具体指标嵌进结论，避免「通胀类」事件结论千篇一律雷同）
    { re: /通胀|CPI|PPI/, zh: function (s) { var m = /PPI/i.test(s) ? "PPI" : /CPI/i.test(s) ? "CPI" : "通胀数据"; return m + "是金价定价的核心变量，实际利率随之变化，短线方向取决于数据超预期幅度"; } },
    { re: /非农|失业率|就业/, zh: function (s) { var m = /非农/i.test(s) ? "非农就业" : /失业率/i.test(s) ? "失业率" : "就业数据"; return m + "决定降息预期，进而引导金价方向，幅度看与预期的偏差"; } },
    { re: /PMI|制造业|工业增加值|GDP|经济数据|社融|零售/, zh: function (s) { var m = /GDP/i.test(s) ? "GDP" : /PMI/i.test(s) ? "PMI" : /社融/i.test(s) ? "社融" : /零售/i.test(s) ? "零售" : /制造业/i.test(s) ? "制造业" : "经济数据"; return m + "反映增长与降息预期，是金价中期方向的关键变量"; } },
    { re: /美债收益率上行|收益率走高/, zh: "美债收益率上行抬高持有黄金的机会成本，金价承压" },
    { re: /美债收益率下行|收益率走低/, zh: "美债收益率下行降低持金机会成本，金价偏强" },
    { re: /美元走强|美元上涨/, zh: "美元走强压制以美元计价的金价" },
    { re: /美元走弱|美元下跌/, zh: "美元走弱对金价构成支撑" },
    { re: /地缘冲突升级|地缘风险|冲突升级/, zh: "地缘风险推升避险买盘，金价偏强" },
    // ⑨ 需求/配置
    { re: /央行购金|购金|增持黄金|配置黄金|实物需求|\bETF\b/i, zh: "官方购金与配置需求是金价的结构性支撑" },
    { re: /黄金产量|金矿|矿产金|供应量/, zh: "黄金供给端变化对金价影响弱于实际利率" },
    // 【C22】以下几条覆盖此前仍会落到「影响偏中性，方向待确认」的正式事件
    { re: /COMEX|库存|持仓/, zh: "交易所库存与持仓变化反映贵金属实物供需与交割压力" },
    { re: /资产配置|配置黄金|资金流向/, zh: "利率走向决定大类资产配置节奏，进而影响金价" },
    { re: /信贷|社融|贷款|货币供应|M2|存款/, zh: "信贷与货币政策数据决定增长预期与利率路径" },
    { re: /关税/, zh: "关税政策推升避险需求与贸易成本，抬升金价避险溢价" },
    { re: /收益率[^。；]{0,6}(飙升|攀升|走高|上行|冲高)/, zh: "债券收益率飙升抬高持金机会成本，金价承压" },
    { re: /债务|赤字|财政/, zh: "财政债务风险推升避险与通胀预期，对金价形成支撑" },
    // ⑩ 贵金属自身价格（【C29】按金/银区分，避免一律写「贵金属」）
    { re: /金价|银价|铜价|贵金属|白银|黄金/, zh: function (s) { var m = /白银|银价/i.test(s) ? "白银" : /黄金|金价/i.test(s) ? "黄金" : "贵金属"; return m + "自身价格波动，注意与基本面脱节的风险，短线以技术面为主"; } },
    // 【C23】央行人事 / 领导层：权威政策事件，但改变的是**政策路径预期**而非当期利率方向，
    //   故放在末尾（不与 DIR_COUNT 内的方向类竞争），仅在前面规则都不命中时兜住，
    //   避免落到「影响偏中性，方向待确认」。
    { re: /主席人选|主席提名|主席继任|提名.*主席|行长(人选|提名|换届|更替)|人事变动|领导层(更迭|变动)|沃什.{0,6}(主席|人选|提名)|warsh.{0,20}(chair|nominee|confirmed|appointed)/i,
      zh: "央行领导层与政策风格变化将重塑利率路径预期，利率定价随之调整" },
    // 【C23 补·语义触发面】中文源常把「人事」隐含在「人物 + 央行权力」的表述里，
    //   不出现「主席/行长/提名」字面词（如「沃什学会不露声色地运用美联储权力」）→
    //   故按「央行 + 权力/风格/立场/手腕」或「人物 + 央行 + 权力」的组合触发。
    { re: /(沃什|鲍威尔|库克|哈马克|布雷曼|贝森特|耶伦|拉加德|植田|皮特)[^。；]{0,24}(美联储|联储|央行|欧洲央行|日本央行|英国央行)|(美联储|联储|央行|欧洲央行|日本央行|英国央行|欧洲中央银行)[^。；]{0,20}(权力|手腕|风格|立场|运力|运权|路线|掌舵|掌门人|领导层|人事|换届)/,
      zh: "央行领导层与政策风格变化将重塑利率路径预期，利率定价随之调整" },
  ];

  /**
   * 铜的「工业金属」影响结论（与金银的货币属性彻底分开）：
   * 铜由供需 / 中国工业 / 矿端 / 美元定价，不走「避险 / 实际利率」那套。
   */
  var COPPER_IMPACT_RULES = [
    // 【C22 重排·一】供给端的**方向**必须先判：产量下滑/供给收缩 → 支撑铜价；
    //   产量增长/供给放量 → 压制铜价。两者不能共用一句「供应端扰动」。
    { re: /(产量|产铜|产出|供应量|供给量|产能|guidance|指引)[^。；]{0,20}(增长|增加|提升|上调|上修|扩产|放量|创新高|增加至|超预期)|(增长|增加|提升|上调|上修|扩产|放量|创新高)[^。；]{0,16}(产量|产铜|产能|供给|供应|指引)/,
      zh: "铜供给放量，压制铜价上行空间" },
    { re: /(产量|产铜|产出|供应量|供给量|产能|guidance|指引)[^。；]{0,20}(下降|减少|下滑|下修|下调|削减|收窄|缩减|收低|低于预期)|(下降|下滑|下修|下调|削减|收窄|缩减|收低)[^。；]{0,16}(产量|产铜|产能|供给|供应|指引)/,
      zh: "铜供给收缩，对铜价形成支撑" },
    // 【C22 重排·二】供给中断类
    { re: /停产|事故|罢工|减产|中断|扰动|干扰|检修/, zh: "铜矿供应端扰动，铜价易涨难跌" },
    // 【C22 重排·三】库存/持仓的**方向**规则必须排在通用「库存」规则之前，
    //   否则「LME铜库存上升」会被通用规则抢先 → 误判成「铜矿供应端扰动」。
    { re: /(库存|持仓)[^。；]{0,12}(上升|增加|回补|累积|走高)|(上升|增加|回补|累积|走高)[^。；]{0,12}(库存|持仓)/,
      zh: "交易所库存上升，铜价上行承压" },
    { re: /(库存|持仓)[^。；]{0,12}(下降|减少|去化|回落|走低)|(下降|减少|去化|回落|走低)[^。；]{0,12}(库存|持仓)/,
      zh: "交易所库存下降，铜价支撑增强" },
    { re: /库存|持仓/, zh: "交易所库存变化反映铜市供需松紧" },
    // 【C22 重排·四】铜价自身方向（供给/库存都判不出时才用）
    { re: /(沪铜|伦铜|铜价|LME铜|铜主力)[^。；]{0,10}(偏强|走强|上涨|大涨|收涨|强势)/,
      zh: "铜价短线走势偏强，基本面与宏观预期共同支撑" },
    { re: /(沪铜|伦铜|铜价|LME铜|铜主力)[^。；]{0,10}(偏弱|走弱|下跌|大跌|收跌|弱势)/,
      zh: "铜价短线走势偏弱，基本面与宏观预期共同拖累" },
    { re: /(沪铜|伦铜|铜价|LME铜|铜主力)[^。；]{0,10}(震荡|整理|窄幅)/,
      zh: "铜价震荡整理，供需与宏观预期双向博弈" },
    // 【C22 重排·五】需求侧
    { re: /电网|电缆|新能源|基建|房地产|制造业|需求|消费|订单/, zh: "工业需求预期变化，主导铜价方向" },
    // 【C22 重排·六】产量指引（方向不明时也给具体结论，不写「中性待确认」）
    { re: /指引|guidance/i, zh: "铜企产量指引区间调整，供给预期变化主导铜价方向" },
    // 【C22 重排·七】以下为宏观/贸易/美元口径
    { re: /中国/, zh: "中国占全球铜消费近半，中国动向主导铜价" },
    { re: /关税|贸易/, zh: "铜关税与贸易摩擦直接抬升或压制铜价" },
    { re: /美元走强/, zh: "美元走强压制以美元计价的铜价" },
    { re: /美元走弱/, zh: "美元走弱对铜价构成支撑" },
    { re: /衰退|经济放缓/, zh: "经济衰退预期压制工业金属需求，铜价承压" },
    // 通用供应扰动（库存已被上面单独处理，这里不再兜「库存」）
    { re: /铜矿|矿端|冶炼|供应|供给|出口禁令/, zh: "铜矿供应端扰动，铜价易涨难跌" },
    // LME 升贴水/持仓等交易所数据 → 库存与持仓信号
    { re: /LME|升贴水|持仓变化|SHFE|沪铜|伦铜/, zh: "交易所库存与持仓变化，反映铜市资金与供需松紧" },
    // 【C23】交易所政策 / 交割规则（SMM 一手源，如「上期所暂停阴极铜铝期货保税交割业务」）
    //   → 权威事件须保留，但结论要具体：交割与规则调整改变的是**铜的现货供需与区域价差**，
    //   按铜（工业金属）口径给结论，不混入金银的避险/实际利率逻辑。
    { re: /(交易所|上期所|沪期所|LME|伦金属|保税|交割|挂牌|合约|仓单|注册仓单|注销仓单|保证金|涨跌停|限仓|手续费)[^。；]{0,18}(暂停|恢复|调整|变更|修订|收紧|放宽|取消|上线|推出|限制|提高|下调|终止)/,
      zh: "交易所交割与规则调整改变铜的现货供需与区域价差，直接作用于铜价" },
    { re: /保税交割|交割(业务|规则|品|品牌)|仓单|注册仓单|注销仓单|合约(修改|调整|上市)|保证金(调整|提高|下调)/,
      zh: "交易所交割与仓单规则变化改变铜的现货供需与区域价差，直接作用于铜价" },
  ];

  /**
   * 影响结论：优先用事实推出的具体结论，否则用原有多空判定。
   * 【C22】金属感知：copper 走工业金属逻辑（供应/需求/中国工业），
   *   不再套用金银的「避险 / 实际利率」结论；金银仍走货币属性结论。
   * @param {String} fact  zhFact() 的结果（可为空）
   * @param {String} dir   impactOf() 的 up/down/mixed
   * @param {String} metal 影响结论针对的品种（gold/silver/copper）
   */
  // 【C29】规则命中解析：支持 zh 既可以是字符串（含 {CB} 占位，按来源填央行名），
  //   也可以是函数（入参为命中来源文本，用于把具体指标嵌进结论，做出差异化）。
  function resolveImpact(rules, src) {
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].re.test(src)) {
        var z = rules[i].zh;
        var out = typeof z === "function" ? z(src) : z.replace(/\{CB\}/g, cbSubject(src));
        return { txt: out, idx: i };
      }
    }
    return null;
  }
  function zhImpact(fact, dir, metal, alt) {
    var f = String(fact || "");
    var a = String(alt || "");
    if (metal === "copper") {
      var c1 = f ? resolveImpact(COPPER_IMPACT_RULES, f) : null;
      if (!c1 && a && a !== f) c1 = resolveImpact(COPPER_IMPACT_RULES, a);
      if (c1) return c1.txt + "（影响偏直接）";
      // 【C29】兜底：方向感知 + 程度，绝不以「影响」二字开头（避免 UI 出现「影响：影响…」）
      if (dir === "up") return "铜价短线偏强，但上行持续性待库存与需求数据确认（方向待验证）";
      if (dir === "down") return "铜价短线承压，关注矿端扰动与下游需求能否接力（方向待验证）";
      return "铜价方向暂不明，短线波动有限，关注后续库存与需求数据";
    }
    // 【C23】标题优先 + 方向兜底（修「标题泛化压掉正文具体方向」）
    //   ① 标题命中「方向类」规则 → 以标题为准（标题已给明确方向，正文不得覆盖）；
    //   ② 标题只命中「事件类」泛化规则、而正文含明确方向 → 用正文的方向结论；
    //   ③ 两者都是泛化规则 → 仍以标题为准（保持「结论主体 = 标题主体」）。
    var t = f ? resolveImpact(IMPACT_RULES, f) : null;
    var al = (!t && a && a !== f) ? resolveImpact(IMPACT_RULES, a) : null;
    var pick = null, src = f;
    if (t && t.idx < DIR_COUNT) { pick = t; src = f; }
    else if (al && al.idx < DIR_COUNT) { pick = al; src = a; }
    else if (t) { pick = t; src = f; }
    else if (al) { pick = al; src = a; }
    if (pick) {
      // 【C29】影响程度/确定性提示：
      //   方向类规则（利率方向已定）→ 影响偏直接；事件/数据类泛化规则 → 幅度视后续数据而定。
      var deg = pick.idx < DIR_COUNT ? "（影响偏直接）" : "（幅度视后续数据而定）";
      return pick.txt + deg;
    }
    // 【C29】兜底：方向感知 + 程度，绝不以「影响」二字开头（消除「影响：影响偏中性」式冗余）
    if (dir === "up") return "利多信号偏明确，金价短线有望获得支撑（关注实际利率变化验证）";
    if (dir === "down") return "利空压力偏直接，金价短线面临回调压力（关注实际利率变化验证）";
    return "事件方向中性，短线对金价影响有限，需后续数据确认";
  }

  /**
   * 【C31】影响面（受冲击的具体资产 / 市场）：按品种 + 事实关键词，列出被直接冲击的品种与关联市场，
   *   让「影响」不再只是笼统一句，而是明确「影响哪些东西」。
   * @returns {String[]} 影响面清单（去重、保序）
   */
  // 关键词命中辅助（用 indexOf 而非正则，规避中文正则字面量在本文件中的异常匹配问题）
  function hasAny(s, arr) {
    for (var i = 0; i < arr.length; i++) { if (s.indexOf(arr[i]) >= 0) return true; }
    return false;
  }
  function impactScope(metal, fact, alt) {
    var s = String(fact || "") + " " + String(alt || "");
    var scope = [];
    if (metal === "copper") {
      scope.push("沪铜 / 伦铜");
      if (hasAny(s, ["库存", "持仓", "交割", "仓单", "保税", "SHFE", "LME", "升贴水"])) scope.push("库存与区域价差");
      if (hasAny(s, ["矿端", "罢工", "停产", "减产", "检修", "事故", "供应", "供给", "出口禁令", "冶炼", "扰动", "干扰"])) scope.push("铜矿供应");
      if (hasAny(s, ["电网", "电缆", "新能源", "基建", "房地产", "制造业", "需求", "消费", "订单"])) scope.push("工业需求端");
      if (hasAny(s, ["关税", "贸易"])) scope.push("贸易成本");
      if (hasAny(s, ["美元走强", "美元走弱", "美元"])) scope.push("美元定价");
    } else {
      scope.push(metal === "silver" ? "银价 / 白银T+D" : "金价 / AU9999");
      if (hasAny(s, ["利率", "加息", "降息", "议息", "决议", "美联储", "央行", "点阵图", "前瞻指引", "纪要", "货币"])) scope.push("实际利率与美元");
      if (hasAny(s, ["通胀", "CPI", "PPI", "非农", "失业率", "就业", "GDP", "PMI", "社融", "零售"])) scope.push("通胀与实际利率预期");
      if (hasAny(s, ["地缘", "冲突", "制裁", "避险", "关税", "债务危机", "债务风险", "主权债务", "财政赤字", "财政风险"])) scope.push("避险买盘");
      if (hasAny(s, ["央行购金", "购金", "增持黄金", "配置黄金", "ETF", "实物需求"])) scope.push("央行购金与ETF配置");
    }
    var seen = {};
    return scope.filter(function (x) { if (seen[x]) return false; seen[x] = 1; return true; });
  }

  /**
   * 【C31】影响程度分级：按命中规则类别 + 多空方向，给出确定性 / 幅度分级。
   *   方向类规则（利率方向已定）→ 确定性高；数据 / 供需类 → 中等（幅度视数据 / 事件驱动）；
   *   兜底（无明确规则）→ 随方向标「待验证」。
   * @returns {String} 程度描述（短标签）
   */
  function impactDegree(metal, fact, alt, dir) {
    var f = String(fact || "");
    var a = String(alt || "");
    var rules = metal === "copper" ? COPPER_IMPACT_RULES : IMPACT_RULES;
    var hit = (f ? resolveImpact(rules, f) : null) || ((a && a !== f) ? resolveImpact(rules, a) : null);
    if (hit) {
      if (hit.idx < DIR_COUNT) return "确定性高 · 方向已定";
      if (/通胀|CPI|PPI|非农|失业率|就业|GDP|PMI|社融|零售|经济数据|库存|持仓|需求|消费|订单/) return "中等 · 幅度视数据";
      return "中等 · 事件驱动";
    }
    return dir === "up" ? "偏强 · 待验证" : dir === "down" ? "偏弱 · 待验证" : "中性 · 待确认";
  }

  /**
   * 【C32 · P0】自然语言影响结论（替代 zhImpact 的「规则→整句」查表）。
   *
   * 【为什么必须改数据层】用户反馈：「事件影响的结论，还是跟没有一样，制式、模版式展示」。
   *   实测线上 125 条事件只有 25 种不同结论，89.6% 的条目与他人重复 —— 根因是
   *   zhImpact() 属于「规则命中 → 返回一整句固定文案」的查表，同一机制必然产出同一句。
   *   所以清洗措辞救不了，必须**现场组句**。
   *
   * 【组句公式】= 具体锚点句（指标/实际值vs预期值/央行主体）+ 传导机制句（机制 × 方向）
   *              + 资产方向句（按 dir）+ 验证锚点句（下一步看什么）
   *   → 同一机制下的不同事件，因「实际值 vs 预期值」「央行主体」不同而产出不同句子。
   *
   * 【质量门禁】输出若仍含「影响偏中性，方向待确认」或长度 < 12 → 退回「机制+资产」兜底句。
   */

  // 指标识别（顺序敏感：核心PCE 必须先于 PCE；否则「核心PCE」会被识别成 PCE）
  var INDICATOR_RULES = [
    { re: /核心\s*PCE/i, label: "核心PCE" },
    { re: /PCE/i, label: "PCE" },
    { re: /PPI/i, label: "PPI" },
    { re: /CPI/i, label: "CPI" },
    { re: /非农/i, label: "非农就业" },
    { re: /失业率/i, label: "失业率" },
    { re: /GDP/i, label: "GDP" },
    { re: /PMI/i, label: "PMI" },
    { re: /社融/i, label: "社融" },
    { re: /零售/i, label: "零售" },
    { re: /通胀/i, label: "通胀数据" },
    { re: /收益率/i, label: "美债收益率" },
    { re: /美元/i, label: "美元" },
  ];
  function indicatorOf(s) {
    for (var i = 0; i < INDICATOR_RULES.length; i++) {
      if (INDICATOR_RULES[i].re.test(s)) return INDICATOR_RULES[i].label;
    }
    return "";
  }

  // 实际值 vs 预期值：优先做数值比较（"同比 4.2%，预期 4.6%"），再做语义匹配。
  //   这是让「通胀类」结论真正分化的关键 —— 8 条通胀事件原本共用同一句。
  function surpriseOf(s) {
    var t = String(s || "");
    var m = t.match(/(\d+(?:\.\d+)?)\s*%[^%]{0,24}?预期\s*(\d+(?:\.\d+)?)\s*%/);
    if (m) {
      var a = parseFloat(m[1]), e = parseFloat(m[2]);
      if (!isNaN(a) && !isNaN(e)) {
        if (a > e) return "hot";
        if (a < e) return "cold";
        return "flat";
      }
    }
    if (/超预期|高于预期|超出预期|创[^，。；]{0,8}新高|升至|涨至|攀升|走高|加速上行|上行至|反弹/.test(t)) return "hot";
    if (/低于预期|逊于预期|不及预期|回落至|降至|放缓|跌至|走弱|创[^，。；]{0,8}新低|回落/.test(t)) return "cold";
    if (/符合预期|符合市场预期|与预期持平|持平|预期之内|预期内|符合此前/.test(t)) return "flat";
    return "";
  }
  // 首个百分比（实际值），用于把「具体数字」写进结论
  function actualNumOf(s) {
    var m = String(s || "").match(/(\d+(?:\.\d+)?)\s*%/);
    return m ? m[1] + "%" : "";
  }

  // 机制判定：加权计分 → 取分数最高的 1~2 个机制（多机制可叠加，如「通胀 + 加息预期」）
  function mechScores(s, defs) {
    var sc = {};
    for (var i = 0; i < defs.length; i++) {
      if (defs[i].re.test(s)) sc[defs[i].key] = defs[i].w;
    }
    return sc;
  }
  function topMechs(sc, defs, max) {
    var arr = [];
    for (var k in sc) if (Object.prototype.hasOwnProperty.call(sc, k)) arr.push({ key: k, w: sc[k] });
    // 分数降序；同分按 defs 中的优先级（defs 越靠前优先级越高）
    var idx = {};
    for (var i = 0; i < defs.length; i++) idx[defs[i].key] = i;
    arr.sort(function (a, b) { return (b.w - a.w) || (idx[a.key] - idx[b.key]); });
    var picked = arr.slice(0, max || 1);
    // 「price / cu_price」（资产自身价格波动）只适合当**唯一**机制：
    //   它几乎在每条标题里都会命中（提到「金价」就算），若作为第二机制叠加，
    //   会给「美联储加息」这类结论尾巴上挂一句「金价自身价格波动与基本面背离」→ 反而变噪声。
    if (picked.length > 1) {
      picked = picked.filter(function (x) { return x.key !== "price" && x.key !== "cu_price"; });
    }
    // 【C32-bugfix】同义机制不叠加：铜的「工业需求」与「中国/全球增长」结论都以「主导铜价方向」收尾，
    //   两条一起上就变成「…主导铜价方向，…主导铜价方向」（实拍重复）。保权重高的那个。
    if (picked.length > 1) {
      var has = {};
      for (var p = 0; p < picked.length; p++) has[picked[p].key] = 1;
      if (has.cu_demand && has.cu_macro) {
        picked = picked.filter(function (x) { return x.key !== "cu_macro"; });
      }
      if (has.inflation && has.growth && picked.length > 2) {
        picked = picked.slice(0, 2);
      }
    }
    return picked;
  }

  /* ---------- 贵金属（货币属性）机制定义 ---------- */
  var PRECIOUS_MECHS = [
    { key: "centralbuy", w: 4, re: /央行购金|购金|增持黄金|黄金储备|官方储备|储备增持/ },
    { key: "safehaven", w: 4, re: /地缘|冲突|战争|制裁|避险|空袭|停火|袭击/ },
    { key: "trade", w: 4, re: /关税|贸易战|出口管制|对等关税|贸易摩擦/ },
    { key: "fiscal", w: 4, re: /赤字|债务|财政|国债发行|主权信用/ },
    // 【C32-bugfix】补「声明 / 会议纪要 / 政策报告」：否则「美联储10月声明全文对比」会落进通胀机制，
    //   写成「通胀数据读数变化」，与事件（政策措辞变化）对不上
    { key: "rate_decision", w: 4, re: /议息|利率决议|FOMC|点阵图|纪要|前瞻指引|经济预测|记者会|主席记者|政策声明|声明全文|会议声明|政策报告/ },
    { key: "rate", w: 3, re: /加息|降息|按兵不动|维持利率|利率不变|不加息|暂缓加息|利率区间|利率路径|利率决定|货币政策|利率预期/ },
    { key: "inflation", w: 3, re: /CPI|PCE|PPI|通胀|物价|核心通胀/ },
    { key: "labor", w: 3, re: /非农|失业率|就业|薪资|薪酬/ },
    { key: "growth", w: 3, re: /GDP|PMI|社融|零售|工业增加值|经济增长/ },
    { key: "yield", w: 2, re: /收益率|国债|美债/ },
    { key: "dollar", w: 2, re: /美元指数|美元走强|美元走弱|美元上涨|美元下跌|美元兑|美元汇率|强美元|弱美元|美元升值|美元贬值|美元新高|美元大跌|美元大涨/ },
    { key: "positioning", w: 2, re: /库存|持仓|COMEX|ETF|资金流/ },
    { key: "supply", w: 2, re: /产量|矿产|矿端|供给|供应|冶炼/ },
    { key: "price", w: 1, re: /金价|银价|黄金|白银|贵金属/ },
  ];

  /* ---------- 铜（工业金属）机制定义 ---------- */
  var COPPER_MECHS = [
    { key: "cu_supply", w: 4, re: /罢工|停产|减产|产量|供给|供应|冶炼|矿端|铜矿|产能|指引|guidance/i },
    { key: "cu_inventory", w: 4, re: /库存|仓单|保税|LME|SHFE|沪期所|持仓|升贴水|交割/ },
    { key: "cu_demand", w: 4, re: /电网|电缆|新能源|光伏|风电|基建|房地产|制造业|需求|订单|消费/ },
    { key: "cu_rule", w: 3, re: /保证金|涨跌停|限仓|手续费|合约修改|挂牌|规则|合约/ },
    { key: "cu_trade", w: 3, re: /关税|贸易战|出口管制|贸易摩擦|贸易/ },
    { key: "cu_macro", w: 2, re: /中国|衰退|放缓|GDP|PMI|宏观|增长/ },
    { key: "cu_dollar", w: 2, re: /美元指数|美元走强|美元走弱|美元上涨|美元下跌|美元兑|美元汇率|强美元|弱美元|美元升值|美元贬值/ },
    { key: "cu_price", w: 1, re: /铜价|沪铜|伦铜|LME铜|铜主力/ },
  ];

  /* ---------- 贵金属：机制句（事实性传导，不写资产方向，方向由 dir 决定） ---------- */
  // 利率语气：先剥掉否定式，再判鹰/鸽/按兵不动
  //   坑：「维持利率不变（不加息）」「暂缓加息」都含子串「加息」→ 直接判鹰会得到
  //   「美联储释放加息信号」这种与事实相反的结论（C22 曾踩过同坑）。
  var HOLD_MARK = "HOLD";
  function rateTone(fact) {
    var s = String(fact || "");
    s = s.replace(/不加息|暂缓加息|暂停加息|推迟加息|延后加息|暂不加息|未加息|放弃加息|停止加息|不会加息|不降息|暂缓降息|暂停降息|不调整利率/g, HOLD_MARK);
    if (/降息|鸽派|转鸽|宽松/.test(s)) return "dovish";
    if (/加息|鹰派|转鹰|收紧|紧缩/.test(s)) return "hawkish";
    if (s.indexOf(HOLD_MARK) >= 0 || /按兵不动|维持|不变/.test(s)) return "hold";
    return "other";
  }
  // 「主要央行」是 cbSubject 的通用兜底 → 不算具体主体，结论里不点名央行
  function cbOf(src) {
    var c = cbSubject(src);
    return c === "央行" ? "" : c;
  }
  function preciousClause(key, ctx) {
    var IND = ctx.ind, NUM = ctx.num, SUR = ctx.sur, CB = ctx.cb, F = ctx.fact;
    switch (key) {
      case "inflation":
        if (SUR === "hot") return IND + (NUM ? NUM + "高于预期，" : "超预期，") + "通胀预期与实际利率路径同步上修";
        if (SUR === "cold") return IND + (NUM ? NUM + "低于预期，" : "回落，") + "通胀预期降温、降息定价升温";
        if (SUR === "flat") return IND + (NUM ? NUM + "符合预期，" : "符合预期，") + "通胀路径缺少增量信息";
        // 没有「预期值」可对比时，至少把实际读数写进去（3.1% 与 3.6% 不该是同一句）
        return IND + (NUM ? "读数" + NUM : "读数变化") + "，通胀预期与实际利率路径随之重估";
      case "rate":
        var tone = ctx.tone;
        if (tone === "hawkish") return (CB ? CB : "主要央行") + "释放加息信号，实际利率上行预期升温";
        if (tone === "dovish") return (CB ? CB : "主要央行") + "释放降息信号，实际利率下行预期升温";
        if (tone === "hold") return (CB ? CB : "主要央行") + "按兵不动，利率路径重定价放大波动";
        return (CB ? CB : "主要央行") + "利率路径预期被修正，利率定价随之调整";
      case "rate_decision":
        return (CB ? CB : "主要央行") + "政策声明与利率路径指引更新，前瞻预期被重新定价";
      case "labor":
        if (SUR === "hot") return IND + (NUM ? NUM + "显示劳动力市场韧性，" : "显示劳动力市场韧性，") + "降息定价降温";
        if (SUR === "cold") return IND + (NUM ? NUM + "显示劳动力市场走弱，" : "显示劳动力市场走弱，") + "降息定价升温";
        if (SUR === "flat") return IND + (NUM ? NUM + "符合预期，" : "符合预期，") + "就业对政策的指示意义中性";
        return IND + (NUM ? "读数" + NUM : "读数变化") + "，就业对政策的指示意义待确认";
      case "growth":
        if (SUR === "hot") return IND + (NUM ? NUM + "显示增长韧性，" : "显示增长韧性，") + "利率高位维持预期升温";
        if (SUR === "cold") return IND + (NUM ? NUM + "显示增长走软，" : "显示增长走软，") + "降息与衰退定价升温";
        if (SUR === "flat") return IND + (NUM ? NUM + "符合预期，" : "符合预期，") + "增长对定价的指示意义中性";
        return IND + (NUM ? "读数" + NUM : "读数变化") + "，增长对定价的指示意义待确认";
      case "dollar":
        if (/美元走强|美元上涨|美元指数.{0,4}(升|涨|新高)/.test(F)) return "美元走强，直接改写以美元计价的商品定价锚";
        if (/美元走弱|美元下跌|美元指数.{0,4}(跌|降)/.test(F)) return "美元走弱，直接改写以美元计价的商品定价锚";
        return "美元走势直接改写以美元计价的商品定价锚";
      case "yield":
        if (/收益率.{0,6}(上行|走高|攀升|飙升|冲高)/.test(F)) return "美债收益率上行，抬高持有贵金属的机会成本";
        if (/收益率.{0,6}(下行|走低|回落)/.test(F)) return "美债收益率下行，降低持有贵金属的机会成本";
        return "美债收益率变动，直接改写持有贵金属的机会成本";
      case "safehaven":
        // 停火 / 和谈 / 缓和 → 风险溢价回吐（利空）；冲突升级 → 避险买盘（利多）
        if (/停火|和谈|缓和|降级|撤军|协议|降温|回吐/.test(F)) return "地缘风险溢价回吐，避险配置需求随之降温";
        if (/升级|爆发|开战|空袭|袭击|冲突|战争|制裁|紧张/.test(F)) return "地缘与冲突风险溢价重新定价，避险配置需求随之升温";
        return "地缘与冲突风险溢价重新定价，避险配置需求随之波动";
      case "centralbuy": return "官方购金与储备需求构成贵金属的结构性买盘";
      case "trade": return "关税与贸易成本同时作用于通胀路径与避险需求";
      case "fiscal": return "财政赤字与债务供给压力作用于通胀预期与期限溢价";
      case "positioning": return "交易所库存与持仓结构反映交割压力与配置节奏";
      case "supply": return "矿产供给扰动的定价解释力弱于实际利率";
      case "price": return ctx.asset + "自身价格波动与基本面存在背离，短线以技术面为主";
    }
    return "";
  }

  /* ---------- 铜：机制句 ---------- */
  function copperClause(key, ctx) {
    var IND = ctx.ind, NUM = ctx.num, SUR = ctx.sur, F = ctx.fact;
    switch (key) {
      case "cu_supply":
        if (/(产量|产铜|产出|供应量|供给量|产能|指引|guidance)[^。；]{0,20}(增长|增加|提升|上调|上修|扩产|放量|创新高|增加至|超预期)/.test(F)
          || /(增长|增加|提升|上调|上修|扩产|放量|创新高)[^。；]{0,16}(产量|产铜|产能|供给|供应|指引)/.test(F)) return "铜矿产量与冶炼供给放量预期升温，供给端转向宽松";
        if (/(产量|产铜|产出|供应量|供给量|产能)[^。；]{0,20}(下降|减少|下滑|下修|下调|削减|收缩|低于预期)/.test(F)
          || /(下降|下滑|下修|下调|削减|收缩|减产|停产|罢工|扰动|事故)/.test(F)) return "铜矿减产与供应扰动增多，供给端收紧预期升温";
        // 【C32-bugfix】兜底按事件类型细分：「口岸通关受阻」与「产量指引调整」不该共用一句话
        if (/口岸|通关|运输|物流|到货|发运|装船|港口|铁路|卡车/.test(F)) return "矿端通关与运输环节受阻，冶炼厂短期到货偏紧";
        if (/罢工|停产|事故|检修|塌方|不可抗力|关停/.test(F)) return "矿山生产扰动，供给收缩预期升温";
        if (/冶炼|加工费|TC|RC|粗炼|精炼|开工率/.test(F)) return "冶炼端加工费与开工率变化，供给弹性受限";
        if (/出口禁令|出口限制|关税|配额|禁令/.test(F)) return "资源出口政策收紧，铜精矿可流通量受限";
        if (/产量|产铜|产出|产能|指引|guidance/i.test(F)) return "铜企产量指引区间调整，供给预期变化主导铜价";
        return "铜精矿供应端出现新变化，供给预期重新定价";
      case "cu_inventory":
        if (/库存|持仓/.test(F) && /(上升|增加|回补|累积|走高)/.test(F)) return "交易所库存累积，铜价上行承压";
        if (/库存|持仓/.test(F) && /(下降|减少|去化|回落|走低)/.test(F)) return "交易所库存去化，铜价支撑增强";
        return "交易所库存与保税仓单变化，反映铜市供需松紧与区域价差";
      case "cu_demand": return "电网、新能源与制造业需求预期变化，主导铜价方向";
      case "cu_rule": return "交易所交割与规则调整，改变铜的现货供需与区域价差";
      case "cu_trade": return "关税与贸易摩擦直接抬升或压制铜价";
      case "cu_macro": return "中国需求与全球增长预期变化，主导铜价方向";
      case "cu_dollar":
        if (/美元走强|美元上涨/.test(F)) return "美元走强，直接改写以美元计价的铜价锚";
        if (/美元走弱|美元下跌/.test(F)) return "美元走弱，直接改写以美元计价的铜价锚";
        return "美元走势直接改写以美元计价的铜价锚";
      case "cu_price": return "铜价自身波动与基本面存在背离，短线以技术面为主";
    }
    return "";
  }

  /**
   * 机制隐含的价格方向（用于消解「机制句与方向句自相矛盾」）。
   *   机制方向确定 → 用机制方向（比关键词分类器更具体）；
   *   机制方向与 dir 冲突 → 明说「分歧」，绝不写出「加息信号 + 金价获支撑」这种自相矛盾句。
   */
  function mechDir(key, ctx) {
    var F = ctx.fact;
    switch (key) {
      case "rate":
        if (ctx.tone === "hawkish") return "down";
        if (ctx.tone === "dovish") return "up";
        return "";
      case "inflation":
        if (ctx.sur === "hot") return "down";
        if (ctx.sur === "cold") return "up";
        return "";
      case "labor":
        if (ctx.sur === "hot") return "down";
        if (ctx.sur === "cold") return "up";
        return "";
      case "growth":
        if (ctx.sur === "hot") return "down";
        if (ctx.sur === "cold") return "up";
        return "";
      case "dollar":
        if (/美元走强|美元上涨/.test(F)) return "down";
        if (/美元走弱|美元下跌/.test(F)) return "up";
        return "";
      case "yield":
        if (/收益率.{0,6}(上行|走高|攀升|飙升|冲高)/.test(F)) return "down";
        if (/收益率.{0,6}(下行|走低|回落)/.test(F)) return "up";
        return "";
      case "safehaven":
        // 停火/缓和 → 风险溢价回吐（利空）；冲突升级 → 避险买盘（利多）
        if (/停火|和谈|缓和|降级|撤军|协议|降温|回吐/.test(F)) return "down";
        if (/升级|爆发|开战|空袭|袭击|冲突|战争|制裁|紧张/.test(F)) return "up";
        return "";
      case "centralbuy": return "up";
      case "cu_supply":
        if (/(产量|产铜|产出|供应量|供给量|产能|指引|guidance)[^。；]{0,20}(增长|增加|提升|上调|上修|扩产|放量|创新高|增加至|超预期)/.test(F)
          || /(增长|增加|提升|上调|上修|扩产|放量|创新高)[^。；]{0,16}(产量|产铜|产能|供给|供应|指引)/.test(F)) return "down";
        if (/(产量|产铜|产出|供应量|供给量|产能)[^。；]{0,20}(下降|减少|下滑|下修|下调|削减|收缩|低于预期)/.test(F)
          || /(下降|下滑|下修|下调|削减|收缩|减产|停产|罢工|扰动|事故)/.test(F)) return "up";
        return "";
      case "cu_inventory":
        if (/(库存|持仓).{0,12}(上升|增加|回补|累积|走高)/.test(F)) return "down";
        if (/(库存|持仓).{0,12}(下降|减少|去化|回落|走低)/.test(F)) return "up";
        return "";
    }
    return "";
  }

  /* ---------- 验证锚点：下一步该看什么 ---------- */
  var PRECIOUS_ANCHOR = {
    inflation: "关注下月通胀数据与美联储表态",
    rate: "关注12月议息与点阵图",
    rate_decision: "关注点阵图与主席记者会措辞",
    labor: "关注下月非农与失业率",
    growth: "关注下月GDP与PMI初值",
    yield: "关注10年期美债收益率关键位",
    dollar: "关注美元指数与美债收益率是否同向",
    safehaven: "关注冲突进展与避险资金流向",
    centralbuy: "关注各国央行月度购金与ETF持仓",
    trade: "关注关税落地节奏与谈判进展",
    fiscal: "关注财政赤字与国债发行计划",
    positioning: "关注COMEX库存与ETF净流入",
    supply: "关注矿产产量与进口数据",
    price: "关注基本面与价格的背离能否收敛",
  };
  var COPPER_ANCHOR = {
    cu_supply: "关注矿端扰动持续性与冶炼开工率",
    cu_inventory: "关注LME与保税区库存、现货升贴水",
    cu_demand: "关注电网与新能源订单落地节奏",
    cu_rule: "关注交易所交割与保证金规则调整",
    cu_trade: "关注关税落地节奏与铜材出口表现",
    cu_macro: "关注中国开工率、社融与海外PMI",
    cu_dollar: "关注美元指数与人民币汇率",
    cu_price: "关注基本面与价格的背离能否收敛",
  };

  /* ---------- 中性/待定时的「取决于什么」：比「方向待确认」有信息量，且随机制变化 ---------- */
  var PRECIOUS_MIXED = {
    inflation: "通胀数据是否超预期",
    rate: "美联储下一步政策指引",
    rate_decision: "点阵图与记者会措辞",
    labor: "非农与失业率",
    growth: "GDP与PMI初值",
    yield: "10年期美债收益率",
    dollar: "美元指数方向",
    safehaven: "冲突进展与谈判信号",
    centralbuy: "央行购金节奏",
    trade: "关税落地节奏",
    fiscal: "财政赤字与国债发行计划",
    positioning: "COMEX库存与ETF资金流向",
    supply: "矿产产量与进口数据",
    price: "基本面与价格的背离能否收敛",
  };
  var COPPER_MIXED = {
    cu_supply: "矿端扰动持续性与冶炼开工率",
    cu_inventory: "LME与保税区库存、现货升贴水",
    cu_demand: "电网与新能源订单落地节奏",
    cu_rule: "交易所交割与保证金规则调整",
    cu_trade: "关税落地节奏与铜材出口表现",
    cu_macro: "中国开工率、社融与海外PMI",
    cu_dollar: "美元指数与人民币汇率",
    cu_price: "基本面与价格的背离能否收敛",
  };

  /**
   * 【C32】影响结论：自然语言，1–2 句，点名机制 + 资产 + 方向 + 下一步看什么。
   * @param {String} metal gold / silver / copper
   * @param {String} fact  事实标题（zhTitle 结果）
   * @param {String} dir   up / down / mixed
   * @param {String} alt   备选文本（正文/描述）
   * @returns {String}
   */
  function conclude(metal, fact, dir, alt) {
    var isCu = metal === "copper";
    var isAg = metal === "silver";
    var m = isCu ? "copper" : "metal";
    var f = String(fact || "");
    var a = String(alt || "");
    var src = f + " " + a;
    var defs = isCu ? COPPER_MECHS : PRECIOUS_MECHS;
    var anchorMap = isCu ? COPPER_ANCHOR : PRECIOUS_ANCHOR;

    // 资产称谓 —— 严格跟随「当前列表的品种」，不看事件自己提到谁。
    //   【C32-bugfix】原实现有一条「金银混说」规则：银事件若正文里没提银价、只提金价 → 改称「金价」。
    //   跨品种宏观事件（美联储/通胀/日银）正文几乎都是金价口径 → 银列表里满屏「金价短线承压」，
    //   影响面也挂着「金价 / AU9999」（用户实拍反馈）。事件对哪个品种列表展示，结论就必须说哪个品种，
    //   这才是三端语义自洽的口径；事件本身到底提到谁，交给「它被分到哪个桶」表达。
    var asset = isCu ? "沪铜主连" : (isAg ? "银价" : "金价");

    var ctx = {
      fact: f, ind: indicatorOf(src), num: actualNumOf(src), sur: surpriseOf(src),
      cb: cbOf(src), metal: m, tone: rateTone(src), asset: asset,
    };

    // 机制：取分数最高的 1~2 个（两个机制可叠加 → 更具体）
    var sc = mechScores(src, defs);
    var tops = topMechs(sc, defs, sc && Object.keys(sc).length > 1 ? 2 : 1);
    var clauses = [];
    for (var i = 0; i < tops.length; i++) {
      var c = isCu ? copperClause(tops[i].key, ctx) : preciousClause(tops[i].key, ctx);
      if (c) clauses.push(c);
    }
    if (!clauses.length) {
      clauses.push(isCu ? "铜市供需与宏观预期变化，主导铜价方向" : "宏观变量变化，驱动实际利率与美元重新定价");
    }

    // 方向消解：机制方向确定时，机制方向优先（比关键词分类器更具体）；
    //   机制与 dir 冲突 → 明说分歧，绝不写出「加息信号 + 金价获支撑」这种自相矛盾句。
    var md = "";
    for (var j = 0; j < tops.length; j++) {
      md = mechDir(tops[j].key, ctx);
      if (md) break;
    }
    var effDir = dir;
    var conflicted = false;
    if (md) {
      if (dir === "mixed") effDir = md;
      else if (dir !== md) { effDir = "mixed"; conflicted = true; }
    }
    var mixedMap = isCu ? COPPER_MIXED : PRECIOUS_MIXED;
    var dirTxt = conflicted
      ? (asset + "方向存分歧，机制信号与价格表现背离")
      : effDir === "up" ? asset + "短线获支撑"
      : effDir === "down" ? asset + "短线承压"
      : asset + "方向取决于" + (mixedMap[tops[0] ? tops[0].key : ""] || "后续数据验证");

    // 组句：机制句 + 资产方向句(+验证锚点)
    //   【C32-bugfix】同一句里不许把同一件事说两遍（实拍：「…主导铜价方向，沪铜主连方向取决于LME与保税区库存，
    //   关注LME与保税区库存…」三连重复；「…银价方向取决于通胀数据，关注下月通胀数据…」）。
    //   两条去重规则：① 机制句已给方向 → 方向句降级为「幅度与节奏」；② 锚点文字已在句中 → 不再追加。
    var outC = clauses.join("，");
    var tailTxt = dirTxt;
    if (/(主导|决定)[^，。]{0,6}方向/.test(outC) && dirTxt.indexOf("方向取决于") >= 0) {
      tailTxt = "幅度与节奏取决于后续数据";
    }
    var out = outC + "，" + tailTxt;
    var anchor = anchorMap[tops[0] ? tops[0].key : ""];
    if (anchor && clauses.length) {
      var aKey = String(anchor).replace(/^关注/, "");
      var aTokens = aKey.split(/[与、和]/).filter(function (x) { return x.length >= 2; });
      var dupHit = aTokens.some(function (t) { return out.indexOf(t) >= 0; });
      if (!dupHit) out += "，" + anchor;
    }

    // 质量门禁：过短 → 退回「机制+资产」兜底句
    if (out.length < 12) {
      out = clauses.join("，") + "，" + dirTxt;
    }
    // eff：机制修正后的有效方向，与结论正文同源 —— 徽章与正文必须说同一件事
    //   （实测 22 条「徽章中性 / 结论承压」互相打脸，就是两处各算一套方向的后果）
    return { txt: out, eff: conflicted ? "mixed" : (effDir || dir || "mixed") };
  }

  /** 影响结论正文（三端渲染用） */
  function impactConclusion(metal, fact, dir, alt) {
    return conclude(metal, fact, dir, alt).txt;
  }
  /** 机制修正后的有效方向（徽章用）：up / down / mixed，与结论正文严格同源 */
  function impactEffDir(metal, fact, dir, alt) {
    return conclude(metal, fact, dir, alt).eff;
  }

  /* ================= C. 国内源解析 + 噪声门禁 ================= */

  // 国内快讯：贵金属 / 顶层宏观关键词（比境外源的关键词更严，避免噪声淹没）
  // 【C22】去掉「稀土」（非本产品追踪品种，会误拉稀土个股/产业新闻）；其余保留。
  var CN_HIT = /黄金|金价|白银|银价|铜价|贵金属|美联储|议息|不加息|加息|降息|利率决定|利率决议|通胀|CPI|PPI|非农|失业率|关税|贸易战|货币政策|美联储主席|经济数据|GDP|衰退|避险|量化宽松|缩表|央行降息|央行加息/;
  // 国内快讯噪声：日常操作/个股公告/营销会议/消费轶事/基金流 等与贵金属定价无直接关系的内容。
  // 【C22 大幅收紧】用户要求只展示权威官方/一线机构事件，过滤市井信息：
  //   · 会议/论坛/峰会/发布会（腾讯全球数字生态大会这类营销会议）
  //   · 消费轶事（女子/手镯/金店/金饰/买金 这类「金价下跌，女子花5万买金手镯」）
  //   · 个股/公司业绩（康斯特：公司…同比增长、研报/券商）
  //   · 基金流/理财（固收/公募基金/资金涌入/稳健类）
  //   · 滚动日报/周报/综述（光大期货：有色金属日报 这类无具体事件的栏目）
  // 注意：词要「精确」——/基金/ 会误杀「联邦基金利率」，故只认基金产品专用词；
  //   /同比//环比/ 会误杀「美国CPI同比增长3.5%」，故只认「公司…同比/环比」这类个股业绩句式。
  var CN_NOISE = /地方债|专项债|逆回购|同业存单|中期借贷便利|\bMLF\b|\bSLF\b|中标|缴款|招标|买断式回购|票据发行|净值|份额|申购|赎回|私募|公募|\bETF\b|涨停|跌停|龙虎榜|个股|股东|减持|增持|股东大会|回购股份|新股|\bIPO\b|配股|分红|专利|诉讼|直播|带货|销量|门店|加盟|大会|论坛|峰会|研讨会|博览会|晨会|策略会|发布会|女子|手镯|金店|金饰|项链|珠宝|钻戒|黄金饰品|买金|理财|固收|公募基金|基金产品|资金涌入|稳健类|债基|货基|日报|周报|月报|早报|晚报|晨报|综述|盘点|营销|推广|代言|研报|券商|归母净利润|扣非净利润|每股收益|营业收入|公司[^，。；]{0,15}(增长|营收|净利|业绩|同比|环比)/;

  /** 中文标题清洗：把【标题】改成「标题：」，去掉零散空白 */
  function cleanCnHeadline(s) {
    var t = String(s || "").replace(/<!\[CDATA\[|\]\]>/g, "");
    // 【C22】HTML 实体解码：RSS 标题里的 &#34; / &quot; 不解开会直接显示成乱码
    t = t.replace(/&#34;/g, '"').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(d); })
      .replace(/&amp;/g, "&");
    t = t.replace(/【([^】]{1,40})】/g, "$1：");
    t = t.replace(/\[([^\]]{1,40})\]/g, "$1：");
    t = t.replace(/\s+/g, " ").trim();
    // 【C22】清掉「空格 + 中文标点」（资讯站常见「波澜不惊 ，谷歌财报…」）
    t = t.replace(/\s+([，。；、：？！）】》])/g, "$1");
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

  /** 新浪财经滚动（JSON：result.list[]）→ 标准条目（国内 top 门户源，中文标题天然人话） */
  function parseSina(body) {
    var out = [];
    var j;
    try { j = JSON.parse(String(body || "")); } catch (e) { return out; }
    var list = (j && j.result && (j.result.list || j.result.data || j.result.items)) || [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i] || {};
      var title = cleanCnHeadline(it.title || "");
      if (!title) continue;
      var summary = cleanCnHeadline(it.summary || it.intro || it.wapsummary || "");
      var sec = Number(it.intime || it.ctime || 0);   // 新浪时间戳为秒级
      var date = sec ? isoUtc(sec * 1000) : "";
      out.push({ title: title, desc: summary, link: it.url || it.wapurl || "", date: date, pub: date, kind: "cn" });
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
    impactScope: impactScope,
    impactDegree: impactDegree,
    impactConclusion: impactConclusion,
    impactEffDir: impactEffDir,
    cleanCnHeadline: cleanCnHeadline,
    cnRelevant: cnRelevant,
    parseEastmoney: parseEastmoney,
    parseWallstreetcn: parseWallstreetcn,
    parseSina: parseSina,
    withinHours: withinHours,
    // 【C22】金属差异化相关性 + 市井过滤 + 权威性分级
    copperRelevant: copperRelevant,
    copperRelevance: copperRelevance,
    preciousRelevance: preciousRelevance,
    isMundane: isMundane,
    isQuoteOnly: isQuoteOnly,
    priceSubjectHint: priceSubjectHint,
    isForexOnly: isForexOnly,
    isFragmentZh: isFragmentZh,
    isJunk: isJunk,
    cbSubject: cbSubject,
    authorityTier: authorityTier,
    CN_HIT: CN_HIT,
    CN_NOISE: CN_NOISE,
    MUNDANE: MUNDANE,
    OFF_TOPIC: OFF_TOPIC,
    RULES: RULES,
  };
});
