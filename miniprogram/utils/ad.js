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

module.exports = { normalizeAdUnitId, bannerId, getVideoAd, showVideoAd, _reset };
