'use strict';

/**
 * 前端 wx 全局模拟层
 *
 * 目标：让 miniprogram 下的 utils/services 原样运行。
 * - storage：内存 Map，完整还原 wx.getStorageSync 语义（无值返回 ''）
 * - cloud.callFunction：派发到 mock-sdk registry 里注册的云函数，
 *   返回 { result } 形态（与微信真实行为一致，utils/cloud.js 取 res.result）
 * - 所有 UI 反馈 API 记录到 calls，供断言
 */

const mockSdk = require('./mock-sdk.js');

function createWxEnv({ cloudFailTimes = 0 } = {}) {
  const storage = new Map();
  const calls = {
    toast: [],
    loading: [],      // ['show', opts] / ['hide']
    modal: [],
    navigate: [],
    login: 0,
    share: []
  };

  let failRemaining = cloudFailTimes;

  const wx = {
    // ---- storage ----
    getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
    setStorageSync: (k, v) => { storage.set(k, v); },
    removeStorageSync: (k) => { storage.delete(k); },
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }),

    // ---- UI ----
    showToast: (o) => { calls.toast.push(o); },
    showLoading: (o) => { calls.loading.push(['show', o]); },
    hideLoading: () => { calls.loading.push(['hide']); },
    showModal: (o) => {
      calls.modal.push(o);
      if (o.success) o.success({ confirm: true });
    },
    setNavigationBarTitle: () => {},
    navigateTo: (o) => { calls.navigate.push(['navigateTo', o.url]); },
    redirectTo: (o) => { calls.navigate.push(['redirectTo', o.url]); },
    navigateBack: () => { calls.navigate.push(['navigateBack']); },

    // ---- 登录 ----
    login: (o) => {
      calls.login += 1;
      if (o && o.success) o.success({ code: 'mock-code' });
    },

    // ---- 云能力 ----
    cloud: {
      init: () => {},
      callFunction: async ({ name, data }) => {
        if (failRemaining > 0) {
          failRemaining -= 1;
          throw { errMsg: 'cloud.callFunction:fail 模拟网络错误' };
        }
        const fn = mockSdk.__mock.state.registry[name];
        if (!fn) throw new Error('mock-wx: 云函数未注册: ' + name);
        const result = await fn(data || {});
        return { result };
      }
    }
  };

  return {
    wx,
    calls,
    storage,
    /** 手动把 wx 挂到 global（加载 miniprogram 模块前调用） */
    install() {
      global.wx = wx;
      return wx;
    },
    /** getApp 模拟：globalData 可注入 config/openid */
    installApp(globalData = {}) {
      const app = { globalData };
      global.getApp = () => app;
      return app;
    }
  };
}

/** 清理 global，保证测试间互不污染 */
function uninstall() {
  delete global.wx;
  delete global.getApp;
}

module.exports = { createWxEnv, uninstall };
