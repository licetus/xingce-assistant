/**
 * 登录态维护
 * cloud.js 遇到 401 时回调这里，重登成功后原请求自动重试，业务层无感知
 */

const { call } = require('./cloud');
const store = require('./store');

let reloginPromise = null;

function relogin() {
  // 并发的多个 401 请求共用一个重登流程，避免重复调用
  if (reloginPromise) return reloginPromise;

  reloginPromise = new Promise((resolve, reject) => {
    wx.login({
      success: () => {
        call('login', 'login', {}, { silent: true })
          .then((res) => {
            const app = getApp();
            if (app) {
              app.globalData.openid = res.openid;
              app.globalData.user = res.user;
            }
            store.setUser(res.user);
            reloginPromise = null;
            resolve(res);
          })
          .catch((err) => {
            reloginPromise = null;
            reject(err);
          });
      },
      fail: (err) => {
        reloginPromise = null;
        reject(err);
      }
    });
  });

  return reloginPromise;
}

module.exports = { relogin };
