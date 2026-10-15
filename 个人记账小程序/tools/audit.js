/**
 * tools/audit.js —— 提审前的代码体检脚本（辅助工具，不是小程序代码，不用上传）
 *
 * 只查两类「点了没反应 / 显示不出来」的缺陷，这两类正是审核常见的拒审理由：
 *   1. 死链：wxml 里 bindtap="xxx"，但 js 里根本没这个方法 → 点下去没反应
 *   2. 空值：wxml 里用了 {{xxx}}，但 js 的 data 从来没给过这个值 → 那块永远是空的
 *
 * 用法：在项目根目录（D:\个人记账小程序）下执行  node tools/audit.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..'); // 脚本在 tools/ 下，项目根在上一级
const MP = path.join(ROOT, 'miniprogram');
const APP = path.join(MP, 'app.json');

if (!fs.existsSync(APP)) {
  console.error('找不到 miniprogram/app.json，请在项目根目录运行：node tools/audit.js');
  process.exit(1);
}

const app = JSON.parse(fs.readFileSync(APP, 'utf8'));
const pages = app.pages || [];

// wxml 表达式里的语法词，不是页面数据
const BUILTIN = [
  'wx', 'if', 'else', 'for', 'forItem', 'forIndex', 'key', 'true', 'false',
  'null', 'undefined', 'Math', 'Number', 'String', 'Object', 'Array', 'Date', 'JSON'
];

let issues = [];
let eventTotal = 0;
let varTotal = 0;

pages.forEach(function (pagePath) {
  const wxmlFile = path.join(MP, pagePath + '.wxml');
  const jsFile = path.join(MP, pagePath + '.js');
  if (!fs.existsSync(wxmlFile) || !fs.existsSync(jsFile)) return;

  const wxml = fs.readFileSync(wxmlFile, 'utf8');
  const js = fs.readFileSync(jsFile, 'utf8');

  // ---------- 0) 统计 wx:for-item / wx:for-index 声明的循环变量 ----------
  // 这些变量是页面自己临时生成的，不需要在 data 里声明
  const loopNames = ['item', 'index'];
  [...wxml.matchAll(/wx:for-(?:item|index)="([A-Za-z0-9_$]+)"/g)].forEach(function (m) {
    loopNames.push(m[1]);
  });

  // ---------- 1) 事件死链检查 ----------
  // 小程序里常见写法：bindtap="xx" / bind:tap="xx" / catchtap="xx" / bindchange="xx"
  const events = [...new Set(
    [...wxml.matchAll(/(?:bind|capture-bind|mut-bind|capture-catch|catch)[A-Za-z0-9_]*\s*=\s*"([A-Za-z0-9_$]+)"/g)]
      .map(m => m[1])
  )];

  events.forEach(function (ev) {
    eventTotal++;
    // 在 js 里找：方法名后面跟冒号或左括号，例如  goDetail: function / goDetail () {
    const re = new RegExp('[^A-Za-z0-9_$]' + ev.replace(/\$/g, '\\$') + '\\s*[:({]', 'm');
    if (!re.test(js)) {
      issues.push('[死链] ' + pagePath + '.wxml 绑定了 ' + ev + '，但 js 里没有这个方法 → 点了没反应');
    }
  });

  // ---------- 2) data 字段声明检查 ----------
  // 取 Page({ data: { ... } }) 的花括号内容
  const dm = js.match(/data:\s*\{([\s\S]*?)\n {2}\}/);
  const dataBody = dm ? dm[1] : '';
  const dataKeys = [...new Set(
    [...dataBody.matchAll(/(?:^|\n)\s*([A-Za-z][A-Za-z0-9_$]*)\s*:/g)].map(m => m[1])
  )];

  // 只看 {{ }} 里的内容；同时把里面的字符串字面量 '...' 去掉，
  // 免得把 class="progress-bar {{overdue ? 'progress-overdue' : ''}}" 里的 progress 当变量
  const exprs = [...wxml.matchAll(/\{\{([\s\S]*?)\}\}/g)].map(m => m[1]);
  const tokens = new Set();
  exprs.forEach(function (expr) {
    const noString = expr.replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ');
    [...noString.matchAll(/\b([A-Za-z][A-Za-z0-9_$]*)\b/g)].forEach(function (t) {
      tokens.add(t[1]);
    });
  });

  // 「谁.字段」里的字段名要跳过：它们属于某个对象（多半是 wx:for 循环出来的每一条），
  // 由 js 在运行时组装，不需要在 data 里预声明。
  // 例：group.label / item.category / group.items.length
  const childFields = new Set();
  [...wxml.matchAll(/\b[A-Za-z][A-Za-z0-9_$]*\.([A-Za-z][A-Za-z0-9_$]*)/g)]
    .forEach(function (m) { childFields.add(m[1]); });

  tokens.forEach(function (t) {
    if (BUILTIN.indexOf(t) >= 0) return;
    if (loopNames.indexOf(t) >= 0) return;
    if (childFields.has(t)) return;
    varTotal++;
    // 允许链式取值，比如 dayGroups 里的 group.dayTotal —— 只要前缀声明过就算过
    const isPrefix = dataKeys.some(function (k) { return t.indexOf(k + '.') === 0; });
    if (dataKeys.indexOf(t) >= 0 || isPrefix) return;
    issues.push('[空值] ' + pagePath + '.wxml 用到 ' + t +
      '，但 data 里没声明 → 这块会显示不出来');
  });
});

console.log('检查页面数：' + pages.length);
console.log('检查事件数：' + eventTotal + '，检查取值变量：' + varTotal);
console.log('----------------------------------------');
if (issues.length === 0) {
  console.log('✔ 未发现死链，也未发现未声明变量');
} else {
  console.log('发现 ' + issues.length + ' 处：');
  issues.forEach(function (i) { console.log('  ' + i); });
}
