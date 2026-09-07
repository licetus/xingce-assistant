'use strict';

/**
 * 用户隐私保护指引授权
 *
 * 平台规则（基础库 2.32.3+ 强制）：
 * - 小程序调用隐私接口（头像昵称、相册、位置等）前，若用户未同意
 *   《用户隐私保护指引》，平台会拦截该调用。
 * - 平台默认会在隐私接口被调用时自动弹官方弹窗；而 wx.requirePrivacyAuthorize
 *   是「主动拉起授权」的入口，能拿到明确的成功/失败回调，
 *   用于「用户拒绝就静默中止」的业务分支（如保存海报到相册）。
 * - 基础库 < 2.32.3 没有这组 API，旧版微信不强制隐私弹窗，
 *   直接放行即可（相册等 scope 授权仍由具体接口自己弹）。
 *
 * 注意：本模块只处理「隐私协议」授权；wx.saveImageToPhotosAlbum 的
 * scope.writePhotosAlbum 拒绝后的去设置页引导，仍由调用方自己处理。
 */

const REQUIRED_BASE_LIB = '2.32.3';

/** 当前基础库是否支持隐私授权 API */
function supported() {
  return (
    typeof wx.getPrivacySetting === 'function' &&
    typeof wx.requirePrivacyAuthorize === 'function'
  );
}

/**
 * 读取隐私授权状态。
 * 低版本返回 { needAuthorization: false, unsupported: true }，调用方可据此隐藏相关 UI。
 * 查询失败按「无需授权」放行——不能因为平台接口抖动把用户挡在功能外面。
 */
function getSetting() {
  if (!supported()) {
    return Promise.resolve({ needAuthorization: false, unsupported: true });
  }
  return new Promise((resolve) => {
    wx.getPrivacySetting({
      success: (res) =>
        resolve({
          needAuthorization: !!res.needAuthorization,
          privacyContractName: res.privacyContractName || '用户隐私保护指引',
          unsupported: false
        }),
      fail: () => resolve({ needAuthorization: false, unsupported: false })
    });
  });
}

/**
 * 确保隐私已授权，敏感操作（保存相册等）前调用。
 * 已授权时立即成功；未授权时拉起平台弹窗。
 * 返回 true=可以继续；false=用户拒绝或拉起失败，业务应静默中止。
 */
function ensure() {
  if (!supported()) return Promise.resolve(true);
  return new Promise((resolve) => {
    wx.requirePrivacyAuthorize({
      success: () => resolve(true),
      fail: () => resolve(false)
    });
  });
}

/** 打开《用户隐私保护指引》。低版本没有该 API，降级为提示升级 */
function openContract() {
  if (typeof wx.openPrivacyContract !== 'function') {
    wx.showToast({ title: '当前微信版本过低，请升级后查看', icon: 'none' });
    return;
  }
  wx.openPrivacyContract({
    fail: () => wx.showToast({ title: '打开失败，请稍后重试', icon: 'none' })
  });
}

module.exports = { REQUIRED_BASE_LIB, supported, getSetting, ensure, openContract };
