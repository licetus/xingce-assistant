/**
 * 版本更新管理
 *
 * 小程序有两套完全不同的「更新」，必须分开处理，混为一谈会出问题：
 *
 * 1. 静默更新（silentUpdate）
 *    微信自己的机制。新版本发布后，微信会在用户下次冷启动时异步拉取新包，
 *    onUpdateReady 后调 applyUpdate() 重启生效。我们只能「提示用户重启」，
 *    控制不了时机——微信可能这次启动推，也可能下下下才推。
 *
 * 2. 业务强制更新（checkVersion）
 *    我们自己控制。config 集合里的 min_version 高于当前版本时，弹不可取消的弹窗阻断使用。
 *    用于：旧版本有严重 Bug、后端接口不兼容、合规整改必须全部升级。
 *
 * 关键认知：小程序代码包没有「热更新」。发布新版本必须提审，审核 1~7 个工作日。
 * 所以凡是能放进 config 集合的开关和文案，都不要写代码里——那才是真正能即时生效的部分。
 */

const cache = require('./cache');

const SOFT_TIP_KEY = 'soft_update_tip';

/**
 * 归一化版本号
 *
 * 必须处理 v 前缀：Git tag 惯例是 v1.2.3，而微信后台的版本号是上传时手填的，
 * 有人写 1.2.3 有人写 v1.2.3。而 wx.getAccountInfoSync() 返回的就是手填的那个字符串。
 * 不做归一化的话，'v1.2.3' 会被 parseInt 解析成 NaN → 0，导致版本比较静默失效，
 * 强制更新永远不触发——这类 Bug 极难排查，因为它不报错。
 */
function normalize(v) {
  return String(v === undefined || v === null ? '' : v)
    .trim()
    .replace(/^[vV]/, '');
}

/** 语义化版本比较：大于返回 1，相等返回 0，小于返回 -1 */
function compareVersion(v1, v2) {
  const a = normalize(v1 || '0.0.0').split('.');
  const b = normalize(v2 || '0.0.0').split('.');
  const len = Math.max(a.length, b.length);

  for (let i = 0; i < len; i++) {
    const n1 = parseInt(a[i], 10) || 0;
    const n2 = parseInt(b[i], 10) || 0;
    if (n1 > n2) return 1;
    if (n1 < n2) return -1;
  }
  return 0;
}

/** 当前版本信息，开发版/体验版的 version 是空字符串 */
function getAccountInfo() {
  try {
    const info = wx.getAccountInfoSync();
    return {
      version: (info.miniProgram && info.miniProgram.version) || '',
      envVersion: (info.miniProgram && info.miniProgram.envVersion) || 'release'
    };
  } catch (err) {
    return { version: '', envVersion: 'release' };
  }
}

/**
 * 微信原生更新机制
 * 新包就绪后弹窗让用户重启，用户也可以选择「稍后」，不阻断使用
 */
function silentUpdate() {
  if (!wx.getUpdateManager) return;

  const updateManager = wx.getUpdateManager();

  updateManager.onCheckForUpdate((res) => {
    if (res && res.hasUpdate) {
      require('./track').push('update_detected', {});
    }
  });

  updateManager.onUpdateReady(() => {
    wx.showModal({
      title: '更新提示',
      content: '新版本已经准备好，重启后即可使用最新功能',
      confirmText: '立即重启',
      cancelText: '稍后',
      success: (r) => {
        if (r.confirm) {
          updateManager.applyUpdate();
        }
      }
    });
  });

  updateManager.onUpdateFailed(() => {
    // 下载失败通常不是致命问题，下次启动会重试，静默即可
    require('./track').push('update_failed', {});
  });
}

/**
 * 业务版本校验
 *
 * @param {object} config 云端 config 集合内容
 *   config.min_version    低于此版本 → 强制更新（阻断）
 *   config.latest_version 低于此版本 → 柔性提示（每天最多一次）
 *   config.update_note    更新说明文案
 * @param {string} [debugVersion] 调试用：显式传入模拟版本号时绕过 release 守卫
 *   与柔性提示的当日缓存（调试面板「模拟旧版本」按钮用），正式调用不传
 */
function checkVersion(config = {}, debugVersion = '') {
  const { version, envVersion } = getAccountInfo();

  // 开发版和体验版没有正式版本号，跳过校验，否则本地调试会被自己的弹窗挡住
  if (!debugVersion && envVersion !== 'release') return;

  const current = debugVersion || version || '0.0.0';
  const minVersion = config.min_version;
  const latestVersion = config.latest_version;

  // 强制更新优先级最高
  if (minVersion && compareVersion(current, minVersion) < 0) {
    forceUpdate(minVersion, config.update_note);
    return;
  }

  // 柔性提示：每天最多打扰一次（调试时绕过当日缓存）
  if (latestVersion && compareVersion(current, latestVersion) < 0) {
    const tipped = debugVersion ? '' : cache.get(SOFT_TIP_KEY, '');
    if (tipped !== latestVersion) {
      cache.set(SOFT_TIP_KEY, latestVersion, 24 * cache.HOUR);
      softUpdate(latestVersion, config.update_note);
    }
  }
}

/**
 * 强制更新
 *
 * 现实约束：小程序没有任何 API 能真正「锁死」用户界面。
 * 能做到的最强手段是不可取消的弹窗 + 一键重启，绝大多数用户会照做。
 */
function forceUpdate(minVersion, note) {
  wx.showModal({
    title: '需要更新',
    content: note || '当前版本已停止服务，请更新后继续使用',
    showCancel: false,
    confirmText: '立即更新',
    success: () => {
      if (wx.getUpdateManager) {
        const um = wx.getUpdateManager();
        um.onUpdateReady(() => um.applyUpdate());
        um.onUpdateFailed(() => {
          // 新包还没推到这个用户，引导他手动刷新——这是目前唯一的可行兜底
          wx.showModal({
            title: '更新未就绪',
            content: '新版正在推送中，请在微信「发现-小程序」中删除本小程序后重新搜索打开',
            showCancel: false
          });
        });
      }
    }
  });
}

function softUpdate(latestVersion, note) {
  wx.showModal({
    title: '有新版本',
    content: note || `已发布 v${latestVersion}，建议更新后使用`,
    confirmText: '知道了',
    showCancel: false
  });
}

module.exports = { compareVersion, getAccountInfo, silentUpdate, checkVersion };
