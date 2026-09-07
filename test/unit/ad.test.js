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
  env.storage.clear(); // storage 跨用例共享，频控 key 必须逐用例清零
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

// ---------- 开启时插屏（每日三时段频控） ----------

/** mock 插屏广告实例：手动触发 load/close 事件 */
function installInterstitialAd({ failShow = false } = {}) {
  const created = [];
  env.wx.createInterstitialAd = ({ adUnitId }) => {
    const inst = {
      adUnitId,
      showCount: 0,
      _cbs: { load: [], error: [], close: [] },
      onLoad(fn) { inst._cbs.load.push(fn); },
      offLoad() {},
      onError(fn) { inst._cbs.error.push(fn); },
      offError() {},
      onClose(fn) { inst._cbs.close.push(fn); },
      offClose() {},
      show() {
        inst.showCount += 1;
        if (failShow) return Promise.reject(new Error('not loaded'));
        return Promise.resolve();
      }
    };
    created.push(inst);
    return inst;
  };
  return created;
}

/** 东八区时间戳构造：'2026-09-08 11:59' */
function cst(ts) {
  return new Date(ts.replace(' ', 'T') + '+08:00').getTime();
}

test('currentSlot：12 点 / 18 点分界正确', () => {
  assert.equal(ad.currentSlot(cst('2026-09-08 00:00')), 0);
  assert.equal(ad.currentSlot(cst('2026-09-08 11:59')), 0);
  assert.equal(ad.currentSlot(cst('2026-09-08 12:00')), 1);
  assert.equal(ad.currentSlot(cst('2026-09-08 17:59')), 1);
  assert.equal(ad.currentSlot(cst('2026-09-08 18:00')), 2);
  assert.equal(ad.currentSlot(cst('2026-09-08 23:59')), 2);
});

test('todayStr：东八区跨天正确（UTC 17 点已是次日）', () => {
  // UTC 2026-09-08T17:00Z = 东八 2026-09-09 01:00
  assert.equal(ad.todayStr(Date.parse('2026-09-08T17:00:00Z')), '2026-09-09');
  assert.equal(ad.todayStr(cst('2026-09-08 23:59')), '2026-09-08');
});

test('tryShowOpenInterstitial：未配置 / 审核模式 → 不弹', async () => {
  installApp({ config: {} });
  assert.equal(await ad.tryShowOpenInterstitial(), false);

  installApp({ config: { ad_interstitial: 'adunit-i1' }, isAuditMode: true });
  assert.equal(await ad.tryShowOpenInterstitial(), false);
});

test('tryShowOpenInterstitial：加载展示关闭成功 → true 并记频控，同日同时段第二次不弹', async () => {
  installApp({ config: { ad_interstitial: 'adunit-i1' } });
  const created = installInterstitialAd();

  const now = cst('2026-09-08 09:00');
  const p = ad.tryShowOpenInterstitial(now);
  created[0]._cbs.load.forEach((fn) => fn());   // 加载完成触发 show
  created[0]._cbs.close.forEach((fn) => fn());  // 用户关闭
  assert.equal(await p, true);
  assert.equal(created[0].showCount, 1);

  // 同日同时段：频控拦截，不创建新实例
  const second = await ad.tryShowOpenInterstitial(now + 60 * 1000);
  assert.equal(second, false);
  assert.equal(created.length, 1);
});

test('tryShowOpenInterstitial：跨时段可再弹（一天最多三次由三时段自然约束）', async () => {
  installApp({ config: { ad_interstitial: 'adunit-i1' } });
  const created = installInterstitialAd();

  const play = async (ts) => {
    const p = ad.tryShowOpenInterstitial(ts);
    const inst = created[created.length - 1];
    inst._cbs.load.forEach((fn) => fn());
    inst._cbs.close.forEach((fn) => fn());
    return p;
  };

  assert.equal(await play(cst('2026-09-08 08:00')), true);  // 上午
  assert.equal(await play(cst('2026-09-08 14:00')), true);  // 下午
  assert.equal(await play(cst('2026-09-08 20:00')), true);  // 晚上
  assert.equal(await play(cst('2026-09-08 21:00')), false); // 晚上第二次被拦
  assert.equal(created.length, 3, '全天恰好三次');
});

test('tryShowOpenInterstitial：跨天频控自动失效', async () => {
  installApp({ config: { ad_interstitial: 'adunit-i1' } });
  const created = installInterstitialAd();

  const play = async (ts) => {
    const p = ad.tryShowOpenInterstitial(ts);
    created[created.length - 1]._cbs.load.forEach((fn) => fn());
    created[created.length - 1]._cbs.close.forEach((fn) => fn());
    return p;
  };

  assert.equal(await play(cst('2026-09-08 09:00')), true);
  assert.equal(await play(cst('2026-09-09 09:00')), true, '次日同时段应重新可弹');
});

test('tryShowOpenInterstitial：加载失败（show 报错）不记频控', async () => {
  installApp({ config: { ad_interstitial: 'adunit-i1' } });
  installInterstitialAd({ failShow: true });

  const now = cst('2026-09-08 09:00');
  assert.equal(await ad.tryShowOpenInterstitial(now), false);
  // 失败不消耗频控，紧接着再试仍会尝试
  assert.equal(await ad.tryShowOpenInterstitial(now), false);
});
