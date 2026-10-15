/**
 * pages/stats/stats.js —— 统计页逻辑（M3 + M5 完成）
 *
 * 这页两块内容，从上往下：
 *   1. 本月分类占比（环形图 + 图例：每个分类花了多少、占几成）
 *   2. 近 6 个月趋势（柱状图：这个月比上个月是变省了还是变花了）
 *
 * 【数据流，记一遍就不会乱】
 *   云数据库 → db.js（只有它碰数据库）→ 这里算好 → ① setData 给 wxml 画图例
 *                                                  ② 交给 utils/chart.js 画到 canvas 上
 * 为什么要分两路：图例是普通文字列表，wxml 画不了；图本身是像素，只能画到 canvas。
 */

const config = require('../../config.js');
const dateUtil = require('../../utils/date.js');
const db = require('../../utils/db.js');
const chart = require('../../utils/chart.js');

/** 保留两位小数：电脑算 0.1+0.2 会得出 0.30000000000000004，记账软件绝不能出现 */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** 某个分类该用哪种颜色：按分类在列表里的位置取，取完了从头循环 */
function colorOf(name) {
  const list = config.EXPENSE_CATEGORIES;
  const i = list.indexOf(name);
  return config.CHART_COLORS[(i < 0 ? 0 : i) % config.CHART_COLORS.length];
}

Page({

  data: {
    // ---- 饼图 ----
    pieData: [],        // [{ name, value, color, rate }] 图例和扇形都用它
    pieTotal: 0,        // 本月支出合计（画在环中间的数字由 chart.js 自己算，这个给图例用）

    // ---- 趋势图 ----
    months: [],         // 近 6 个月，如 ['2026-05', ... , '2026-10']
    monthLabels: [],    // 给人看的 ['5月', ..., '10月']
    trendData: [],      // [{ label:'5月', value:1200 }, ...]
    trendTotal: 0,      // 近 6 个月合计支出（写在图上面一行）

    // ---- 状态 ----
    loading: true       // 数据没回来之前先显示「加载中」，避免先闪一下大片空白
  },

  onLoad: function () {
    // 先把月份算好：趋势图要用它去数据库查，图例也要显示
    const months = dateUtil.lastNMonths(6);
    this.setData({
      months: months,
      monthLabels: months.map(function (m) { return dateUtil.monthShort(m); })
    });
  },

  /**
   * 页面首次渲染完成（wxml 里的节点都建好了）
   * canvas 必须在「节点建好之后」才能拿到，所以画图入口放这里
   */
  onReady: function () {
    this.render();
  },

  /**
   * 每次切回本页都重画一遍。
   * 为什么不只在 onReady 画：底部 tab 来回切换时，canvas 节点会重建，
   * 不重画的话图会变成一片空白（这个坑很常见，别删这段）
   */
  onShow: function () {
    this.render();
  },

  /**
   * 主流程：取数据 → 算 → 画
   * 为什么两个查询一起跑（Promise.all）：
   * 饼图要「本月」，趋势图要「近 6 个月」，两件事互不依赖，
   * 起两个请求并行，比一个接一个快。
   */
  render: function () {
    const self = this;

    const currentMonth = dateUtil.currentMonth();

    // 【这个 return 不能省】下拉刷新要靠它知道什么时候画完，转圈才会收
    return Promise.all([
      db.getMonthRecords(currentMonth),          // 顺序 0：本月明细 → 算饼图
      db.getRecordsInMonths(this.data.months)    // 顺序 1：近6个月 → 算趋势柱
    ]).then(function (res) {
      const monthRes = res[0] || {};
      const trendRes = res[1] || {};
      const monthList = monthRes.list || [];
      const trendList = trendRes.list || [];

      // 只有「数据没取全」时才提示。
      // 正常情况（一个月几十笔）它不会弹，别平时就 noisy。
      // 为什么要管这一下：取不全还照着算，饼图会少一个分类、趋势柱会莫名矮一截，
      // 界面一点报错都没有 —— 数字错在记账里是不可原谅的。
      if (monthRes.truncated || trendRes.truncated) {
        wx.showToast({ title: '账目太多，只统计了最近 1000 笔', icon: 'none', duration: 2500 });
      }

      const pie = self.buildPie(monthList);
      const trend = self.buildTrend(trendList);

      self.setData({
        loading: false,
        pieData: pie.data,
        pieTotal: pie.total,
        trendData: trend.data,
        trendTotal: trend.total
      });

      self.draw();   // setData 之后数据才到 wxml/内存，这时画才画得出正确的图

    }).catch(function (err) {
      console.error('[枕江逢记账] 统计页取数据失败', err);
      self.setData({ loading: false });
      wx.showToast({ title: '统计没取到，下拉刷新试试', icon: 'none' });
    });
  },

  /**
   * 用户往下拉（stats.json 里开了 enablePullDownRefresh）
   * 和首页同理：成功失败都收转圈，不然一失败就转个没完，像卡死了一样。
   */
  onPullDownRefresh: function () {
    this.render().then(function () {
      wx.stopPullDownRefresh();
    }).catch(function () {
      wx.stopPullDownRefresh();
    });
  },

  /**
   * 算饼图数据：本月支出按分类求和
   *
   * 输入：本月的账目明细
   * 输出：{ data:[{name,value,color,rate}], total }
   * rate 是百分比（带一位小数），图例里要显示「40.5%」
   */
  buildPie: function (list) {
    const totals = {};   // 用对象当「字典」：key 是分类名，value 是合计金额

    list.forEach(function (item) {
      // 收入不进饼图 —— 饼图讲的是「钱花哪儿了」，收入是另一回事
      if (item.type !== 'expense') return;

      const key = item.category || '其他';
      totals[key] = round2((totals[key] || 0) + (Number(item.amount) || 0));
    });

    // 对象没有顺序保证，先转成数组再按金额从大到小排：
    // 大的在上、小的在下，看着才一眼看出「大头是谁」
    const data = Object.keys(totals).map(function (name) {
      return {
        name: name,
        value: totals[name],
        color: colorOf(name),
        rate: 0
      };
    }).sort(function (a, b) { return b.value - a.value; });

    const total = data.reduce(function (s, d) { return s + d.value; }, 0);

    // 百分比：total 为 0 时避免除以 0 得到 NaN
    data.forEach(function (d) {
      d.rate = total > 0 ? Math.round((d.value / total) * 1000) / 10 : 0;
    });

    return { data: data, total: round2(total) };
  },

  /**
   * 算趋势图数据：近 6 个月各自的支出合计
   *
   * 注意月份必须「按固定顺序铺满」：
   * 哪怕某个月一笔账都没有，也要给它留一个空柱子，
   * 不然 6 个月里有 1 月没记账，柱子会往前挤，月份和柱子就对不上了。
   */
  buildTrend: function (list) {
    const self = this;
    // 先把每个月的金额都初始化成 0
    const bucket = {};
    this.data.months.forEach(function (m) { bucket[m] = 0; });

    list.forEach(function (item) {
      if (item.type !== 'expense') return;
      const m = item.month;
      if (bucket[m] === undefined) return;   // 压根不在近 6 个月里，忽略
      bucket[m] = round2(bucket[m] + (Number(item.amount) || 0));
    });

    const data = this.data.months.map(function (m, i) {
      return {
        label: self.data.monthLabels[i],   // ['5月', ..., '10月'] 对应着用
        value: bucket[m]
      };
    });

    const total = data.reduce(function (s, d) { return s + d.value; }, 0);
    return { data: data, total: round2(total) };
  },

  /**
   * 真正往 canvas 上画
   * 两步：先取到画笔，再把图交给 chart.js。
   * 取不到画笔（比如节点还没建好）就直接返回，不报错，等下次 onShow 再画。
   */
  draw: function () {
    const self = this;

    // 取环形图那一块
    chart.pickCanvas(this, 'pieCanvas').then(function (c) {
      if (c) chart.drawDonut(c, self.data.pieData);
    });

    // 取趋势图那一块
    chart.pickCanvas(this, 'trendCanvas').then(function (c) {
      if (c) chart.drawBars(c, self.data.trendData, { color: config.COLORS.primary });
    });
  }
});
