'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createWxEnv, uninstall } = require('../helpers/mock-wx.js');

const env = createWxEnv();
env.install();

/** 模块每次用例后重载，清掉内部单例状态 */
let ad;
function freshAd() {
  delete require.cache[require.resolve('../../miniprogram/utils/ad.js')];
  ad = require('../../miniprogram/utils/ad.js');
}

/** mock getApp：模拟 app.js 的 globalData.config + canShow */
function installApp({ config = {}, isAuditMode = false } = {}) {
  global.getApp = () => ({
    globalData: { config },
    canShow: (key) => {
      if (!isAuditMode) return true;
      return ['rank', 'invite', 'reward', 'ad'].indexOf(key) === -1;
    }
  });
}

/** mock wx.createRewardedVideoAd，记录实例与调用 */
function installVideoAd({ failShow = false } = {}) {
  const created = [];
  env.wx.createRewardedVideoAd = ({ adUnitId }) => {
    const listeners = { close: [], error: [] };
    const inst = {
      adUnitId,
      destroyed: false,
      showCount: 0,
      onError(fn) { listeners.error.push(fn); },
      offError() {},
      onClose(fn) { listeners.close.push(fn); },
      offClose(fn) {
        const i = listeners.close.indexOf(fn);
        if (i >= 0) listeners.close.splice(i, 1);
      },
      destroy() { inst.destroyed = true; },
      show() {
        inst.showCount += 1;
        if (failShow) return Promise.reject(new Error('show fail'));
        inst._closeListeners = listeners.close;
        return Promise.resolve();
      },
      _listeners: listeners
    };
    created.push(inst);
    return inst;
  };
  return created;
}

beforeEach(() => {
  freshAd();
  ad._reset();
  uninstall();
  env.install();
  delete global.getApp;
});

// ---------- normalizeAdUnitId ----------

test('normalizeAdUnitId：仅接受 adunit- 前缀字符串', () => {
  assert.equal(ad.normalizeAdUnitId('adunit-abc123'), 'adunit-abc123');
  assert.equal(ad.normalizeAdUnitId(''), '');
  assert.equal(ad.normalizeAdUnitId(null), '');
  assert.equal(ad.normalizeAdUnitId('banner-placeholder'), '');
  assert.equal(ad.normalizeAdUnitId('adunitx-bad'), '');
});

// ---------- bannerId ----------

test('bannerId：getApp 不存在 / config 为空 / ID 非法 → 未启用', () => {
  delete global.getApp;
  assert.equal(ad.bannerId(), '');

  installApp({ config: {} });
  assert.equal(ad.bannerId(), '');

  installApp({ config: { ad_banner_home: '' } });
  assert.equal(ad.bannerId(), '');

  installApp({ config: { ad_banner_home: 'placeholder' } });
  assert.equal(ad.bannerId(), '');
});

test('bannerId：合法 ID 正常返回；审核模式下强制禁用', () => {
  installApp({ config: { ad_banner_home: 'adunit-home001' } });
  assert.equal(ad.bannerId(), 'adunit-home001');

  // 审核模式：即使配置了 ID 也不出广告
  installApp({ config: { ad_banner_home: 'adunit-home001' }, isAuditMode: true });
  assert.equal(ad.bannerId(), '');
});

test('bannerId：支持自定义 config key（激励视频位）', () => {
  installApp({ config: { ad_video: 'adunit-video001' } });
  assert.equal(ad.bannerId('ad_video'), 'adunit-video001');
});

// ---------- getVideoAd ----------

test('getVideoAd：未启用返回 null；单例复用；换 ID 重建', () => {
  installApp({ config: {} });
  assert.equal(ad.getVideoAd(), null);

  const created = installVideoAd();
  installApp({ config: { ad_video: 'adunit-v1' } });
  const a1 = ad.getVideoAd();
  const a2 = ad.getVideoAd();
  assert.equal(created.length, 1, '同一 ID 应复用单例');
  assert.equal(a1, a2);

  installApp({ config: { ad_video: 'adunit-v2' } });
  const a3 = ad.getVideoAd();
  assert.equal(created.length, 2, 'ID 变更应重建实例');
  assert.notEqual(a3, a1);
  assert.equal(a1.destroyed, true, '旧实例应销毁');
});

// ---------- showVideoAd ----------

test('showVideoAd：完整观看 resolve(true)，中途关闭 resolve(false)', async () => {
  installApp({ config: { ad_video: 'adunit-v' } });
  installVideoAd();

  const p1 = ad.showVideoAd();
  const inst = ad.getVideoAd();
  inst._closeListeners.forEach((fn) => fn({ isEnded: true }));
  assert.equal(await p1, true);

  const p2 = ad.showVideoAd();
  ad.getVideoAd()._closeListeners.forEach((fn) => fn({ isEnded: false }));
  assert.equal(await p2, false);
});

test('showVideoAd：show 失败（含二次拉起失败）resolve(false)', async () => {
  installApp({ config: { ad_video: 'adunit-v' } });
  installVideoAd({ failShow: true });

  assert.equal(await ad.showVideoAd(), false);
  assert.equal(ad.getVideoAd().showCount, 2, '首次失败应重试一次');
});

test('showVideoAd：未启用 / 基础库不支持 → resolve(false)', async () => {
  installApp({ config: {} });
  assert.equal(await ad.showVideoAd(), false);

  installApp({ config: { ad_video: 'adunit-v' } });
  delete env.wx.createRewardedVideoAd;
  assert.equal(await ad.showVideoAd(), false);
});
