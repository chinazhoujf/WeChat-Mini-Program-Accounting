/**
 * utils/date.js —— 日期工具箱
 *
 * 为什么要单独一个文件：小程序的日期处理和我们平时在电脑上想的不太一样，
 * 而且「这个月」「近 6 个月」是记账应用算钱的核心。集中放一个文件，以后要改只改这一处。
 *
 * 我们只认一种格式：'2026-10-03'（年月日之间用横杠）
 * 因为云数据库查「这个月」最简单的办法就是看字符串开头是不是 '2026-10'，
 * 字符串比较比日期计算简单一百倍，也不容易出错。
 */

/**
 * 补零：1 变成 '01'，10 还是 '10'
 * 作用：让 '2026-1-3' 这种丑陋格式变成 '2026-01-03'，格式统一才好用
 */
function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

/**
 * 今天的日期，返回 '2026-10-03' 这种格式
 */
function today() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/**
 * 昨天的日期，返回 '2026-10-02'
 * 首页分组标题要用（「今天 / 昨天 / 10月01日」），单独写成一个函数
 * 免得到处算「new Date() 减一天」，那种写法在月末（1 号减 1 天会跳到上个月 31 号）特别容易错。
 */
function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/**
 * 当前是哪个月，返回 '2026-10'（注意：没有日）
 * 记账的首页「本月支出」就是拿它去数据库查的
 */
function currentMonth() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
}

/**
 * 最近 n 个月的月份列表（从旧到新）
 * 例：lastNMonths(6) → ['2026-05','2026-06','2026-07','2026-08','2026-09','2026-10']
 * 「近 6 个月趋势图」就靠它去数据库挨个拉数据
 */
function lastNMonths(n) {
  const list = [];
  const d = new Date();
  d.setDate(1); // 把日号归到 1 号，避免 31 号减一个月算出 0 号这种坑

  // 【基准点必须先定死，再循环】
  // 以前的写法是每圈都拿「已经被上一圈改过的 d」继续往前减，
  // 结果越减越偏：2026-10 起步会算出
  // ['2026-05','2026-01','2025-10','2025-08','2025-07','2025-07'] ——
  // 本月（2026-10）根本不在名单里，趋势图因此全是空柱、合计 ¥0。
  // 现在改成：基准年月先存下来，每圈都从基准往回推 i 个月，互不影响。
  // new Date(年, 月-i, 1) 的「月-i」是负数也没关系，Date 会自动往上年借位（跨年靠它兜）。
  const baseY = d.getFullYear();
  const baseM = d.getMonth();          // 0~11，0 代表一月
  for (let i = n - 1; i >= 0; i--) {
    const t = new Date(baseY, baseM - i, 1);
    list.push(t.getFullYear() + '-' + pad2(t.getMonth() + 1));
  }
  return list;
}

/**
 * 把 '2026-10' 显示成人看的：'10月'
 * 首页顶部那个「10月」就是它
 */
function monthShort(monthStr) {
  return monthStr.split('-')[1] + '月';
}

/**
 * 把金额数字变成两部分：整数部分和小数部分
 * 例：1286.5 → 整数 '1286'，小数 '.50'
 * 为什么要这么做：页面上「¥」符号和「1286」的字号不一样大，
 * 需要拆开分别设置样式。这是记账类 App 的通用做法。
 */
function splitAmount(amount) {
  const fixed = Number(amount).toFixed(2); // 强制保留两位小数：18 → '18.00'
  const parts = fixed.split('.');
  return { intPart: parts[0], decPart: '.' + parts[1] };
}

module.exports = {
  pad2, today, yesterday, currentMonth, lastNMonths, monthShort, splitAmount
};
