/**
 * pages/detail/detail.js —— 「这一笔」的详情页
 *
 * 从首页明细点某一笔进来（首页那条记录带上了它的编号）。
 * 这页只干三件事：看清楚 → 去改 → 删掉。
 *
 * 为什么不做成「编辑页」而不是「详情页 + 编辑页」：
 *   改起来更少代码，而且用户点进去看到的就是这笔账的完整信息，
 *   不会像某些 App 那样点一下就跳到空白表单，很懵。
 */

const db = require('../../utils/db.js');

Page({

  data: {
    id: '',            // 这笔账在数据库里的编号
    rec: null,         // 这笔账的内容，结构：{ type, category, amount, note, date, month }
    loading: true      // 还在取数据时先显示「加载中」，避免闪一下空白
  },

  onLoad: function (options) {
    // URL 上带了 ?id=xxx，options.id 就是那个编号
    const id = options.id || '';
    if (!id) {
      wx.showToast({ title: '没拿到这笔账', icon: 'none' });
      setTimeout(function () { wx.navigateBack(); }, 1000);
      return;
    }

    this.setData({ id: id });
    this.load(id);
  },

  /**
   * 每次「显示」都重新取一次
   *
   * 【为什么 onShow 里也要取，只写 onLoad 不行吗】
   * 不行的。从「改一改」保存完退回来时，onLoad 早已跑过（页面只创建一次），
   * 只有 onShow 会再跑一次。不写这条，改完金额退回来看到的还是旧数字，
   * 会让人以为没保存上。删除、从别处同步回来的场景同理。
   */
  onShow: function () {
    if (this.data.id) {
      this.load(this.data.id);
    }
  },

  /**
   * 按编号取这一笔并写进页面
   */
  load: function (id) {
    const self = this;

    db.getRecordById(id).then(function (res) {
      const list = res.list || [];
      if (!list.length) {
        self.setData({ loading: false });
        wx.showToast({ title: '这笔账不见了', icon: 'none' });
        // 先给提示再退，不然直接跳走用户根本没看到那句提示
        setTimeout(function () { wx.navigateBack(); }, 1200);
        return;
      }
      self.setData({ rec: list[0], loading: false });

    }).catch(function (err) {
      console.error('[枕江逢记账] 详情页取数据失败', err);
      self.setData({ loading: false });
      wx.showToast({ title: '没取到，返回重试', icon: 'none' });
    });
  },

  /**
   * 点「改一改」→ 去「记一笔」页，但告诉它这是在改（会带 id 过去）
   * record.js 里会判断有没有 id，有的话就把它填进表单
   */
  goEdit: function () {
    wx.navigateTo({
      url: '/pages/record/record?id=' + this.data.id
    });
  },

  /**
   * 点「删掉这笔」
   * 删除不可逆，所以必须二次确认；confirmColor 用红色提醒这是危险操作
   */
  onDelete: function () {
    const self = this;
    wx.showModal({
      title: '删掉这一笔？',
      content: '删掉就找不回来了。',
      confirmText: '删除',
      confirmColor: '#E64340',
      success: function (res) {
        if (!res.confirm) return;

        db.deleteRecord(self.data.id).then(function () {
          wx.showToast({ title: '已删除', icon: 'success', duration: 800 });
          // 退回到首页，首页 onShow 会重新取数，数字立刻变
          setTimeout(function () { wx.navigateBack(); }, 800);
        }).catch(function (err) {
          console.error('[枕江逢记账] 删除失败', err);
          wx.showToast({ title: '没删掉，再试一次', icon: 'none' });
        });
      }
    });
  }
});
