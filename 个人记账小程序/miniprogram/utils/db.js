/**
 * utils/db.js —— 云数据库的读写「总闸门」
 *
 * 【大白话先讲清楚云开发是什么】
 * 你不用买服务器、不用装数据库软件。微信在云端给你一个「网盘 + 表格」，
 * 你往里存账目，手机、电脑都能取。这个 total 闸门就是所有存取操作唯一走的地方，
 * 好处是：以后要换存法（比如从云换成本地），只改这一个文件，页面一行都不用动。
 *
 * 【这个文件你不用改，只看得懂就行】
 *
 * 【重要：为什么要有「本地兜底」】
 * 还没开通云开发的时候，如果代码一碰数据库就报错，页面会一片空白，你会以为自己做错了。
 * 所以这里加了一层兜底：云不通就先存到手机本地（和微信聊天记录一个道理），
 * 页面照样能用，你随时可以先把界面玩起来。云一通，两边自动一致。
 */

const config = require('../config.js');

// ===== 本地兜底用的「仓库名字」=====
// 相当于给本机存的数据起个名，取名是为了以后能精准找到它
const LOCAL_RECORDS_KEY = 'zjf_records';   // zjf = 枕江逢 首字母
const LOCAL_BUDGET_KEY = 'zjf_budget';

// ===== 云端分页相关的两个硬数字 =====
// 小程序端一次最多只能拉 CLOUD_PAGE_SIZE 条（微信写死的，写更大也没用），
// 所以「要拿全部数据」只能一页一页往后翻，这就是分页。
const CLOUD_PAGE_SIZE = 100;
// 一次最多翻几条就封顶：1000 条对记账来说够用十年多了，
// 封顶是为了防手机内存爆掉；真翻到这个数会带 truncated 标记告诉界面。
const CLOUD_MAX_ROWS = 1000;

/**
 * 判断云开发当前能不能用
 * 两个条件缺一不可：① 代码里允许用云（CLOUD_ENV 填了）② 微信确实提供了云能力
 */
function isCloudReady() {
  return !!(config.CLOUD_ENV && wx.cloud);
}

// ===== 云健康探测 =====
// 记录「最近一次云探测的结果」：null=还没探过，true=通，false=不通。
// 为什么要这个东西：以前云挂了（比如上线后免费环境到期被停、集合权限被改），
// 界面表现是「这个月还没有记账」——你根本分不清是没记账，还是云压根连不上。
// 这种误判最难查，所以在数据层统一探一次，让页面有话可说。
let cloudProbeState = null;   // null / true / false
let cloudProbeAt = 0;         // 上次探测的时间戳，用来做「一分钟只探一次」
const PROBE_INTERVAL = 60000; // 60 秒

/**
 * 探一次云：问数据库「records 集合里还有没有东西」
 *
 * 为什么用 limit(1) 而不用 count：
 * count 只是数个数，limit(1).get() 是拉一条真实数据回来。
 * 后者能顺带验证「权限也对不对」，前者权限不对时照样能数出个数，探不准。
 * 一次只拉 1 条，流量基本为零。
 *
 * @param {Boolean} force true = 忽略 60 秒缓存强制探（点「重试」时用）
 * @return Promise → { ok:Boolean, reason:String }
 */
function probeCloud(force) {
  // 云压根没启用（本机暂存模式），没什么好探的
  if (!isCloudReady()) {
    cloudProbeState = null;
    return Promise.resolve({ ok: false, reason: 'local' });
  }

  // 一分钟之内探过就复用结果，免得每次进首页都白跑一趟网络
  if (!force && cloudProbeState !== null && Date.now() - cloudProbeAt < PROBE_INTERVAL) {
    return Promise.resolve({ ok: cloudProbeState === true });
  }

  cloudProbeAt = Date.now();

  return wx.cloud.database().collection('records')
    .limit(1)
    .get()
    .then(function () {
      cloudProbeState = true;
      return { ok: true };
    })
    .catch(function (err) {
      // 探不通也要记下来，页面才有依据说「不是你没记账，是云连不上」
      cloudProbeState = false;
      console.error('[枕江逢记账] 云探测失败', err);
      return { ok: false, reason: 'error' };
    });
}

/**
 * 云是不是「配了但连不上」（区别于「压根没启用云」）
 * @return Boolean
 */
function isCloudSick() {
  return cloudProbeState === false;
}

/**
 * 给界面用的云状态，三种：
 *   'cloud'  云正常
 *   'error'  云配了但连不上（多半是环境过期未续费、或 records 集合没建/权限不对）
 *   'local'  本机暂存模式（开发阶段云没通）
 * @return String
 */
function getCloudState() {
  if (!isCloudReady()) return 'local';
  if (cloudProbeState === null) return 'cloud'; // 还没探过，按『云已启用』显示，别吓人
  return cloudProbeState ? 'cloud' : 'error';
}

/**
 * 【内部工具】从本地仓库里把所有账目取出来
 * wx.getStorageSync = 从手机本地读，同步的意思是「读完才往下走」，代码更好懂
 */
function localReadAll() {
  try {
    const list = wx.getStorageSync(LOCAL_RECORDS_KEY);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    // 兜底：万一读出来是坏的（比如你手动改坏了），就当空，不让页面崩
    return [];
  }
}

/**
 * 【内部工具】把账目数组写回本地仓库
 */
function localWriteAll(list) {
  try {
    wx.setStorageSync(LOCAL_RECORDS_KEY, list);
  } catch (e) {
    console.error('[枕江逢记账] 写本地存储失败（可能是手机存储空间满了）', e);
  }
}

/**
 * 【调试用】在开发者工具的「调试器 → Console」里打印当前是哪种存储模式
 *
 * 这是给你（尤其是我排查问题时）看的一行字，界面上看不出来到底存哪了：
 *   - 打印「云开发」→ 数据真的在云端，换手机、清缓存都还在
 *   - 打印「本机暂存」→ 数据只在这台电脑的开发者工具里，云里看不到（但页面照样能记账）
 *
 * 【为什么会退化成本机暂存】
 * 常见原因是导入项目时「后端服务」那一栏没改，还停在默认的「不使用云服务」，
 * 结果 wx.cloud 这个能力不存在，这里就自动降级了。
 * 看到这行字就说明要回去把工具栏的「云开发」按钮打开。
 */
function logMode() {
  const cloud = isCloudReady();
  console.log('[枕江逢记账] 存储模式：' + (cloud
    ? '云开发（数据存云端）'
    : '本机暂存（未启用云开发，云控制台看不到记录）'));
  return cloud;
}

/**
 * 存一笔账
 *
 * @param {Object} rec 账目内容，格式：
 *   { type:'expense'|'income', category:'餐饮', amount:18.5, note:'食堂', date:'2026-10-03' }
 * @return Promise 成功后返回 { ok:true, id:'...' }，失败返回 rejected
 */
function addRecord(rec) {
  // 补两个「系统自动加」的字段：月份和创建时间。
  // 存月份是为了以后查「这个月花了多少」时一句数据库指令就能搞定，不用在手机上一笔笔数。
  const doc = {
    type: rec.type,
    category: rec.category,
    amount: Number(rec.amount),
    note: rec.note || '',
    date: rec.date,
    month: rec.date.slice(0, 7),   // '2026-10-03'.slice(0,7) 就是 '2026-10'
    createdAt: new Date()
  };

  // --- 情况 1：云可用 → 存云端 ---
  if (isCloudReady()) {
    return wx.cloud.database().collection('records')
      .add({ data: doc })
      .then(function (res) {
        return { ok: true, id: res._id };
      })
      .catch(function (err) {
        // 存云端失败时告诉清楚原因，方便你截图排查
        console.error('[枕江逢记账] 存云端失败，先转本地保存', err);

        // 【这一步千万别删】
        // 写失败 ≠ 读不通。云探测探的是「读」（limit(1).get()）。
        // 如果这里不刷新探测状态，首页探测照样通过，界面会一直显示「云正常」，
        // 而你每一笔账其实都只躺在手机本地 —— 界面上一点破绽都没有，
        // 直到你换手机/清缓存，账才凭空消失。这是记账 App 最危险的静默失败。
        // 这里强制探一次，把状态打回 false，首页立刻亮红条，用户当场就能看见。
        probeCloud(true);

        return localAdd(doc);
      });
  }

  // --- 情况 2：云没通 → 存本地 ---
  logMode();
  return localAdd(doc);
}

/**
 * 【内部工具】只往本地存一笔（云端失败时自动降级用）
 */
function localAdd(doc) {
  const list = localReadAll();
  const item = Object.assign({}, doc);
  item._id = 'local_' + Date.now();   // 本地数据自己造一个唯一编号
  list.push(item);
  localWriteAll(list);
  return Promise.resolve({ ok: true, id: item._id, fallback: true });
}

/**
 * 【内部工具】把云端「符合条件的数据全部取回来」，一次取不完就翻页接着取
 *
 * 为什么非要这么麻烦：云数据库在手机端一次最多只给 100 条（CLOUD_PAGE_SIZE）。
 * 以前这里偷懒只写一句 limit(100)，结果一个月记满 100 笔以后，
 * 超过 100 笔的账**已经存进云端了，但界面上一笔都看不到** ——
 * 首页总额少算、饼图少几个分类，而界面完全不报错。
 * 这类「数据明明在，就是显示不出来」的 bug 比报错难查十倍，所以统一走分页。
 *
 * @param {Function} buildQuery 传一个函数进来，参数是「从第几条开始」，
 *                              你在这个函数里返回带 skip/limit 的查询对象。
 *                              为什么传函数而不是传现成的对象：
 *                              查询对象每翻一页都要重建，复用老对象会让 skip 串味。
 * @return Promise → { list:[...], truncated:Boolean }
 */
function queryAll(buildQuery) {
  let skip = 0;   // 从第几条开始（第 1 页 0、第 2 页 100……）
  let rows = [];  // 翻到的所有数据攒这儿

  function page() {
    return buildQuery(skip).get().then(function (res) {
      const part = res && res.data ? res.data : [];
      rows = rows.concat(part);

      // 这一页刚好填满 = 后面可能还有；没填满 = 到底了，可以收工
      const full = part.length === CLOUD_PAGE_SIZE;

      if (full && rows.length < CLOUD_MAX_ROWS) {
        skip += CLOUD_PAGE_SIZE;
        return page();          // 接着翻下一页
      }

      // 刚好翻到上限那一页：不能只看「满了就算取不全」——
      // 要是这个月正好 1000 条，其实一笔没漏，却被标成「取不全」，
      // 界面就会冒出一句「只显示了最近 1000 笔」的白吓。
      // 所以再多探一次：后面确实还有才叫截断。
      // 注意这里必须跳到「下一页的起点」(skip + CLOUD_PAGE_SIZE) 去探，
      // 不能还在原地上问一次 —— 问原地的意思是「第 901~1000 条还有吗」，
      // 既然上一页已经拿过了，再问一次会得到同一页，
      // 结果 1000 条会被算成 1100 条（凭空多出 100 行重复账），比不分页还糟。
      if (rows.length >= CLOUD_MAX_ROWS) {
        return buildQuery(skip + CLOUD_PAGE_SIZE).get().then(function (more) {
          const rest = more && more.data ? more.data : [];
          rows = rows.concat(rest);
          return { list: rows, truncated: rest.length > 0 };
        });
      }

      return { list: rows, truncated: false };   // 没填满就到底了，肯定取全了
    });
  }

  return page();
}

/**
 * 取某个月的账目（按日期从新到旧排）
 *
 * @param {String} month 形如 '2026-10'
 * @return Promise → { ok:true, list:[...], truncated:Boolean }
 *
 * 【为什么查「某个月」这么简单】
 * 因为我们在存的时候就把月份写进去了，数据库只要一句 where month='2026-10'，
 * 不用把一年 365 天的数据全拉下来再在手机上挑——手机上挑又慢又费电。
 */
function getMonthRecords(month) {
  if (!isCloudReady()) {
    logMode();
    // 本地模式：把本地全部拿出来，再在手机里按月份筛（数据量很小时完全够用）
    const all = localReadAll().filter(function (item) {
      return item.month === month;
    });
    all.sort(function (a, b) { return a.date < b.date ? 1 : -1; });  // 新的在前
    return Promise.resolve({ ok: true, list: all, fallback: true });
  }

  // 先探一次云：探不通就直接把「云连不上」抛出去，
  // 不让它表现成「这个月还没有记账」——那种静默失败最难查出问题出在哪。
  return probeCloud()
    .then(function (probe) {
      if (!probe.ok) {
        const e = new Error('云不可用（环境过期未续费 / 集合没建 / 权限不对）');
        e.cloudUnavailable = true;   // 打个标记，页面靠它显示红条而不是空态
        return Promise.reject(e);
      }

      // 翻页取全：每页 100 条，直到把这个月翻干净。
      // 少了分页，一个月记满 100 笔以后超出的账就会「存了却看不到」。
      return queryAll(function (skip) {
        return wx.cloud.database().collection('records')
          .where({ month: month })
          .orderBy('date', 'desc')          // 先按日期倒序
          .orderBy('createdAt', 'desc')     // 同一天的话，后记的排前面
          .skip(skip)                       // 第几页从第几条开始
          .limit(CLOUD_PAGE_SIZE);
      });
    })
    .then(function (res) {
      return {
        ok: true,
        list: res.list,
        truncated: !!res.truncated          // true = 翻到 1000 条封顶了，没翻全
      };
    })
    .catch(function (err) {
      console.error('[枕江逢记账] 读云端失败', err);
      return Promise.reject(err);
    });
}

/**
 * 【查询用】本机暂存里现在压着几条账
 * 打开云开发之后，首页靠这个数字判断「还有没有旧账没搬走」
 *
 * @return Array 本地账目数组（空的就返回 []）
 */
function localRecords() {
  return localReadAll();
}

/**
 * 【重要】把之前存在「本机暂存」里的账目搬到云端
 *
 * 【为什么非做不可】
 * 云没通的时候，账目是存在这台电脑/这台手机本地的。
 * 一旦把云开发打开，读数据就只去云端读了 ——
 * 那些躺在本地的旧账目会「人间蒸发」，你以为数据丢了。
 * 其实它们只是没搬过来。所以云一通，第一件事就是把它们搬过去，搬完再清掉本地。
 *
 * 【怎么保证不会搬两遍（同一笔账存成两份）】
 * 搬的时候给每条数据盖一个「本机编号 localId」的章；
 * 搬之前先问云端「这些编号你们那有吗」，有就跳过。
 * 所以哪怕你多编译好几次、中途退出，也不会出现重复账目。
 *
 * @return Promise → { migrated: 搬了几条, skipped: 跳过几条 }
 */
function migrateLocalToCloud() {
  // 云压根没通，没什么好搬的
  if (!isCloudReady()) {
    return Promise.resolve({ migrated: 0, skipped: 0 });
  }

  const local = localReadAll();
  if (!local.length) {
    return Promise.resolve({ migrated: 0, skipped: 0 });
  }

  const cloudDb = wx.cloud.database();          // cloudDb.command 用来写「在…里面」这种查询
  const collection = cloudDb.collection('records');

  // 把本机那批编号收成一个数组，等下去云端查「这些编号有没有」
  const ids = local.map(function (item) { return item._id; });

  // 把编号切成一小段一小段（每 100 个一组）。
  // 为什么不一次性把几百个编号都塞进 in(...)：
  // 一次 in 塞太多值，数据库那边又慢又可能直接报错；
  // 更要命的是「只查一组 = 查不全已有的」，
  // 同一笔账会被再搬一遍变成重复账 —— 记账最忌讳这种凭空多出来的账。
  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) {
      out.push(arr.slice(i, i + size));
    }
    return out;
  }

  // 第 1 步：问云端「这些本机编号，你们已经有了吗」（分组查 + 分页查全）
  return Promise.all(chunk(ids, CLOUD_PAGE_SIZE).map(function (group) {
    return queryAll(function (skip) {
      return collection
        .where({ localId: cloudDb.command.in(group) })
        .skip(skip)
        .limit(CLOUD_PAGE_SIZE);
    });
  }))
    .then(function (results) {
      const already = {};
      results.forEach(function (r) {
        (r.list || []).forEach(function (d) { already[d.localId] = true; });
      });

      // 没搬过的才排队搬
      const queue = local.filter(function (item) { return !already[item._id]; });
      const total = queue.length;   // 总条数必须在搬之前先存下来
      // 注意：queue 里的元素是被 shift 出去的，搬完 queue.length 会变成 0，
      // 所以「搬了多少」只能靠这个 total 减掉失败数来算，不能拿 queue.length 减。
      let failed = 0;   // 失败计数：只要有一条没搬成就不清本地，下次还能再搬

      // 第 2 步：一条一条往云端写
      // 为什么要一条一条：云数据库一次写一条最稳，写错了影响范围也只有那一条
      function step() {
        if (!queue.length) { return Promise.resolve(); }

        const item = queue.shift();
        const copy = Object.assign({}, item);  // Object.assign 拷贝一份，避免改到原件
        delete copy._id;                       // 云端的编号由云端分配，本机编号另存成 localId
        copy.localId = item._id;               // 盖章：记下它以前在本机的编号
        copy.migratedAt = new Date();          // 什么时候搬的，以后排错用

        return collection.add({ data: copy })
          .then(step)                          // 成功了，搬下一条
          .catch(function (err) {
            // 单条失败不中断整批：不然一条坏数据会卡住全部搬家
            console.error('[枕江逢记账] 本地数据搬家时有一条失败', item._id, err);
            failed++;
            return step();
          });
      }

      return step().then(function () {
        const migrated = total - failed;   // 该搬的条数，减去真失败的那几条

        // 第 3 步：全搬成功才清掉本地，只要有一条失败就先留着
        if (failed === 0 && migrated > 0) {
          wx.removeStorageSync(LOCAL_RECORDS_KEY);
          console.log('[枕江逢记账] 本机数据已全部搬到云端，共 ' + migrated + ' 条');
        }

        return { migrated: migrated, skipped: local.length - migrated };
      });
    })
    .catch(function (err) {
      // 连「查云端有什么」都失败了，多半是没建 records 集合或权限不对，
      // 这种情况绝不能乱搬，先报出来，下次编译再试
      console.error('[枕江逢记账] 查询云端已有数据失败，本轮不搬家，下次编译再试', err);
      return { migrated: 0, skipped: 0 };
    });
}

/**
 * 一次取「好几个月」的账（趋势图专用）
 *
 * 【为什么不循环调用 getMonthRecords 六次】
 * 循环 six 次 = 六趟网络请求，慢一倍还不止。
 * 这里用 command.in 一次性问「这 6 个月的数据都给我」，一趟搞定。
 *
 * @param {Array} months 月份数组，如 ['2026-05', ..., '2026-10']
 * @return Promise → { ok:true, list:[...], truncated:Boolean }
 */
function getRecordsInMonths(months) {
  if (!isCloudReady()) {
    // 本地模式：把本地全部拿出来，再按月份筛（数据量小，够用）
    const all = localReadAll().filter(function (item) {
      return months.indexOf(item.month) !== -1;
    });
    all.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    return Promise.resolve({ ok: true, list: all, fallback: true });
  }

  const cloudDb = wx.cloud.database();

  // 同样走分页：以前写死 limit(300)，6 个月每月 50 笔就正好卡满，
  // 超出去的那几个月在趋势图上会「柱子莫名矮一截」，而且一点提示都没有。
  return queryAll(function (skip) {
    return cloudDb.collection('records')
      // in 就是「在…里面」：只要 month 是这个数组的成员就算命中
      .where({ month: cloudDb.command.in(months) })
      .orderBy('date', 'desc')
      .skip(skip)
      .limit(CLOUD_PAGE_SIZE);
  }).then(function (res) {
    return { ok: true, list: res.list, truncated: !!res.truncated };
  })
    .catch(function (err) {
      console.error('[枕江逢记账] 读云端（多月）失败', err);
      return Promise.reject(err);
    });
}

/**
 * 按编号取一笔账（详情页要用）
 *
 * @param {String} id 数据库里的唯一编号
 * @return Promise → { ok:true, list:[这条账] }
 *
 * 【本地模式】本地数据的编号是我们自己造的（local_ 开头），也照样能查
 */
function getRecordById(id) {
  if (!isCloudReady()) {
    const hit = localReadAll().filter(function (item) { return item._id === id; });
    return Promise.resolve({ ok: true, list: hit.length ? [hit[0]] : [] });
  }

  return wx.cloud.database().collection('records')
    // doc(编号) = 「按身份证号精确找一个人」，比 where 更适合拿单条
    .doc(id)
    .get()
    .then(function (res) {
      return { ok: true, list: [res.data] };
    })
    .catch(function (err) {
      // 常见原因：这笔已经在别处被删了，再点开就找不到 —— 报个能读懂的错
      console.error('[枕江逢记账] 按编号取账目失败', err);
      return Promise.reject(err);
    });
}

/**
 * 改一笔账（M4 的编辑功能）
 *
 * @param {String} id 要改哪条
 * @param {Object} rec 新内容，格式跟 addRecord 一样
 *
 * 【为什么要重算 month】
 * 如果你把日期从 9 月改成 10 月，这笔账就「换月」了。
 * month 这个字段是我们自己加的索引，不改的话它还会挂在 9 月，
 * 首页、统计图都会算错 —— 这是个很隐蔽的坑。
 */
function updateRecord(id, rec) {
  const doc = {
    type: rec.type,
    category: rec.category,
    amount: Number(rec.amount),
    note: rec.note || '',
    date: rec.date,
    month: rec.date.slice(0, 7),   // 日期改了，月份必须跟着重算
    updatedAt: new Date()
  };

  if (isCloudReady()) {
    return wx.cloud.database().collection('records')
      .doc(id)
      .update({ data: doc })
      .then(function () {
        return { ok: true };
      })
      .catch(function (err) {
        console.error('[枕江逢记账] 改账目失败', err);
        return Promise.reject(err);
      });
  }

  // ---- 本地模式：在数组里找到它，把内容换掉 ----
  const list = localReadAll();
  for (let i = 0; i < list.length; i++) {
    if (list[i]._id === id) {
      // Object.assign 把新内容盖到旧对象上，旧的本地编号 _id 保持不变
      list[i] = Object.assign({}, list[i], doc);
      break;
    }
  }
  localWriteAll(list);
  return Promise.resolve({ ok: true });
}

/**
 * 删一笔账（M4 的删除功能）
 *
 * 【为什么是「点一下删一条」而不是「批量删」】
 * 删除是不可逆的，做成单条最稳：删错了还能从云控制台手动补回来一条，
 * 批量删一旦误触就是一大片，没法回滚。
 */
function deleteRecord(id) {
  if (isCloudReady()) {
    return wx.cloud.database().collection('records')
      .doc(id)
      .remove()
      .then(function () {
        return { ok: true };
      })
      .catch(function (err) {
        console.error('[枕江逢记账] 删账目失败', err);
        return Promise.reject(err);
      });
  }

  // ---- 本地模式：把它从数组里踢掉再存回去 ----
  const rest = localReadAll().filter(function (item) { return item._id !== id; });
  localWriteAll(rest);
  return Promise.resolve({ ok: true });
}

/**
 * 清空全部账目（M6 的「清空数据」+「撤回同意」都走这里）
 *
 * 【两个关键约束，都是微信定死的】
 * 1. 小程序端一次最多删 1000 条，我们一个月几十条，远远够用；
 * 2. records 集合的权限是「仅创建者可读写」，所以这个删除只可能删到你自己记的账，
 * 不会误伤别人的数据。
 *
 * @return Promise → { deleted: 删了几条 }
 */
function deleteAllRecords() {
  // 本地模式：压根就没有云数据，把本机那份清掉即可
  if (!isCloudReady()) {
    const had = localReadAll().length;
    wx.removeStorageSync(LOCAL_RECORDS_KEY);
    return Promise.resolve({ deleted: had });
  }

  // where({}) = 「全部」，remove() = 一次性批量删
  return wx.cloud.database().collection('records')
    .where({})
    .remove()
    .then(function (res) {
      // 返回结构里带 stats.removed，就是真正删掉的行数
      const removed = res && res.stats && res.stats.removed ? res.stats.removed : 0;
      console.log('[枕江逢记账] 已清空云端账目 ' + removed + ' 条');
      return { deleted: removed };
    })
    .catch(function (err) {
      console.error('[枕江逢记账] 清空账目失败', err);
      return Promise.reject(err);
    });
}

/**
 * 统计当前一共记了多少笔（「我的」页要用）
 * 云：用 count 让数据库自己数，比拉数据回来数快得多，也不用占流量
 */
function countRecords() {
  if (!isCloudReady()) {
    return Promise.resolve({ count: localReadAll().length });
  }

  return wx.cloud.database().collection('records')
    .where({})
    .count()
    .then(function (res) {
      return { count: res.total || 0 };
    })
    .catch(function (err) {
      console.error('[枕江逢记账] 统计账目条数失败', err);
      return Promise.resolve({ count: 0 });
    });
}

/**
 * 读月预算
 * 预算是「我的设置」，跟账目分开存，这样以后加新设置（比如分类、图标）不会互相打架。
 * 存本地就够用：一个人只在一台手机上看自己的预算，多设备同步是第二版的事。
 */
function getBudget() {
  try {
    const saved = wx.getStorageSync(LOCAL_BUDGET_KEY);
    return saved ? Number(saved) : config.DEFAULT_BUDGET;
  } catch (e) {
    return config.DEFAULT_BUDGET;
  }
}

/**
 * 写月预算
 */
function setBudget(value) {
  wx.setStorageSync(LOCAL_BUDGET_KEY, Number(value));
}

module.exports = {
  isCloudReady,
  isCloudSick,
  getCloudState,
  probeCloud,
  logMode,
  localRecords,
  migrateLocalToCloud,
  addRecord,
  getRecordById,
  updateRecord,
  deleteRecord,
  deleteAllRecords,
  countRecords,
  getMonthRecords,
  getRecordsInMonths,
  getBudget,
  setBudget
};
