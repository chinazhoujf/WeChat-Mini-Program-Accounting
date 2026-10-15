/**
 * app.js —— 小程序全局入口（整个项目只执行一次）
 *
 * 大白话：这是「小程序启动时要做的事」清单。
 * 我们只做一件事：告诉微信「我的云开发环境是哪个」（云初始化）。
 * 这一步做成了，后面每个页面才能读写云端数据库。
 */

const config = require('./config.js');
const db = require('./utils/db.js');

App({

  // onLaunch = 小程序刚启动、还没打开任何页面时执行
  onLaunch: function () {

    // 【情况 1】还没拿到云环境 ID（比如刚导入项目还没开通云开发）
    // 我们不报错、不让小程序白屏，只是打印一行日志提醒。
    // 这样即使云没通，页面照样能打开，你不会看到一片空白。
    if (!config.CLOUD_ENV) {
      console.error('[枕江逢记账] 还没填云环境 ID，云功能暂时不可用。'
        + '等你在开发者工具里开通云开发后，把环境 ID 发给我，我写进 config.js 就可以了。');
      return;
    }

    // 【情况 2】 wx.cloud 不存在 —— 说明这个小程序项目没启用云开发
    if (!wx.cloud) {
      console.error('[枕江逢记账] 当前项目没启用云开发。'
        + '解决：在微信开发者工具「工具栏左侧」点「云开发」按钮开通即可'
        + '（官方文档原话：在开发者工具的工具栏左侧，点击「云开发」按钮即可打开云控制台）。'
        + '如果按钮是灰的，说明导入项目时「后端服务」还停在「不使用云服务」，'
        + '需要重新导入一次并在那一栏选「微信云开发」。');
      return;
    }

    // 【情况 3】 一切正常：初始化云开发
    // env 就是「用哪个云环境」，相当于告诉微信去哪间屋子拿数据
    wx.cloud.init({
      env: config.CLOUD_ENV,   // 云环境 ID
      traceUser: true          // 记录用户访问痕迹（调试用，对我们没必要，开着无害）
    });

    console.log('[枕江逢记账] 云开发初始化成功');

    // 【数据搬家】把之前存在本机暂存里的旧账目搬到云端。
    // 这一步在「云初始化成功」之后跑，顺序不能反 —— 云还没 init，数据是写不进去的。
    db.migrateLocalToCloud().then(function (r) {
      if (r.migrated > 0) {
        console.log('[枕江逢记账] 已把本机 ' + r.migrated + ' 条账目搬到云端');
      }
    }).catch(function (err) {
      console.error('[枕江逢记账] 本机数据搬家异常（不影响正常使用）', err);
    });
  },

  // globalData = 全项目共用的小数据（目前先用不上，留个位置给以后）
  globalData: {
    // userInfo: null
  }
});
