// 一次性安装脚本：把 _gist_dev.js 定稿的「英文标题 → 中文概况」搬进两端正式代码
// 用脚本而不是手改，保证 generate.js 与云函数 generate-core.js 里的这段完全一致
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEV = path.join(ROOT, "tools", "_gist_dev.js");
const TARGETS = [
  path.join(ROOT, "generate.js"),
  path.resolve(ROOT, "..", "metals-miniprogram", "cloudfunctions", "metals-data", "src", "generate-core.js"),
];

const dev = fs.readFileSync(DEV, "utf8");
const from = dev.indexOf("var MONTHS = {");
const to = dev.indexOf("// ---------------- 语料迭代 ----------------");
if (from < 0 || to < 0) throw new Error("开发脚本结构变了，截取区间没命中");
let block = dev.slice(from, to).replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "\n");
// 去掉调试开关（生产代码不需要）
block = block
  .replace(/  if \(process\.env\.GIST_DEBUG\) \{\n[\s\S]*?\n  \}\n/, "")
  .replace(/\n{3,}/g, "\n\n");

const NEW_SUMMARY = [
  "// 英文源：先讲清「发生了什么」，再给对贵金属的结论；中文源：沿用原文概述",
  "function zhSummary(t, desc, tags, cat) {",
  "  const dir = impactOf(t);",
  "  const dirZh = dir === \"up\" ? \"利多，价格有望获得支撑\" : dir === \"down\" ? \"利空，价格面临压力\" : \"影响偏中性，方向待确认\";",
  "  const detail = stripText(desc || \"\");",
  "  if (/[\\u4e00-\\u9fa5]/.test(detail)) {",
  "    // 中文源：原文概述（截断到 90 字并去掉尾标点）",
  "    return detail.slice(0, 90).replace(/[，。；、]+$/, \"\") + \"。对贵金属影响：\" + dirZh;",
  "  }",
  "  // 分类在卡片顶行已展示、关键词由顶部标签 chips 展示，摘要里都不再重复",
  "  return (zhGist(t) || zhGistFallback(tags, cat)) + \"。对贵金属影响：\" + dirZh;",
  "}",
  "// 概况译不出来时（生僻标题）的兜底：至少告诉用户这条说的是哪个方向的事",
  "function zhGistFallback(tags, cat) {",
  "  const kw = ((tags || []).filter((x) => x !== \"走强\" && x !== \"走弱\")).slice(0, 3);",
  "  return \"外媒报道，\" + (kw.length ? kw.join(\"、\") : cat || \"国际财经\") + \"方面出现新动向\";",
  "}",
  "",
].join("\n");

// 两个目标文件都是 CRLF 行尾，插入前统一转换，避免混入 LF
const payload = (block + NEW_SUMMARY).replace(/\r?\n/g, "\r\n");
// 首次安装：替换旧 zhSummary；再次安装：整段替换上一版
const OLD_RE = /function zhSummary\(t, desc, tags, cat\) \{[\s\S]*?\r?\n\}\r?\n/;
const INSTALLED_RE = /var MONTHS = \{[\s\S]*?\r?\nfunction zhGistFallback\(tags, cat\) \{\r?\n[\s\S]*?\r?\n\}\r?\n/;

for (const target of TARGETS) {
  let s = fs.readFileSync(target, "utf8");
  if (OLD_RE.test(s)) s = s.replace(OLD_RE, payload);
  else if (INSTALLED_RE.test(s)) s = s.replace(INSTALLED_RE, payload);
  else throw new Error("未命中可替换区间: " + target);
  fs.writeFileSync(target, s, "utf8");
  console.log("已写入 " + path.relative(path.resolve(ROOT, ".."), target) + " (+" + payload.length + " 字符)");
}
// 校验两端一致
const a = fs.readFileSync(TARGETS[0], "utf8");
const b = fs.readFileSync(TARGETS[1], "utf8");
const ai = a.indexOf("var MONTHS = {");
const bi = b.indexOf("var MONTHS = {");
const segA = a.slice(ai, ai + payload.length);
const segB = b.slice(bi, bi + payload.length);
console.log("CRLF 混用检查：" + ((segA.match(/\r\n/g) || []).length + "/" + ((segA.match(/[^\r]\n/g) || []).length)));
console.log(segA === segB ? "✓ 两端代码段一致" : "✗ 两端代码段不一致");
if (segA !== segB) process.exit(1);
