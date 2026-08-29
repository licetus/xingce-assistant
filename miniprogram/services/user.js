const { call } = require('../utils/cloud');

function login(inviteBy = '') {
  return call('login', 'login', { inviteBy }, { silent: true });
}

/** 运营配置：审核开关、首页 banner、分享文案、最低版本 */
function fetchConfig() {
  return call('login', 'config', {}, { silent: true });
}

function getStats() {
  return call('user', 'stats', {}, { silent: true });
}

/** 头像昵称必须走这两个组件授权，wx.getUserProfile 已废弃 */
function updateProfile(profile) {
  return call('user', 'updateProfile', profile, { loading: false, silent: true });
}

/** 申请打卡订阅消息，应在打卡成功后调用（此时授权率最高） */
function requestCheckinSubscribe(tmplId) {
  return new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds: [tmplId],
      success: (res) => {
        const accepted = res[tmplId] === 'accept';
        if (accepted) {
          call('user', 'grantSubscribe', { type: 'checkin' }, { silent: true }).catch(() => {});
        }
        resolve(accepted);
      },
      fail: () => resolve(false)
    });
  });
}

module.exports = { login, fetchConfig, getStats, updateProfile, requestCheckinSubscribe };
