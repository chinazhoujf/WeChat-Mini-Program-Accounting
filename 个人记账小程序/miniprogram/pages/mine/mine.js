/**
 * pages/mine/mine.js —— 我的页逻辑（M6）
 *
 * 这页在阶段二被定为「合规硬要求」：
 * 个人主体小程序必须给用户一个「查看隐私协议 / 撤回同意」的入口，
 * 否则审核会被以「未提供撤回同意路径」驳回。所以这一页不能砍。
 *
 * M6 把三个占位弹窗换成了真功能：
 *   隐私协议      → 打开真正的协议页 pages/privacy/privacy
 *   撤回同意      → 真删云端 + 本机全部数据（不可逆，走两道确认）
 *   清空全部账目  → 真删云端 + 本机账目（预算设置保留）
 */

const config = require('../../config.js');
const db = require('../../utils/db.js');

Page({

  data: {
    budget: config.DEFAULT_BUDGET,   // 本月预算
    recordCount: 0,                  // 一共记了多少笔（从云端数，不是本机数）
    storageText: '',                 // 存储模式文字：云开发正常 / 本机暂存 / 云连不上
    cloudState: ''                   // 给样式用的状态：cloud / error / local
  },

  onLoad: function () {
    this.setData({ budget: db.getBudget() });
    this.refreshMode();
  },

  /**
   * 每次切到「我的」这个 tab 都重新算一遍
   * 为什么放 onShow：从隐私协议、详情页切回来时 onLoad 早跑过了，
   * 不放这里的话删完数据回来条数还是旧的。
   */
  onShow: function () {
    this.refreshMode();
  },

  /**
   * 读存储模式 + 账目条数
   *
   * 【为什么这里要把「云连不上」单独报出来】
   * 云环境有免费额度，但官方规则是「小程序发布上线后第 15 天到期」——
   * 上线后忘了续费，数据库就取不回来，界面表现是「一笔账都读不到」。
   * 如果只显示「存储方式：云开发」，你根本发现不了它已经病了。
   */
  refreshMode: function () {
    const self = this;

    const state = db.getCloudState();
    // 三种状态给三种人话文案，同时把状态本身交给 wxml 决定用什么颜色
    const textMap = {
      cloud: '云开发正常',
      error: '云连不上，点我看原因',
      local: '本机暂存'
    };

    this.setData({
      storageText: textMap[state] || '云开发正常',
      cloudState: state
    });

    db.countRecords().then(function (res) {
      self.setData({ recordCount: res.count || 0 });
    });
  },

  /**
   * 点「存储方式」→ 说明当前状态
   * 正常时也允许点，因为顺带能告诉你「上线后记得续费」这件容易被忽略的事
   */
  onTapCloudState: function () {
    const state = this.data.cloudState;

    if (state === 'error') {
      wx.showModal({
        title: '云连不上',
        content: '最可能是云开发环境到期了。\n\n'
          + '云开发免费额度在小程序「发布上线后第 15 天」到期（官方规则），'
          + '到期后数据库取不回来。\n\n'
          + '去「云开发」控制台看环境状态，续费后按 Ctrl+B 重新编译就恢复了。',
        showCancel: false,
        confirmText: '知道了'
      });
      return;
    }

    wx.showModal({
      title: state === 'local' ? '当前是本机暂存' : '云开发正常运行',
      content: state === 'local'
        ? '数据只存在这台手机/这台电脑上，没进云端。\n开发阶段常见，开通云开发后会自动搬上去。'
        : '数据存在微信云端，换手机、清缓存都还在，账单只有你自己能看到。\n\n'
          + '提醒：云开发有免费额度，小程序上线后第 15 天环境到期，'
          + '到时记得去云开发控制台看一眼是否需要续费，否则会取不到数据（记账会自动转本机暂存，不会丢）。',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  /**
   * 点「设置月预算」→ 弹个输入框让你填金额
   * showModal 的 editable 属性就是「弹一个带输入框的确认框」，省得我们自己写页面
   */
  editBudget: function () {
    const self = this;
    wx.showModal({
      title: '设置月预算',
      content: '填一个数字，比如 2000',
      editable: true,          // 弹输入框
      placeholderText: '2000',
      confirmText: '保存',
      success: function (res) {
        if (!res.confirm) return;              // 点了取消就直接结束

        const input = (res.content || '').trim();
        const value = Number(input);

        // 校验：必须是正数，且别填个天文数字把自己卡死
        if (!value || isNaN(value) || value <= 0) {
          wx.showToast({ title: '填个正的数字', icon: 'none' });
          return;
        }
        if (value > 9999999) {
          wx.showToast({ title: '太大了，检查下？', icon: 'none' });
          return;
        }

        self.setData({ budget: value });
        db.setBudget(value);   // 存下来，回首页 onShow 会重新读到

        wx.showToast({ title: '预算已保存', icon: 'success', duration: 1200 });
        // 存完顺手回首页，让你立刻看到进度条跟着变
        setTimeout(function () {
          wx.switchTab({ url: '/pages/index/index' });   // switchTab 只能回 tab 页面
        }, 1200);
      }
    });
  },

  /**
   * 点「隐私协议」→ 打开协议正文页
   */
  goPrivacy: function () {
    wx.navigateTo({ url: '/pages/privacy/privacy' });
  },

  /**
   * 点「撤回同意并删除我的数据」
   *
   * 【和「清空全部账目」的区别，别搞混】
   *   清空全部账目      → 只删账目，你的预算设置留着
   *   撤回同意并删除数据 → 账目 + 预算设置全删，等于从零开始
   * 撤回同意是隐私协议里的「撤回授权」，删得比清空更彻底，所以要多一道确认。
   */
  withdrawConsent: function () {
    wx.showModal({
      title: '撤回同意并删除全部数据',
      content: '这会删掉你所有账目和预算设置，且无法恢复。\n之后需要重新记账才能继续。确定吗？',
      confirmText: '确认删除',
      confirmColor: '#E64340',
      success: function (res) {
        if (!res.confirm) return;

        // 第二道确认：危险操作点两下才算数，防止手滑
        wx.showModal({
          title: '最后确认',
          content: '真的要删掉全部数据吗？删完数据就没了。',
          confirmText: '我确定',
          confirmColor: '#E64340',
          success: function (res2) {
            if (!res2.confirm) return;

            // 云上 + 本机一起清；本机那份 deleteAllRecords 已经顺手清了，这里只补预算
            db.deleteAllRecords().then(function (r) {
              wx.removeStorageSync('zjf_budget');   // 清掉预算设置
              wx.showToast({ title: '数据已全部删除', icon: 'success', duration: 1500 });
              setTimeout(function () {
                wx.switchTab({ url: '/pages/index/index' });
              }, 1500);
            }).catch(function (err) {
              console.error('[枕江逢记账] 撤回同意删除失败', err);
              wx.showToast({ title: '没删干净，再试一次', icon: 'none' });
            });
          }
        });
      }
    });
  },

  /**
   * 点「清空全部账目」
   * 只删账目，预算设置留着（预算是"偏好"，不是账目数据）
   */
  clearAll: function () {
    const self = this;
    wx.showModal({
      title: '清空全部账目？',
      content: '你记的所有账目都会被删除，找不回来。\n预算设置会保留。',
      confirmText: '确认删除',
      confirmColor: '#E64340',
      success: function (res) {
        if (!res.confirm) return;

        db.deleteAllRecords().then(function (r) {
          const n = r.deleted || 0;
          wx.showToast({ title: '已清空 ' + n + ' 笔', icon: 'success', duration: 1500 });
          self.setData({ recordCount: 0 });
          setTimeout(function () {
            wx.switchTab({ url: '/pages/index/index' });
          }, 1500);
        }).catch(function (err) {
          console.error('[枕江逢记账] 清空账目失败', err);
          wx.showToast({ title: '没删掉，再试一次', icon: 'none' });
        });
      }
    });
  }
});
