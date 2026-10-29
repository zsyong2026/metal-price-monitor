// 临时开发脚本：英文标题 → 中文事件概况（规则化词典），拿真实语料迭代，定稿后搬进 generate.js
"use strict";

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
  if (process.env.GIST_DEBUG) {
    console.log("  [dbg] " + JSON.stringify(text) + " total=" + zhTranslate.total + " missing=" + zhTranslate.missing);
  }
  // 3) 质量门禁：没译出中文 / 太短 / 译不出来的词太多 → 判定不可用，交给调用方兜底
  if (!/[\u4e00-\u9fa5]/.test(text)) return "";
  var cn = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (cn < 6) return "";
  if (zhTranslate.total >= 4 && zhTranslate.missing / zhTranslate.total > 0.45) return "";
  return text;
}

// ---------------- 语料迭代 ----------------
var CASES = [
  "Honda warns 50% Canada auto tariffs would be catastrophic for industry",
  "Housing is flashing warning signs just as the Fed weighs more interest rate hikes",
  "UK inflation jumps to 3.5% — cementing rate hike expectations",
  "Goldman Sachs, JPMorgan and Morgan Stanley are dominating the AI stock boom. Here's their ",
  "Analysis: Everyone expects the Fed to hold rates in October. Kevin Warsh could surprise us",
  "AI stocks plunge. Inflation heats up. Where we're still finding opportunities",
  "Economists: Hot PPI shows Fed's work is not done",
  "How high inflation became a 'fact of life' in the U.S.",
  "'Godzilla El Niño' is wreaking havoc with Philippine central bank's inflation forecasts",
  "IMF warns bond yields could see a 'disorderly' spike as debt, inflation risks worsen",
  "India’s retail inflation jumps to 5.54% in September, above estimates",
  "Americans' debt problems are flashing a warning not seen since the Great Recession",
  "Inflation on many everyday items was entirely due to tariffs, NY Fed says",
  "Inflation fears on the rise as one-year outlook in Fed survey hits highest level since May",
  "Arabica Coffee Prices Hit Record on U.S., Colombia Tariff Spat",
  "Comex Gold, Silver Settle Lower",
  "Russia's Crude Exports Fairly Stable Despite U.S. Sanctions, Goldman Says",
  "Trump Says Colombia Will Accept Deportees, Ending Tariff Standoff",
  "Fed rate hikes are coming, but not this week: CNBC survey",
];
if (require.main === module) {
  CASES.forEach(function (c) {
    console.log("EN : " + c);
    console.log("ZH : " + (zhGist(c) || "（空）"));
    console.log("");
  });
}

module.exports = { zhGist, zhTranslate };
