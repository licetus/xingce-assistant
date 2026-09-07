/**
 * 流量主广告统一接入
 *
 * 设计原则（与项目架构约束一致）：
 *
 * 1. 广告位 ID 不写死——走 config 集合下发（login.config），控制台改配置即时生效。
 *    ID 为空或格式不对 → 一律视为「未启用」，页面不渲染广告容器，
 *    流量主未开通时整个功能自然静默，不会白屏报错。
 *
 * 2. 审核模式（audit_mode=true）下广告整体禁用（app.canShow('ad')），
 *    提审时避免广告内容不可控带来审核风险，过审后云端关掉开关即恢复。
 *
 * 3. 所有广告失败路径（拉取失败、播放中断、基础库不支持）都必须静默降级，
 *    广告永远不能打断刷题主流程——这是工具类小程序的底线。
 *
 * 合规红线（平台审核重点）：
 * - 不得诱导点击广告、不得在广告上叠加任何浮层或遮挡
 * - 激励视频奖励必须真实发放，看完才给（isEnded 判断）
 * - 「查看广告解锁 XX」文案不得使用「点击领取」等误导表述
 */

/** 校验广告位 ID 格式：微信流量主广告位 ID 固定 adunit- 前缀 */
function normalizeAdUnitId(v) {
  return typeof v === 'string' && v.indexOf('adunit-') === 0 ? v : '';
}

/**
 * 读取 Banner 广告位 ID
 * @param {string} key config 里的字段名，默认 ad_banner_home（首页底部）
 * @returns {string} 合法 ID 或 ''（未启用）
 */
function bannerId(key = 'ad_banner_home') {
  const app = typeof getApp === 'function' ? getApp() : null;
  if (!app || !app.canShow || !app.canShow('ad')) return '';

  const config = (app.globalData && app.globalData.config) || {};
  return normalizeAdUnitId(config[key]);
}

let _videoAd = null;
let _videoAdId = null;

/**
 * 激励视频广告单例
 * 同一 adUnitId 复用实例（官方要求：重复 create 会重复扣展示配额的坑）。
 * @returns {object|null} RewardedVideoAd 实例；未启用或基础库不支持时返回 null
 */
function getVideoAd() {
  const id = bannerId('ad_video');
  if (!id || typeof wx === 'undefined' || !wx.createRewardedVideoAd) return null;

  if (_videoAd && _videoAdId === id) return _videoAd;
  if (_videoAd && _videoAdId !== id) {
    // 配置热更换了广告位：旧实例销毁重建
    try { _videoAd.destroy(); } catch (e) { /* 老基础库无 destroy，忽略 */ }
    _videoAd = null;
  }

  _videoAd = wx.createRewardedVideoAd({ adUnitId: id });
  _videoAdId = id;
  // 拉取失败静默：广告组件的任何异常都不应打扰用户
  _videoAd.onError(() => {});
  return _videoAd;
}

/**
 * 展示激励视频
 * @returns {Promise<boolean>} true = 完整观看（应发放奖励）；false = 未看完/中断/失败/未启用
 */
function showVideoAd() {
  return new Promise((resolve) => {
    const ad = getVideoAd();
    if (!ad) return resolve(false);

    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      ad.offClose(onClose);
      resolve(result);
    };
    const onClose = (res) => done(!!(res && res.isEnded));

    ad.onClose(onClose);
    ad.show().catch(() => {
      // 冷启动后首次 show 常因广告未拉取完毕失败，官方建议二次拉起
      ad.show().then(
        () => {},
        () => done(false)
      );
    });
  });
}

/** 重置单例（测试用） */
function _reset() {
  _videoAd = null;
  _videoAdId = null;
}

// ---------- 插屏广告（开启时展示，每日每时段最多 1 次） ----------

const cache = require('./cache');

const ISLOT_PREFIX = 'ad_islot_';
const ILAST_KEY = 'ad_ilast';
/** 全局冷却：展示后 3 小时内不再弹第二次（跨时段也生效，与时段频控叠加） */
const ILAST_COOLDOWN = 3 * cache.HOUR;

/** 插屏广告位 ID（config.ad_interstitial，空 = 未启用） */
function interstitialId() {
  return bannerId('ad_interstitial');
}

/**
 * 当前时段编号（东八区）：
 * 0 = 04:00~12:00（上午）  1 = 12:00~18:00（下午）  2 = 18:00~次日04:00（晚上）
 * 每日三次插屏以 4 点 / 12 点 / 18 点为分界线，每时段最多展示 1 次
 */
function currentSlot(now = Date.now()) {
  const h = new Date(now + 8 * 60 * 60 * 1000).getUTCHours();
  return h >= 4 && h < 12 ? 0 : h >= 12 && h < 18 ? 1 : 2;
}

/**
 * 「业务日」日期串（东八区）：凌晨 0~4 点属于前一天的晚上时段，
 * 所以业务日以 04:00 为界——把时间戳回拨 4 小时再取东八区日期。
 * 这样 23:50 与次日 01:30 同属一个晚上时段，共用同一把频控锁。
 */
function slotDayStr(now = Date.now()) {
  return todayStr(now - 4 * 60 * 60 * 1000);
}

/** 东八区日期串（ISO 截取法：先加 8 小时再取 UTC 日期，与 buildGreeting 同款手法） */
function todayStr(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * 尝试展示「开启时」插屏广告（app.onShow 与 bootstrap 完成时调用）
 *
 * 触发规则：
 * - config.ad_interstitial 为空 / 审核模式 → 不弹
 * - 3 小时内已展示过 → 不弹（全局冷却，跨时段生效）
 * - 当前时段（上午/下午/晚上）已弹过 → 不弹（全天最多 3 次，频控记在本地 storage）
 * - 插屏实例展示后即失效，每次都新建；加载失败/无填充静默放弃
 *
 * @param {number} now 当前时间戳（测试注入用）
 * @param {object} [opts] opts.force=true 跳过冷却与时段频控（调试面板用），启用/审核门禁仍然生效
 * @returns {Promise<boolean>} true = 本次实际展示了
 */
function tryShowOpenInterstitial(now = Date.now(), opts = {}) {
  const id = interstitialId();
  if (!id) return Promise.resolve(false);

  const slotKey = ISLOT_PREFIX + slotDayStr(now) + '_' + currentSlot(now);

  if (!opts.force) {
    // 冷却：3 小时内弹过就跳过（不区分时段，防高频打扰——插屏审核红线）
    const last = cache.get(ILAST_KEY, 0);
    if (now - last < ILAST_COOLDOWN) return Promise.resolve(false);

    // 频控：业务日 + 当前时段已展示过则跳过（key 含业务日，04 点翻新自然失效）
    if (cache.get(slotKey, null)) return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    if (typeof wx === 'undefined' || !wx.createInterstitialAd) {
      return resolve(false);
    }

    let settled = false;
    const finish = (shown) => {
      if (settled) return;
      settled = true;
      if (shown) {
        cache.set(slotKey, 1, 24 * cache.HOUR);
        cache.set(ILAST_KEY, now, ILAST_COOLDOWN);
      }
      resolve(shown);
    };

    let ad;
    try {
      ad = wx.createInterstitialAd({ adUnitId: id });
    } catch (err) {
      return finish(false);
    }

    ad.onError(() => finish(false));
    ad.onClose(() => finish(true));
    // 官方语义：未加载完成时 show 会失败，等 onLoad 再拉起
    ad.onLoad(() => {
      ad.show().catch(() => finish(false));
    });

    // 兜底：8 秒仍未加载完成视为无填充，放弃（插屏正常加载是秒级）
    setTimeout(() => finish(false), 8000);
  });
}

/**
 * 插屏当前频控状态（调试面板展示用）
 * @returns {{enabled:boolean, id:string, cooldownRemain:number, slot:number, slotShown:boolean}}
 */
function interstitialState(now = Date.now()) {
  const id = interstitialId();
  const last = cache.get(ILAST_KEY, 0);
  const slot = currentSlot(now);
  const slotShown = !!cache.get(ISLOT_PREFIX + slotDayStr(now) + '_' + slot, null);
  return {
    enabled: !!id,
    id,
    cooldownRemain: Math.max(0, ILAST_COOLDOWN - (now - last)),
    slot,
    slotShown
  };
}

module.exports = {
  normalizeAdUnitId,
  bannerId,
  getVideoAd,
  showVideoAd,
  interstitialId,
  interstitialState,
  currentSlot,
  todayStr,
  slotDayStr,
  tryShowOpenInterstitial,
  _reset
};
