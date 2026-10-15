/**
 * tools/precheck.js —— 提审终检（提交微信审核前的自动体检）
 *
 * 【和 audit.js 的分工，别搞混】
 *   audit.js  → 查「代码点不动」：事件有没有绑到不存在的方法、变量有没有漏声明（体验问题）
 *   precheck.js → 查「提审会不会被打回」：缺页面文件、踩了个人主体做不了的接口、
 *                 appid 没填、包超限、wxml 引用了不存在的图片（审核问题）
 *
 * 【怎么用】
 *   在「项目根目录」打开终端（不是 miniprogram 目录），执行：
 *     node tools/precheck.js
 *   全流程不到 1 秒。每次改完代码、上传之前跑一遍。
 *
 * 退出码：0 = 全部通过；1 = 有 ✘ 致命项（这类不修，提审必被拒）
 */

const fs = require('fs');
const path = require('path');

// ============ 基础设施：路径与统计 ============

// 本脚本在 <项目根>/tools/ 下，上溯一级就是项目根
const ROOT = path.resolve(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');

/** 结果收集：ok / warn / fatal 三档 */
const fatal = [];
const warn = [];
const pass = [];

function markFatal(msg) { fatal.push(msg); }
function markWarn(msg) { warn.push(msg); }
function markPass(msg) { pass.push(msg); }

/** 文件存在且不是空目录 */
function exists(p) { return fs.existsSync(p); }

/** 读文件，不存在就返回空串，免得后面到处判空 */
function read(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
}

/** 递归数出某个目录里所有文件的体积（单位：字节） */
function dirSize(dir) {
  let sum = 0;
  if (!exists(dir)) return 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let names = [];
    try { names = fs.readdirSync(cur); } catch (e) { continue; }
    names.forEach(function (n) {
      const full = path.join(cur, n);
      let st = null;
      try { st = fs.statSync(full); } catch (e) { return; }
      if (st.isDirectory()) {
        stack.push(full);
      } else {
        sum += st.size;
      }
    });
  }
  return sum;
}

// ============ 检查 1：app.json 与页面四件套 ============
// 背景：页面只要有一个文件漏了（比如忘了建 .json），真机上就是白屏。
// 审核员点进白屏 = 直接拒。这一步必须在提审前自动查完。

const appJsonPath = path.join(MP, 'app.json');
let appJson = null;
try {
  appJson = JSON.parse(read(appJsonPath));
} catch (e) {
  markFatal('app.json 解析失败（JSON 语法有错）：' + e.message);
}

if (appJson) {
  const pages = appJson.pages || [];
  if (!pages.length) {
    markFatal('app.json 里 pages 是空的，小程序启动必白屏');
  } else {
    let miss = 0;
    pages.forEach(function (p) {
      ['.js', '.json', '.wxml', '.wxss'].forEach(function (ext) {
        if (!exists(path.join(MP, p + ext))) {
          markFatal('页面文件缺失：' + p + ext);
          miss++;
        }
      });
    });
    if (!miss) markPass('页面四件套齐全：' + pages.length + ' 个页面 × js/json/wxml/wxss 全部到位');
  }

  // tabBar 里写的路径，必须是 pages 里声明过的，否则 tab 点了没反应
  const list = (appJson.tabBar && appJson.tabBar.list) || [];
  let tabBad = 0;
  list.forEach(function (t) {
    if (pages.indexOf(t.pagePath) < 0) {
      markFatal('tabBar 指向的页面没在 pages 里声明：' + t.pagePath);
      tabBad++;
    }
    // 纯文字 tab 不需要图标；但真要加 iconPath 时，两个 tab 必须成对给（图标+选中图标）
    if (t.iconPath && !t.selectedIconPath) {
      markWarn('tab「' + (t.text || '') + '」给了 iconPath 却没给 selectedIconPath，选中态会没图标');
      tabBad++;
    }
  });
  if (list.length && !tabBad) markPass('tabBar 配置合法：' + list.length + ' 个 tab 路径均已声明');

  // 主入口必须是首页，审核员第一个点开的就是它
  if (pages[0]) markPass('主入口页面：' + pages[0] + '（提审时「功能页面路径」填这个）');
}

// ============ 检查 2：appid 与云环境 ============
// 背景：appid 没填，开发者工具能本地跑但传不上去；云环境 ID 写错，云表静默读不到。

const cfgSrc = read(path.join(MP, 'config.js'));
const mApp = cfgSrc.match(/APP_ID\s*:\s*['"]([^'"]+)['"]/);
const mEnv = cfgSrc.match(/CLOUD_ENV\s*:\s*['"]([^'"]+)['"]/);

if (!mApp) {
  markFatal('config.js 里找不到 APP_ID');
} else if (/^(wx)?$|^wx[0-9]{0,4}$/i.test(mApp[1]) || mApp[1].indexOf('wx') !== 0) {
  markFatal('config.js 的 APP_ID 看着像占位符，不是真 AppID：' + mApp[1]);
} else {
  markPass('config.js 的 APP_ID 已填：' + mApp[1]);
}

if (!mEnv) {
  markFatal('config.js 里找不到 CLOUD_ENV');
} else if (!mEnv[1]) {
  markWarn('config.js 的 CLOUD_ENV 是空字符串，云功能会静默失效（界面只显示「本机暂存」）');
} else {
  markPass('config.js 的 CLOUD_ENV 已填：' + mEnv[1]);
}

// project.config.json 的 appid 也得是同一个，两边不一致会传错项目
try {
  const pc = JSON.parse(read(path.join(MP, 'project.config.json')));
  if (pc.appid && mApp && pc.appid !== mApp[1]) {
    markFatal('两个 appid 不一致：project.config.json=' + pc.appid + '，config.js=' + mApp[1]);
  } else if (pc.appid) {
    markPass('project.config.json 的 appid 一致：' + pc.appid);
  } else {
    markFatal('project.config.json 里没有 appid，代码传不上去');
  }

  // 云函数目录声明了但目录不存在 → 开发者工具会找不到云入口
  const cf = pc.cloudfunctionRoot;
  if (cf) {
    if (exists(path.join(MP, cf))) markPass('云函数目录存在：' + cf);
    else markWarn('云函数目录声明了但不存在：' + cf + '（本项目第一版不用云函数，无影响）');
  }
} catch (e) {
  markFatal('project.config.json 解析失败：' + e.message);
}

// ============ 检查 3：个人主体踩线接口 ============
// 背景：个人主体做不了支付、社交、UGC。代码里扫到这些 API，提审几乎必被拒。
// 同时这也是《用户隐私保护指引》的判定依据 —— 扫出来是 0 项，提审页就能直接
// 走「确认承诺未处理用户任何信息」，省掉一轮被拦截。

const RISKY = [
  { api: 'requestPayment', why: '涉及支付，个人主体禁做' },
  { api: 'chooseWXPay', why: '涉及支付，个人主体禁做' },
  { api: 'getUserProfile', why: '取用户昵称头像，属隐私接口' },
  { api: 'getUserInfo', why: '取用户信息，属隐私接口' },
  { api: 'getPhoneNumber', why: '取手机号，属隐私接口且需企业资质' },
  { api: 'getLocation', why: '取地理位置，属隐私接口' },
  { api: 'chooseImage', why: '读相册/相机，属隐私接口' },
  { api: 'saveImageToPhotosAlbum', why: '写相册，属隐私接口' },
  { api: 'getRecorderManager', why: '录音，属隐私接口' },
  { api: 'requestSubscribeMessage', why: '订阅消息，需额外配置' },
  { api: 'login', why: 'wx.login 拿 openid 需服务端，本项目用不到' },
  { api: 'setClipboardData', why: '读写剪贴板属隐私接口' },
  { api: 'getClipboardData', why: '读写剪贴板属隐私接口' }
];

/**
 * 去掉注释，只留真正会执行的代码文本。
 * 为什么必须做这一步：注释里举例写「wx.setClipboardData({...})」是再正常不过的事，
 * 不剥离就会被当成真调用，脚本天天报同一个假警。
 * 三种注释都要剥：
 *   1. wxml 的 <!-- --> 注释（最容易漏，协议页那种长注释全靠它）
 *   2. js 的块注释，也就是斜杠星号开头的那种
 *   3. js 的行注释，只删「前面不是冒号」的，避免误删 http 冒号斜杠斜杠 这种
 * 顺序有讲究：先剥 wxml 注释，免得里面带的引号影响后面两种。
 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^\w:])\/\/[^\n]*/g, '$1');
}

/** 递归收集项目里所有 js / wxml 的「可执行代码」文本 */
function walkJs(dir, out) {
  if (!exists(dir)) return out;
  fs.readdirSync(dir).forEach(function (n) {
    const full = path.join(dir, n);
    const st = fs.statSync(full);
    if (st.isDirectory()) return walkJs(full, out);
    if (/\.(js|wxml)$/.test(n)) out.push(stripComments(read(full)));
  });
  return out;
}
const allJs = walkJs(MP, []).join('\n');

let riskyHit = 0;
RISKY.forEach(function (r) {
  if (allJs.indexOf('wx.' + r.api) >= 0 || allJs.indexOf('wx.' + r.api + '(') >= 0) {
    markFatal('代码里出现个人主体/隐私敏感接口 wx.' + r.api + ' —— ' + r.why);
    riskyHit++;
  }
});
if (!riskyHit) {
  markPass('敏感接口扫描：0 项（无支付 / 无登录 / 无头像昵称 / 无位置 / 无相册 / 无录音）');
}

// wx.request 要配白名单域名，个人主体又不能做电商，扫到就提醒
if (/wx\.request\s*\(/.test(allJs)) {
  markWarn('代码里有 wx.request（访问外部网址）。真机上会走域名白名单校验，未配置的域名直接请求失败');
} else {
  markPass('无 wx.request：不访问任何外部网址，无需配服务器域名白名单');
}

// ============ 检查 4：wxml 引用的图片资源是否真的存在 ============
// 背景：缺图不报错，就是一个空白方块；审核截图里看到空白图标=印象分崩。

function walkWxml(dir, out) {
  if (!exists(dir)) return out;
  fs.readdirSync(dir).forEach(function (n) {
    const full = path.join(dir, n);
    if (fs.statSync(full).isDirectory()) return walkWxml(full, out);
    if (/\.wxml$/.test(n)) out.push(full);
  });
  return out;
}

let imgMiss = 0;
walkWxml(MP, []).forEach(function (f) {
  const src = read(f);
  // 抓 <image src="./xx.png"> 和 <image src="{{a}}" ...> 以外的静态路径
  const re = /<image[^>]*\bsrc\s*=\s*["']([^"']+)["']/g;
  let m = null;
  while ((m = re.exec(src)) !== null) {
    const p = m[1];
    if (/^https?:/.test(p)) {
      markWarn('wxml 里用了网络图片（需后台配 downloadFile 白名单）：' + p);
      continue;
    }
    if (p.indexOf('{{') >= 0) continue;             // 动态路径查不了，跳过
    const target = path.resolve(path.dirname(f), p);
    if (!exists(target)) {
      markFatal('wxml 引用的图片不存在：' + p + '（' + path.relative(ROOT, f) + '）');
      imgMiss++;
    }
  }
  // tabBar 图标同理
  const re2 = /(iconPath|selectedIconPath)\s*:\s*['"]([^'"]+)['"]/g;
  let m2 = null;
  while ((m2 = re2.exec(src)) !== null) {
    const target = path.join(MP, m2[2]);
    if (!exists(target)) {
      markFatal('tabBar 图标文件不存在：' + m2[2]);
      imgMiss++;
    }
  }
});
if (!imgMiss) markPass('图片资源引用：全部可找到（本项目用纯文字 tab，无图标依赖）');

// ============ 检查 5：canvas 用法 ============
// 背景：用老的 canvas（不带 type="2d"）在部分机型上会画不出来。

const canvasOld = /<canvas(?![^>]*type\s*=\s*["']2d["'])[^>]*\bid\s*=\s*["']/g;
let canvasBad = 0;
walkWxml(MP, []).forEach(function (f) {
  const src = read(f);
  let m = null;
  while ((m = canvasOld.exec(src)) !== null) {
    markWarn('canvas 没写 type="2d"，建议改：' + path.relative(ROOT, f));
    canvasBad++;
  }
});
if (!canvasBad) markPass('canvas 用法：全部为 type="2d"（新版绘制接口）');

// ============ 检查 6：主包体积 ============
// 背景：小程序整个包（这里只算 miniprogram 目录）超 2MB 就传不上去。

const size = dirSize(MP);
const sizeKb = (size / 1024).toFixed(1);
const LIMIT = 2 * 1024 * 1024;   // 微信主包 2MB
if (size > LIMIT) {
  markFatal('项目体积 ' + sizeKb + ' KB，超过小程序主包 2MB 上限，传不上去');
} else {
  markPass('主包体积：' + sizeKb + ' KB（限 2048 KB，占 ' + (size / LIMIT * 100).toFixed(1) + '%）');
}

// ============ 检查 7：sitemap 与隐私页 ============
// 隐私页是「撤回同意」的落地页，审核会看有没有这条通路。

if (exists(path.join(MP, 'sitemap.json'))) markPass('sitemap.json 存在（索引配置正常）');
else markWarn('sitemap.json 缺失，页面搜索索引可能不生效');

if (appJson && appJson.pages && appJson.pages.indexOf('pages/privacy/privacy') >= 0) {
  markPass('隐私协议页已注册：可作为「撤回同意」落地页（审核常查项）');
} else {
  markWarn('没有注册隐私协议页，审核可能会要求补「用户可撤回同意」的路径');
}

// ============ 检查 8：提示文案里说的操作，得真的做得到 ============
// 背景：代码里存着一句「没取到数据，下拉刷新试试」，
// 但下拉刷新的开关从来没开过 —— 用户照着提示往下拉，屏幕上一点反应都没有，
// 只能觉得这 App 坏了。这种「界面说了做不到的事」和「协议里写假话」是同一类错，
// 肉眼通读代码极难发现，所以交给脚本常驻查。
//
// 只认「弹给用户的提示文字」里的说法（showToast 的 title），
// 代码注释里提到不算 —— 否则注释一改就天天报假警。

// 注意这里不能带 g 标志：带 g 的正则用 test() 会记住上次匹配到哪（lastIndex），
// 同一个正则在多个页面里轮流 test，会出现「这次真、下次假」的假警，很难查。
const pullTipRe = /showToast\(\s*\{[\s\S]{0,200}?title\s*:\s*['"][^'"]*下拉刷新[^'"]*['"]/;

let tipBad = 0;
if (appJson && appJson.pages) {
  appJson.pages.forEach(function (p) {
    const jsSrc = read(path.join(MP, p + '.js'));
    if (!jsSrc || pullTipRe.test(jsSrc) === false) return;   // 这页没这么提示过

    let jsonObj = null;
    try { jsonObj = JSON.parse(read(path.join(MP, p + '.json')) || '{}'); } catch (e) { jsonObj = null; }

    const opens = !!(jsonObj && jsonObj.enablePullDownRefresh === true);
    const hasHandler = /onPullDownRefresh\s*:/.test(jsSrc);
    const stops = jsSrc.indexOf('stopPullDownRefresh') >= 0;

    if (!opens) {
      markFatal(p + ' 提示了「下拉刷新」，但页面 json 没开 enablePullDownRefresh —— 用户往下拉什么都不会发生');
      tipBad++;
    } else if (!hasHandler) {
      markFatal(p + ' 开了下拉刷新，却没写 onPullDownRefresh 处理，下拉后不会重新取数');
      tipBad++;
    } else if (!stops) {
      markFatal(p + ' 有下拉刷新处理，但没调 wx.stopPullDownRefresh —— 转圈会一直转，像卡死');
      tipBad++;
    }
  });
}
if (!tipBad) markPass('提示与功能一致：「下拉刷新」提示对应的开关 + 处理函数 + 收转圈，三样都在');

// ============ 输出报告 ============

function line() { return '----------------------------------------'; }

console.log('提审终检 · 枕江逢记账');
console.log(line());
console.log('✔ 通过 ' + pass.length + ' 项');
if (warn.length) console.log('⚠ 提醒 ' + warn.length + ' 项');
if (fatal.length) console.log('✘ 致命 ' + fatal.length + ' 项（不修就会被打回）');
console.log(line());

pass.forEach(function (s) { console.log('  ✔ ' + s); });
warn.forEach(function (s) { console.log('  ！ ' + s); });
fatal.forEach(function (s) { console.log('  ✘ ' + s); });

console.log(line());
if (fatal.length) {
  console.log('结论：有致命项，先修上面带 ✘ 的再提审');
  process.exit(1);
} else {
  console.log('结论：代码侧全部通过，可以上传提审');
  console.log('注意：后台那两件（隐私保护指引、ICP 备案）不在这份脚本里，要手动办');
  process.exit(0);
}
