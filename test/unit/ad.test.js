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

test('currentSlot：4 点 / 12 点 / 18 点分界正确（凌晨 0~4 点属晚上）', () => {
  assert.equal(ad.currentSlot(cst('2026-09-08 03:59')), 2, '凌晨 4 点前仍属前一晚');
  assert.equal(ad.currentSlot(cst('2026-09-08 04:00')), 0);
  assert.equal(ad.currentSlot(cst('2026-09-08 11:59')), 0);
  assert.equal(ad.currentSlot(cst('2026-09-08 12:00')), 1);
  assert.equal(ad.currentSlot(cst('2026-09-08 17:59')), 1);
  assert.equal(ad.currentSlot(cst('2026-09-08 18:00')), 2);
  assert.equal(ad.currentSlot(cst('2026-09-08 23:59')), 2);
  assert.equal(ad.currentSlot(cst('2026-09-09 00:30')), 2, '跨午夜仍属晚上时段');
});

test('todayStr：东八区跨天正确（UTC 17 点已是次日）', () => {
  // UTC 2026-09-08T17:00Z = 东八 2026-09-09 01:00
  assert.equal(ad.todayStr(Date.parse('2026-09-08T17:00:00Z')), '2026-09-09');
  assert.equal(ad.todayStr(cst('2026-09-08 23:59')), '2026-09-08');
});

test('slotDayStr：业务日以 04:00 为界（凌晨属前一业务日）', () => {
  assert.equal(ad.slotDayStr(cst('2026-09-08 23:00')), '2026-09-08');
  assert.equal(ad.slotDayStr(cst('2026-09-09 01:30')), '2026-09-08', '凌晨 1 点半仍属 8 号的晚上时段');
  assert.equal(ad.slotDayStr(cst('2026-09-09 03:59')), '2026-09-08');
  assert.equal(ad.slotDayStr(cst('2026-09-09 04:00')), '2026-09-09', '4 点整翻新为 9 号');
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

  assert.equal(await play(cst('2026-09-08 08:00')), true);   // 上午（04~12 点）
  assert.equal(await play(cst('2026-09-08 14:00')), true);   // 下午（12~18 点）
  assert.equal(await play(cst('2026-09-08 20:00')), true);   // 晚上（18 点~次日 4 点）
  assert.equal(await play(cst('2026-09-08 21:00')), false);  // 晚上第二次被拦
  assert.equal(await play(cst('2026-09-09 01:30')), false, '跨午夜凌晨仍属同一晚上时段');
  assert.equal(created.length, 3, '一个业务日恰好三次');
});

test('tryShowOpenInterstitial：凌晨 4 点业务日翻新，频控失效', async () => {
  installApp({ config: { ad_interstitial: 'adunit-i1' } });
  const created = installInterstitialAd();

  const play = async (ts) => {
    const p = ad.tryShowOpenInterstitial(ts);
    created[created.length - 1]._cbs.load.forEach((fn) => fn());
    created[created.length - 1]._cbs.close.forEach((fn) => fn());
    return p;
  };

  assert.equal(await play(cst('2026-09-08 20:00')), true, '8 号晚上');
  assert.equal(await play(cst('2026-09-09 03:00')), false, '次日凌晨 3 点仍属 8 号晚上');
  assert.equal(await play(cst('2026-09-09 04:30')), true, '凌晨 4 点半翻新，新业务日重新可弹');
});

test('tryShowOpenInterstitial：加载失败（show 报错）不记频控', async () => {
  installApp({ config: { ad_interstitial: 'adunit-i1' } });
  installInterstitialAd({ failShow: true });

  const now = cst('2026-09-08 09:00');
  assert.equal(await ad.tryShowOpenInterstitial(now), false);
  // 失败不消耗频控，紧接着再试仍会尝试
  assert.equal(await ad.tryShowOpenInterstitial(now), false);
});

test('tryShowOpenInterstitial：3 小时全局冷却，跨时段也不弹', async () => {
  installApp({ config: { ad_interstitial: 'adunit-i1' } });
  const created = installInterstitialAd();

  const play = async (ts) => {
    const p = ad.tryShowOpenInterstitial(ts);
    created[created.length - 1]._cbs.load.forEach((fn) => fn());
    created[created.length - 1]._cbs.close.forEach((fn) => fn());
    return p;
  };

  assert.equal(await play(cst('2026-09-08 11:00')), true, '上午展示');

  // 12:30 已进入下午时段（时段频控放行），但距上次仅 1.5h → 冷却拦截
  assert.equal(await play(cst('2026-09-08 12:30')), false, '3 小时冷却期内');
  assert.equal(created.length, 1);

  // 14:30 距上次 3.5h，下午时段未弹过 → 放行
  assert.equal(await play(cst('2026-09-08 14:30')), true, '冷却期满且新时段');
  assert.equal(created.length, 2);
});

test('tryShowOpenInterstitial：恰好 3 小时按冷却内处理，3h+1min 放行', async () => {
  installApp({ config: { ad_interstitial: 'adunit-i1' } });
  const created = installInterstitialAd();

  const play = async (ts) => {
    const p = ad.tryShowOpenInterstitial(ts);
    created[created.length - 1]._cbs.load.forEach((fn) => fn());
    created[created.length - 1]._cbs.close.forEach((fn) => fn());
    return p;
  };

  assert.equal(await play(cst('2026-09-08 09:00')), true, '上午展示');
  // 恰好 3 小时整（12:00）：满 3h 视为冷却期满，且下午时段未弹过 → 放行
  // （「3 小时内不弹」的严格内含边界：冷却判断为 now-last < 3h）
  assert.equal(await play(cst('2026-09-08 12:00')), true, '恰好满 3h 放行');
  assert.equal(created.length, 2);
});

// ---------- 调试面板：force 展示 + 状态查询 ----------

test('tryShowOpenInterstitial：force 跳过冷却与时段频控，启用门禁仍生效', async () => {
  installApp({ config: { ad_interstitial: 'adunit-i1' } });
  const created = installInterstitialAd();

  const play = async (ts, opts) => {
    const p = ad.tryShowOpenInterstitial(ts, opts);
    const inst = created[created.length - 1];
    inst._cbs.load.forEach((fn) => fn());
    inst._cbs.close.forEach((fn) => fn());
    return p;
  };

  assert.equal(await play(cst('2026-09-08 09:00')), true);
  // 同日同时段 + 冷却期内：非 force 被拦，force 放行
  assert.equal(await play(cst('2026-09-08 09:10')), false);
  assert.equal(await play(cst('2026-09-08 09:10'), { force: true }), true);
  assert.equal(created.length, 2);

  // force 下成功展示同样记录频控
  assert.equal(ad.interstitialState(cst('2026-09-08 09:10')).cooldownRemain > 0, true);
});

test('tryShowOpenInterstitial：审核模式下 force 也被门禁拦住', async () => {
  installApp({ config: { ad_interstitial: 'adunit-i1' }, isAuditMode: true });
  installInterstitialAd();

  assert.equal(await ad.tryShowOpenInterstitial(cst('2026-09-08 09:00'), { force: true }), false);
});

test('interstitialState：返回启用/冷却/时段状态', () => {
  installApp({ config: { ad_interstitial: 'adunit-i1' } });

  const before = ad.interstitialState(cst('2026-09-08 09:00'));
  assert.equal(before.enabled, true);
  assert.equal(before.slot, 0);
  assert.equal(before.slotShown, false);
  assert.equal(before.cooldownRemain, 0);

  // 展示后：时段标记 + 冷却倒计时
  const created = installInterstitialAd();
  const p = ad.tryShowOpenInterstitial(cst('2026-09-08 09:00'));
  created[0]._cbs.load.forEach((fn) => fn());
  created[0]._cbs.close.forEach((fn) => fn());
  return p.then(() => {
    const after = ad.interstitialState(cst('2026-09-08 09:30'));
    assert.equal(after.slotShown, true);
    assert.equal(after.cooldownRemain > 0, true);
    const expired = ad.interstitialState(cst('2026-09-08 12:01'));
    assert.equal(expired.cooldownRemain, 0, '满 3 小时冷却归零');
    assert.equal(expired.slot, 1, '12 点后进入下午时段');
    assert.equal(expired.slotShown, false, '下午时段未弹');
  });
});
