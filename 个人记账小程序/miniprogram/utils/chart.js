/**
 * utils/chart.js —— 用 canvas 画两种图（环形饼图 / 柱状趋势图）
 *
 * 【为什么手画，不直接用现成的图表库】
 * 图表库（ECharts、wx-charts…）看着省事，但对新手是三个坑：
 *   1. 版本和基础库对不上，报一堆看不懂的错；
 *   2. 要往 app.json 里注册组件，漏一步就「白屏」；
 *   3. 打包体积暴涨，小程序的包大小是硬限制。
 * 记账只需要「占比」和「趋势」两张图，加起来不到 150 行，
 * 手画的好处是：报错我一眼能看懂，改颜色改间距都在一个文件里。
 *
 * 【canvas type="2d" 的三个必须记住的规矩】
 *   规矩 1：canvas 不像普通 view 会自动撑开，宽高要自己在 wxss 里给死；
 *   规矩 2：要在 js 里用 wx.createSelectorQuery 拿节点，不是 getElementById；
 *   规矩 3：高清屏上要按像素比放大画布再 scale，不然图是模糊的。
 */

/**
 * 【工具】拿到某个 canvas 的「画笔」和尺寸
 *
 * @param {Object} page 页面实例（Page 里的 this），因为要 .in(page) 限定查找范围
 * @param {String} id   wxml 里 canvas 的 id，如 'pieCanvas'
 * @param {Number} retry 拿不到时最多重试几次（默认 3 次）
 * @return Promise 成功 → { ctx, width, height }；始终拿不到 → null
 *
 * 【为什么要重试，而不是拿到就用】
 * 底部 tab 来回切时，canvas 节点是「销毁 → 重新创建」的。
 * 重建后的头一两帧，微信还没算好布局，.fields({size:true}) 会返回 width/height = 0。
 * 这时候拿 0 去画，画出来的就是一张空白图，而且不会报错 —— 最难查。
 * 所以这里发现尺寸是 0 就等 40 毫秒再取一次，最多试 4 次，之后再放弃（宁可不画，也不白屏崩掉）。
 */
function pickCanvas(page, id, retry) {
  const maxRetry = (typeof retry === 'number') ? retry : 3;

  return new Promise(function (resolve) {
    let settled = false;                     // 防止重试和结果都回调，只认第一个
    function finish(c) {
      if (settled) return;
      settled = true;
      resolve(c);
    }

    /** 递归去取，left 是还剩几次机会 */
    function tryPick(left) {
      wx.createSelectorQuery()
        .in(page)
        .select('#' + id)
        .fields({ node: true, size: true })   // node=拿到画布本身，size=拿到css宽高
        .exec(function (res) {
          const item = res && res[0];

          // 情况一：节点压根不存在（页面还没建好）
          if (!item || !item.node) {
            if (left > 0) {
              setTimeout(function () { tryPick(left - 1); }, 40);
            } else {
              finish(null);                   // 老实返回 null，不抛错，免得整页崩
            }
            return;
          }

          // 情况二：节点在，但尺寸还是 0 —— 布局还没算完，等一下再来
          if (!item.width || !item.height) {
            if (left > 0) {
              setTimeout(function () { tryPick(left - 1); }, 40);
            } else {
              finish(null);                   // 试完了还是 0，放弃这一次画图，等下次 onShow
            }
            return;
          }

          const canvas = item.node;
          const ctx = canvas.getContext('2d');

          // 高清屏适配：画布的「真实像素」要比「显示尺寸」大 dpr 倍
          // wx.getWindowInfo 是新接口，老版本工具没有，所以用 || 兜底到 getSystemInfoSync
          const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
          const dpr = info.pixelRatio || 1;

          canvas.width = Math.floor(item.width * dpr);
          canvas.height = Math.floor(item.height * dpr);

          // 先复位变换矩阵。为什么：重画会反复调 scale，不复位的话会倍率越叠越大，
          // 画出来越来越糊越来越扁 —— 这是新手画 canvas 最典型的坑，没有之一。
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.scale(dpr, dpr);

          finish({ ctx: ctx, width: item.width, height: item.height, node: canvas });
        });
    }

    tryPick(maxRetry);
  });
}

/**
 * 画环形饼图（钱花在哪些分类上）
 *
 * 【实现原理】
 * 圆的周长是 360°，某分类占 25% 支出就从 0° 画到 90° 一段圆弧，各段首尾相接拼成整圆。
 *
 * 【本次为「外观」做的调整，不影响任何取数 / 计算逻辑】
 *   1. 环整体「稍微大一点」：边距 10 → 6，离边缘更近但不被裁。
 *   2. 中心文字改成白色：白字必须压在深色圆盘上才看得清，所以中心多画了一个深色圆盘。
 *   3. 显示动画：圆弧从 0 扫到整圈（easeOutCubic，约 0.52 秒），中心文字在最后淡入。
 *   4. 深色模式：读取系统主题，圆盘 / 文字 / 分隔线自动换深色配色（需 app.json 开启 darkmode）。
 *
 * @param {Object} c    pickCanvas 的结果 { ctx, width, height, node }
 * @param {Array}  data [{ name, value, color }, ...]
 * @param {Object} opt  可选：{ animate:false } 可关闭动画
 */
function drawDonut(c, data, opt) {
  opt = opt || {};
  const ctx = c.ctx, w = c.width, h = c.height;

  // 动画默认开；传 opt.animate=false 可关
  const animate = opt.animate !== false;

  // 主题适配：app.json 开启 darkmode 后，getSystemInfoSync().theme 会返回 'dark'
  // 这里只决定「画上去的颜色」，不碰任何数据 / 存储逻辑
  let isDark = false;
  try {
    const sys = wx.getSystemInfoSync();
    isDark = !!(sys && sys.theme === 'dark');
  } catch (e) {}

  const CENTER_FILL = isDark ? '#0E0E0E' : '#14171C';   // 中心圆盘底色（白字衬底）
  const EMPTY_RING  = isDark ? '#2A2A2A' : '#EDEFF2';   // 无数据时的灰环
  const EMPTY_TEXT  = isDark ? '#6B7280' : '#C0C4CC';   // 无数据时的提示字
  const SEP_COLOR   = isDark ? '#1E1E1E' : '#FFFFFF';   // 扇段间的分隔边

  // 汇总，顺带算总支出（中心文字用）
  let total = 0;
  data.forEach(function (d) { total += Number(d.value) || 0; });

  const cx = w / 2, cy = h / 2;
  const rOut = Math.min(w, h) / 2 - 6;   // 边距 10→6，环「稍微大一点」
  const rIn  = rOut * 0.58;              // 内圈比例不变，环粗细比例保持

  // 单帧绘制：progress 0→1 控制圆弧扫过的比例
  function paint(progress) {
    ctx.clearRect(0, 0, w, h);

    // 没有任何支出：画个灰环 + 一句话（无动画，直接出）
    if (total <= 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, (rOut + rIn) / 2, 0, Math.PI * 2);
      ctx.strokeStyle = EMPTY_RING;
      ctx.lineWidth = rOut - rIn;
      ctx.stroke();

      ctx.fillStyle = EMPTY_TEXT;
      ctx.font = '26px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('本月还没有支出', cx, cy);
      return;
    }

    // 一段一段画；动画时只画到 sweep 角度
    let start = -Math.PI / 2;
    const sweep = Math.PI * 2 * progress;
    let drawn = 0;

    data.forEach(function (d) {
      const value = Number(d.value) || 0;
      if (value <= 0) return;
      const angle = (value / total) * Math.PI * 2;
      const visible = Math.max(0, Math.min(angle, sweep - drawn));
      if (visible <= 0) return;

      ctx.beginPath();
      ctx.arc(cx, cy, rOut, start, start + visible);
      ctx.arc(cx, cy, rIn, start + visible, start, true);
      ctx.closePath();
      ctx.fillStyle = d.color;
      ctx.fill();
      ctx.strokeStyle = SEP_COLOR;   // 扇段之间描一道边，视觉分得更清
      ctx.lineWidth = 2;
      ctx.stroke();

      drawn += angle;
      start += angle;
    });

    // 中心深色圆盘（白字要压在深底上）
    ctx.beginPath();
    ctx.arc(cx, cy, rIn, 0, Math.PI * 2);
    ctx.fillStyle = CENTER_FILL;
    ctx.fill();

    // 中心文字：白色，动画后段淡入，避免和正在扫描的环打架
    if (progress > 0.55) {
      const alpha = Math.min(1, (progress - 0.55) / 0.45);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 34px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('¥' + total.toFixed(2), cx, cy - 8);

      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = '22px sans-serif';
      ctx.fillText('本月支出', cx, cy + 26);
      ctx.globalAlpha = 1;
    }
  }

  // 无数据时直接画一帧，省去无意义的动画循环
  runAnimation(c.node, ctx, total <= 0 ? false : animate, paint);
}

/**
 * 画柱状趋势图（近 6 个月，钱是变多了还是变少了）
 *
 * 图画法：先算出最高的那个月，把画布高度当成它的柱高，其它按月等比缩。
 *
 * 【本次为「外观」做的调整，不影响取数 / 计算逻辑】
 *   1. 显示动画：柱子从底部「长」出来（easeOutCubic，约 0.52 秒），柱顶金额在快长完时才出现。
 *   2. 深色模式：基准线、金额字、月份字自动换深色配色（需 app.json 开启 darkmode）。
 *
 * @param {Object} c    pickCanvas 的结果
 * @param {Array}  items [{ label:'5月', value:1200 }, ...]
 * @param {Object} opt  可选：{ color:'#07C160', animate:false }
 */
function drawBars(c, items, opt) {
  opt = opt || {};
  const ctx = c.ctx, w = c.width, h = c.height;
  const color = opt.color || '#07C160';
  const animate = opt.animate !== false;

  // 主题适配：只读颜色，不碰数据
  let isDark = false;
  try {
    const sys = wx.getSystemInfoSync();
    isDark = !!(sys && sys.theme === 'dark');
  } catch (e) {}

  const BASE_LINE  = isDark ? '#333333' : '#EDEFF2';
  const VALUE_TEXT = isDark ? '#9AA0A6' : '#6B7280';
  const MONTH_TEXT = '#9AA0A6';
  const ZERO_FILL  = isDark ? '#2A2A2A' : '#F2F3F5';

  const padTop = 26, padBottom = 40, padLeft = 6, padRight = 6;
  const innerH = h - padTop - padBottom;
  const n = items.length;
  if (!n) return;

  // ---- 找最大值，决定「最高的柱子有多高」 ----
  let max = 0;
  items.forEach(function (it) { if (Number(it.value) > max) max = Number(it.value); });
  // 全是 0 的话别让柱子高度变成 NaN，给个假最大值，画一个空底
  if (max <= 0) max = 1;

  // 每根柱子分到的宽度；柱身只占 slot 的 56%，剩下留白，看着不挤
  const slot = (w - padLeft - padRight) / n;
  const barW = slot * 0.56;

  // 单帧绘制：progress 0→1 控制柱子高度比例
  function paint(progress) {
    ctx.clearRect(0, 0, w, h);

    // 底部灰色基准线
    ctx.strokeStyle = BASE_LINE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(padLeft, h - padBottom);
    ctx.lineTo(w - padRight, h - padBottom);
    ctx.stroke();

    items.forEach(function (it, i) {
      const value = Number(it.value) || 0;
      const fullH = (value / max) * innerH;
      const barH = fullH * progress;   // 动画：从 0 长到 fullH
      const x = padLeft + slot * i + (slot - barW) / 2;
      const y = (h - padBottom) - barH;

      if (value > 0) {
        ctx.fillStyle = color;
        roundRect(ctx, x, y, barW, barH, 6);  // 圆角矩形，比直角好看
        ctx.fill();

        // 柱顶金额：快长完（>85%）才出现，避免数字悬在半空
        if (progress > 0.85) {
          ctx.fillStyle = VALUE_TEXT;
          ctx.font = '20px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(String(value), x + barW / 2, y - 4);
        }
      } else {
        // 0 元也要画一小截浅灰底，否则那个月看着像「断柱」
        ctx.fillStyle = ZERO_FILL;
        roundRect(ctx, x, (h - padBottom) - 4, barW, 4, 2);
        ctx.fill();
      }

      // 底下写月份（不随动画）
      ctx.fillStyle = MONTH_TEXT;
      ctx.font = '20px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(it.label, x + barW / 2, h - padBottom + 8);
    });
  }

  runAnimation(c.node, ctx, animate, paint);
}

/**
 * 【工具】画圆角矩形（canvas 原生没有 roundRect，得自己拼）
 * 用 arcTo：从当前点画一条线，折一个圆角，再画一条线
 */
function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);   // 圆角不能超过边长的一半，否则会画歪
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * 【工具】在 canvas 上跑一段「显示动画」
 *
 * 用 canvas 节点自带的 requestAnimationFrame 逐帧重绘，progress 从 0 走到 1；
 * 传入的 paint(progress) 负责把当前进度的画面画出来。曲线用 easeOutCubic（先快后慢），收尾自然。
 *
 * 注意：这是纯「外观」动画，不读取、不修改任何业务数据。
 * 若节点不支持 rAF（极少数老基础库），自动降级为一次性画完（paint(1)），不会白屏。
 *
 * @param {Object}   node    canvas 节点（提供 requestAnimationFrame）
 * @param {Object}   ctx     2d 画笔
 * @param {Boolean}  animate 是否开启动画
 * @param {Function} paint   单帧绘制函数 paint(progress)
 */
function runAnimation(node, ctx, animate, paint) {
  // 新动画开始前，取消上一次还没跑完的（比如频繁切 tab），避免两帧叠加
  if (node && node.cancelAnimationFrame && node._rafId) {
    node.cancelAnimationFrame(node._rafId);
  }

  if (!animate || !node || !node.requestAnimationFrame) {
    paint(1);   // 不开动画 / 不支持动画 → 直接画最终态
    return;
  }

  const duration = 520;
  const startTime = Date.now();

  function step() {
    const t = Math.min(1, (Date.now() - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 3);   // easeOutCubic
    paint(eased);
    if (t < 1) {
      node._rafId = node.requestAnimationFrame(step);
    } else {
      node._rafId = null;
    }
  }

  node._rafId = node.requestAnimationFrame(step);
}

module.exports = {
  pickCanvas,
  drawDonut,
  drawBars
};
