/**
 * pages/index/index.js —— 首页逻辑
 *
 * 首页从上往下是：月份 + 预算 → 本月支出大数字 → 预算进度条 → 按天明细 → 右下角 ＋ 号
 *
 * M2 完成的事：数据从云里真读真写，记完一笔回来数字立刻变。
 */

const config = require('../../config.js');
const dateUtil = require('../../utils/date.js');
const db = require('../../utils/db.js');

/**
 * 保留两位小数的工具函数
 * 电脑做小数加法会算错（0.1+0.2=0.30000000000000004），记账软件必须避免
 */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

Page({

  data: {
    currentMonth: '',      // 当前月份，如 '2026-10'
    currentMonthShort: '', // 给人看的月份，如 '10月'
    budget: 0,             // 本月预算（从「我的」页读，没设过就用 config 默认值）

    monthExpenseInt: '0',  // 本月支出·整数部分
    monthExpenseDec: '.00',// 本月支出·小数部分（拆开是为了让「¥」和整数大、小数小）
    remainInt: '0',        // 还剩 / 已超支 的整数部分
    remainDec: '.00',      // 小数部分
    overdue: false,        // 是否超支（true 时进度条和文字变红）
    progressWidth: 0,      // 进度条宽度百分比 0~100

    dayGroups: [],         // 按天分组的明细，结构见下面 buildGroups 的注释
    hasRecord: false,      // 本月有没有任何账（没有就显示空态引导）
    loading: true,         // 是否还在加载（加载时先不显示内容，避免闪一下 0）

    // 当前是不是「本机暂存」模式。true 时顶部显示一条黄底提示条。
    // 为什么必须给界面上一个提示：以前只有调试器里有日志，
    // 不开调试器就完全看不出数据存哪了，很容易误以为「云没通就是坏了」。
    isLocalMode: false,    // true = 云没通，顶部显示黄色提示条
    localCount: 0,         // 本机暂存里压着几条账（云通后会被自动搬走）

    // 云「配了但连不上」（环境过期未续费 / 集合没建 / 权限不对）时显示红条。
    // 为什么不能让它显示成空态「这个月还没有记账」：
    // 那会让你以为是自己没记上，实际是云端取不回来 —— 这种误判最难查。
    cloudError: false,

    // 账目「取不完」时的黄字提示（正常用一辈子都碰不到，见 utils/db.js 的 CLOUD_MAX_ROWS）
    // 为什么留这个口子：宁可让它显示「只显示了最近 1000 笔」，
    // 也不能让总额悄悄少算一块钱都不知道 —— 记账软件里钱算少了是最没法接受的事。
    dataWarning: ''
  },

  onLoad: function () {
    const month = dateUtil.currentMonth();
    // 预算先取一次「我的」页设的值；以后在那边改了，回来 onShow 还会再取一次
    this.setData({
      currentMonth: month,
      currentMonthShort: dateUtil.monthShort(month),
      budget: db.getBudget()
    });
    // 【注意】这里不再调 this.loadData()。
    // 页面生命周期固定是 onLoad → onShow，onShow 里本来就会调 loadData，
    // 两个都调 = 首次打开并发两条一模一样的云查询，白白翻倍请求量，
    // 还让「加载中」转圈多了一次挂起的机会（真机上"加载完了还在转"就是它参与的）。
  },

  /**
   * 每次「显示」都重新取数据
   * 为什么不放 onLoad：从「记一笔」返回时是走 onShow 的，
   * 不放这里的话，你刚记的那笔会「消失」，要手动下拉刷新才看得到。
   */
  onShow: function () {
    this.refreshStorageMode();
    this.loadData();
  },

  /**
   * 刷新「本机暂存 / 云开发」两种模式的提示条
   * 顺便查一下本地还压着几条没进云 —— 打开云之后第一条账目就靠它捡回来
   */
  refreshStorageMode: function () {
    const cloud = db.isCloudReady();
    // 云没通，才需要报出本地压着几条；云通了本地已经被清空，没必要报
    const local = cloud ? [] : db.localRecords();
    this.setData({
      isLocalMode: !cloud,
      localCount: local.length
    });
  },

  /**
   * 点那条黄提示条 → 弹出「怎么开云」的三步说明
   * 写成一个函数是因为这段说明以后可能改，放 js 里比塞进 wxml 好改
   */
  onTapCloudWarn: function () {
    wx.showModal({
      title: '数据目前只存在本机',
      content: '第 1 步：在微信开发者工具「工具栏左侧」点「云开发」按钮（云朵图标）。\n'
        + '第 2 步：如果按钮是灰的，说明导入项目时「后端服务」选了「不使用云服务」，'
        + '需要重新导入一次，那一栏改选「微信云开发」。\n'
        + '第 3 步：按钮变彩色后按 Ctrl+B 重新编译，数据才会进云。',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  /**
   * 点云故障红条 → 告诉你具体怎么办
   *
   * 三种常见原因，逐个给你排查方向（不看 errCode 猜，直接把可能性列全，
   * 因为你既不是开发者也看不懂错误码，列全比猜准更实用）：
   */
  onTapCloudError: function () {
    wx.showModal({
      title: '云暂时连不上',
      content: '好消息：记账功能还能用，数据先存本机，不会丢。\n\n'
        + '最可能的原因是云环境到期了：'
        + '云开发免费额度在小程序「发布上线后第 15 天」到期（官方规则），'
        + '到期后数据库就取不回来。\n\n'
        + '怎么办：开发者工具或 mp 后台进「云开发」控制台 → 选到「设置/账单」，'
        + '看环境是否标为「已到期」，续费后按 Ctrl+B 重新编译即可恢复。',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  /**
   * 点「重试」：强制重新探一次云（跳过 60 秒缓存）
   */
  retryCloud: function () {
    wx.showLoading({ title: '正在检查…', mask: true });
    const self = this;
    db.probeCloud(true).then(function (probe) {
      wx.hideLoading();
      if (probe.ok) {
        self.setData({ cloudError: false });
        wx.showToast({ title: '云已恢复', icon: 'success' });
        self.loadData();
      } else {
        wx.showToast({ title: '还是连不上，点上方红条看原因', icon: 'none' });
      }
    });
  },

  /**
   * 拉本月账目 → 算出首页要显示的所有数字
   *
   * 【注意这个 return】
   * 它把这一串 Promise 丢回来了，外面「下拉刷新」要靠它知道什么时候算完。
   * 不 return 的话，下拉刷新的转圈会一直转下去，手机上就像卡死了。
   */
  loadData: function () {
    const month = this.data.currentMonth;
    const self = this;

    this.setData({ loading: true });

    // 【超时兜底】云请求在真机上可能永远不返回（弱网 / 切基站 / 云冷启动），
    // Promise 永远悬着的话，「加载中…」就永远收不回去 —— 你截图里那个钉死的
    // 加载框就是它。15 秒还没回来就当失败处理，走下面的 catch 收掉转圈。
    let timer = null;
    const withTimeout = Promise.race([
      db.getMonthRecords(month),
      new Promise(function (resolve, reject) {
        timer = setTimeout(function () {
          reject({ timeout: true });   // 没有cloudUnavailable字段 → 走通用失败提示
        }, 15000);
      })
    ]);

    return withTimeout.then(function (res) {
      clearTimeout(timer);             // 正常回来了，把闹钟拆掉，别白等15秒

      const list = res.list || [];
      // 这个月记了上千笔、超过了单次读取上限时才会有值（平时是空字符串，界面上什么都不显示）
      const warn = res.truncated ? '这个月账目超过 1000 笔，只显示了最近 1000 笔' : '';

      // ---- 第 1 步：算本月支出总额 ----
      // 注意那个 toFixed(2)：电脑算 0.1 + 0.2 会得出 0.30000000000000004 这种数，
      // 记钱的地方绝不能出现这种数字，所以每一步加法都压两位小数。
      let expense = 0;
      list.forEach(function (item) {
        if (item.type === 'expense') {
          expense = round2(expense + (Number(item.amount) || 0));
        }
      });

      const budget = db.getBudget();

      // ---- 第 2 步：算预算进度 ----
      // 除零保护：预算是 0 的话进度条会炸成 NaN，这里直接按 0 处理
      let pct = budget > 0 ? (expense / budget) * 100 : 0;
      const overdue = expense > budget && budget > 0;
      // 进度条宽度最多 100%，超支的部分靠变红来提醒，不然条子会顶出卡片
      if (pct > 100) pct = 100;

      // ---- 第 3 步：把金额拆成整数/小数两段（为了大小字号排版）----
      const e = dateUtil.splitAmount(expense.toFixed(2));
      const remain = budget - expense;
      const r = dateUtil.splitAmount(Math.abs(remain).toFixed(2));

      // ---- 第 4 步：按天分组 ----
      const groups = self.buildGroups(list);

      self.setData({
        loading: false,
        cloudError: false,          // 能走到这一步说明云是通的
        dataWarning: warn,
        budget: budget,
        monthExpenseInt: e.intPart,
        monthExpenseDec: e.decPart,
        remainInt: r.intPart,
        remainDec: r.decPart,
        overdue: overdue,
        progressWidth: Math.round(pct),
        dayGroups: groups,
        hasRecord: list.length > 0
      });

    }).catch(function (err) {
      // 读失败也不能白屏，给个能继续操作的界面
      clearTimeout(timer);             // 超时/失败同样把闹钟拆掉

      console.error('[枕江逢记账] 首页取数据失败', err);

      // 云连不上 → 显示红条 + 重试按钮，并且**不要**显示空态，
      // 否则你会以为是自己没记上账（这是最要命的误判）
      if (err && err.cloudUnavailable) {
        self.setData({ loading: false, cloudError: true, dataWarning: '' });
        return;
      }

      self.setData({ loading: false, cloudError: false, dataWarning: '' });
      wx.showToast({ title: '没取到数据，下拉刷新试试', icon: 'none' });
    });
  },

  /**
   * 用户往下拉（页面在 index.json 里开了 enablePullDownRefresh）
   *
   * 【为什么必须有它】
   * 以前代码里存着一句提示「没取到数据，下拉刷新试试」，
   * 但下拉刷新根本没开开关、也没有这个处理函数 ——
   * 用户照着提示往下拉，屏幕上一点反应都没有，只会觉得这 App 坏了。
   * 界面上说的话，必须真的做得到，这就是补它的原因。
   */
  onPullDownRefresh: function () {
    const self = this;

    // 成功、失败都要收转圈：只收成功那一半的话，
    // 一旦取数失败（比如云刚好抽风），那个小圈会永远转下去，
    // 用户除了强退没别的办法 —— 下拉刷新最经典的坑就是这个。
    this.loadData().then(function () {
      wx.stopPullDownRefresh();
    }).catch(function () {
      wx.stopPullDownRefresh();
    });
  },

  /**
   * 把账目列表按日期分组
   * 输入：按日期倒序的一维列表
   * 输出：[{ date:'2026-10-03', label:'今天', items:[...], dayTotal: 58.5 }, ...]
   *
   * 为什么要在前端分组：数据库的排序只保证顺序，不负责「显示成几组」，
   * 这种纯展示的整理放在页面里最省事，也方便以后加「展开/收起」。
   */
  buildGroups: function (list) {
    const today = dateUtil.today();
    const groups = [];

    list.forEach(function (item) {
      // 第一笔，或者日期和上一笔不同 → 开一个新组
      if (groups.length === 0 || groups[groups.length - 1].date !== item.date) {
        groups.push({ date: item.date, label: '', items: [], dayTotal: 0 });
      }
      const g = groups[groups.length - 1];
      g.items.push(item);

      // 每天小计：只加支出（收入单独看，以后上「月结余」才需要）
      const amount = Number(item.amount) || 0;
      if (item.type === 'expense') {
        g.dayTotal = round2(g.dayTotal + amount);
      }
    });

    // 补上「今天 / 昨天」这类人能看懂的标题
    groups.forEach(function (g) {
      if (g.date === today) g.label = '今天';
      else if (g.date === dateUtil.yesterday()) g.label = '昨天';
      else g.label = g.date.slice(5).replace('-', '月') + '日';
    });

    return groups;
  },

  /**
   * 点 ＋ 号 → 去「记一笔」
   * navigateTo 会保留当前页（左上角有返回箭头），不是直接盖掉
   */
  goRecord: function () {
    wx.navigateTo({
      url: '/pages/record/record'
    });
  },

  /**
   * 点某一笔明细 → 去详情页看/改/删
   * 带 id 过去，详情页靠它去云上找这一条
   */
  goDetail: function (e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;   // 没拿到编号就别跳，跳过去也是个空页
    wx.navigateTo({
      url: '/pages/detail/detail?id=' + id
    });
  }
});
