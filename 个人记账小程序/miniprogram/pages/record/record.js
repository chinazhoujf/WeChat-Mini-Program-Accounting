/**
 * pages/record/record.js —— 「记一笔」页面逻辑
 *
 * 这是整个 App 的主入口功能：大学生点开就记，目标 3 秒内记完。
 * 所以我们把表单做成「能少点就少点」：
 *   支出/收入 → 点一下切换（默认停在支出，因为 90% 的操作是花钱）
 *   分类      → 一排小方块，点一下就选中，不用弹窗
 *   金额      → 键盘自动弹数字键盘
 *   备注      → 可以不填
 *   日期      → 默认今天，记昨天的事就点一下改成昨天
 * 全程手指点，不打字，最快 4 下完成一笔。
 */

const config = require('../../config.js');
const db = require('../../utils/db.js');
const dateUtil = require('../../utils/date.js');

Page({

  data: {
    // ---- 新增模式（从首页 ＋ 号来）or 编辑模式（从详情页「改一改」来）----
    // id 为空 = 新增；有 id = 在改那一笔。整个页面的行为都靠这个字段分岔。
    id: '',
    isEdit: false,

    type: 'expense',        // 'expense'=支出（默认），'income'=收入
    categories: [],         // 当前分类列表，切换类型时会自动换
    category: '',           // 当前选中的分类（记住它，用户不用重选）

    amount: '',             // 金额，存的是字符串（输入框里拿到的是字符串）
    note: '',               // 备注

    date: '',               // 日期，'2026-10-03' 格式
    maxDate: '',            // 日期选择器上限＝今天，不能记未来的账

    submitting: false       // 是否正在保存（防止手抖连点存两笔）
  },

  /**
   * 页面打开
   * options 是-url 上带过来的参数：
   *   从 ＋ 号来 → options 为空 → 新增模式
   *   从详情页来 → options.id = '云库里的编号' → 编辑模式
   */
  onLoad: function (options) {
    const self = this;
    const today = dateUtil.today();

    // 先把界面骨架铺好（日期、分类），这样就算取数据慢一点也不会白屏
    this.setData({
      date: today,
      maxDate: today,
      categories: this.categoriesOf('expense'),
      category: config.EXPENSE_CATEGORIES[0]
    });

    // ---- 编辑模式：把原来那笔填进表单 ----
    const id = options && options.id ? options.id : '';
    if (!id) return;

    this.setData({ id: id, isEdit: true });
    // 顶部标题跟着改成「改一笔」，不然用户以为自己在记新的
    wx.setNavigationBarTitle({ title: '改一笔' });

    db.getRecordById(id).then(function (res) {
      const list = res.list || [];
      if (!list.length) {
        wx.showToast({ title: '这笔账不见了', icon: 'none' });
        setTimeout(function () { wx.navigateBack(); }, 1200);
        return;
      }

      const r = list[0];
      self.setData({
        type: r.type || 'expense',
        // 分类列表要按类型重新铺，否则「支出」界面上出现「奖学金」这种错配
        categories: self.categoriesOf(r.type),
        category: r.category,
        // 金额转回字符串填进输入框（输入框只认字符串）
        amount: String(r.amount),
        note: r.note || '',
        date: r.date
      });

    }).catch(function (err) {
      console.error('[枕江逢记账] 进入编辑模式取原数据失败', err);
      wx.showToast({ title: '没读到这笔，改成新增了', icon: 'none' });
      // 取不到就掉回新增模式，总比让用户卡在一个空白的编辑页强
      self.setData({ id: '', isEdit: false });
    });
  },

  /**
   * 根据类型取出对应的分类列表
   * 支出和收入的分类是两套，不能混着选（「奖学金」显然不是支出分类）
   */
  categoriesOf: function (type) {
    return type === 'income' ? config.INCOME_CATEGORIES : config.EXPENSE_CATEGORIES;
  },

  /**
   * 点「支出 / 收入」切换
   * data-type 是写在 wxml 标签上的自定义属性，e.currentTarget.dataset.type 就是它
   */
  switchType: function (e) {
    const type = e.currentTarget.dataset.type;
    if (type === this.data.type) return;   // 已经选中的就不再处理，避免无谓刷新

    // 切换类型时分类要跟着换，否则会出现「支出却选了奖学金」的错账
    this.setData({
      type: type,
      categories: this.categoriesOf(type),
      category: (type === 'income' ? config.INCOME_CATEGORIES : config.EXPENSE_CATEGORIES)[0]
    });
  },

  /**
   * 点某个分类小方块 → 选中它
   * 界面上靠 selected 这个 class 变绿，所以这里只改数据，样式交给 wxss
   */
  pickCategory: function (e) {
    const name = e.currentTarget.dataset.name;
    this.setData({ category: name });
  },

  /**
   * 金额输入框：把用户输入限制成「最多两位小数的数字」
   * 为什么要拦：不然会出现「abc」「1.2.3」这种存进数据库就查不出来的脏数据
   */
  onAmountInput: function (e) {
    let v = e.detail.value;
    // 只留数字和一个小数点
    v = v.replace(/[^0-9.]/g, '');
    // 小数点最多一个
    const dotIndex = v.indexOf('.');
    if (dotIndex !== -1) {
      v = v.slice(0, dotIndex + 1) + v.slice(dotIndex + 1).replace(/\./g, '');
    }
    // 小数最多两位
    if (dotIndex !== -1) {
      const parts = v.split('.');
      if (parts[1].length > 2) v = parts[0] + '.' + parts[1].slice(0, 2);
    }
    this.setData({ amount: v });
  },

  onNoteInput: function (e) {
    this.setData({ note: e.detail.value });
  },

  /**
   * 日期选择器：用户手动选了别的日期
   * e.detail.value 是 '2026-10-01' 这种字符串
   */
  onDateChange: function (e) {
    this.setData({ date: e.detail.value });
  },

  /**
   * 点「保存」
   * 保存后自动退回首页，首页的 onShow 会立刻重新算数，你马上就能看到变化
   */
  save: function () {
    // ---- 第 1 关：金额校验 ----
    const amount = Number(this.data.amount);
    if (!this.data.amount || isNaN(amount) || amount <= 0) {
      wx.showToast({ title: '先填个金额吧', icon: 'none' });
      return;
    }
    if (amount > 9999999) {
      wx.showToast({ title: '金额太大了，检查一下？', icon: 'none' });
      return;
    }

    // ---- 第 2 关：别重复提交 ----
    // 云保存有一小段延迟，不锁住就会出现「存了三笔同样的」
    if (this.data.submitting) return;
    this.setData({ submitting: true });

    // ---- 第 3 关：真的存（编辑和新增走两条路）----
    // 这里必须用 bind(this) 或者箭头函数：setTimeout / then 里的 this 会丢，
    // 不绑回来的话 Submitting 永远复位不了，按钮会一直是灰的。
    const self = this;
    const payload = {
      type: this.data.type,
      category: this.data.category,
      amount: amount,
      note: this.data.note,
      date: this.data.date
    };

    if (this.data.isEdit) {
      // ---- 编辑：只改这一条，不动数据库里其他账 ----
      db.updateRecord(this.data.id, payload).then(function () {
        wx.showToast({ title: '改好了', icon: 'success', duration: 800 });
        // 退回上一页 —— 上一页就是详情页，重新打开就能看到改完的结果
        setTimeout(function () { wx.navigateBack(); }, 800);
      }).catch(function (err) {
        console.error('[枕江逢记账] 修改失败', err);
        wx.showToast({ title: '没改上，再试一次', icon: 'none' });
        self.setData({ submitting: false });
      });
      return;
    }

    // ---- 新增 ----
    db.addRecord(payload).then(function (res) {
      // 【为什么要看 res.fallback】
      // res.fallback = true 表示「云端没写成，这笔账只存进了本机」。
      // 以前这里不看它，照样弹「记好了」，用户以为进了云，
      // 结果换手机、清缓存之后账全没了，还不知道是从哪笔开始丢的。
      // 记账 App 里「以为存了其实没存」，比「明确告诉你没存」糟糕十倍，必须当场说清。
      if (res && res.fallback) {
        wx.showToast({
          title: '记下了，但只存本机（云没连上）',
          icon: 'none',
          duration: 2200
        });
        // 提示时间给够，让用户真看清这句再说
        setTimeout(function () {
          wx.navigateBack();   // 退回上一页（就是首页）
        }, 1700);
        return;
      }

      wx.showToast({ title: '记好了', icon: 'success', duration: 800 });

      // 等提示弹窗消失再返回，不然是直接跳走的，看不到那个对勾
      setTimeout(function () {
        wx.navigateBack();   // 退回上一页（就是首页）
      }, 800);

    }).catch(function (err) {
      console.error('[枕江逢记账] 保存失败', err);
      wx.showToast({ title: '没存上，再试一次', icon: 'none' });
      self.setData({ submitting: false });
    });
  },

  /**
   * 点左上角返回（不保存）
   * 编辑模式退回详情页，新增模式退回首页 —— 两个入口不一样，得分开处理
   */
  goBack: function () {
    // 不管新增还是编辑，栈顶都是它的上一页（首页 或 详情页），直接弹回去。
    // 详情页写了 onShow 重新取数，所以编辑完退回去不会看到旧数字。
    wx.navigateBack();
  }
});
