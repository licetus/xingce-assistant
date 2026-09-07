'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createWxEnv, uninstall } = require('../helpers/mock-wx.js');

// privacy 依赖全局 wx（调用时），先装好再 require
const env = createWxEnv();
env.install();
const privacy = require('../../miniprogram/utils/privacy.js');

/** 给 mock wx 挂上隐私 API（基础库 2.32.3+ 才有） */
function installPrivacyApis({
  needAuthorization,
  settingFail,
  authorizeFail,
  openContractFail
} = {}) {
  env.wx.getPrivacySetting = (o) => {
    if (settingFail) return o.fail && o.fail({ errMsg: 'getPrivacySetting:fail' });
    o.success &&
      o.success({
        needAuthorization: !!needAuthorization,
        privacyContractName: '行测小助手隐私保护指引'
      });
  };
  env.wx.requirePrivacyAuthorize = (o) => {
    if (authorizeFail) return o.fail && o.fail({ errMsg: 'requirePrivacyAuthorize:fail' });
    o.success && o.success({ errMsg: 'requirePrivacyAuthorize:ok' });
  };
  env.wx.openPrivacyContract = (o) => {
    env.calls.privacyContract = env.calls.privacyContract || [];
    env.calls.privacyContract.push(o);
    if (openContractFail && o && o.fail) o.fail({ errMsg: 'openPrivacyContract:fail 模拟失败' });
    else if (o && o.success) o.success({ errMsg: 'openPrivacyContract:ok' });
  };
}

function removePrivacyApis() {
  delete env.wx.getPrivacySetting;
  delete env.wx.requirePrivacyAuthorize;
  delete env.wx.openPrivacyContract;
  delete env.calls.privacyContract;
  env.calls.toast.length = 0;
}

beforeEach(() => {
  removePrivacyApis();
});

test('supported：低版本（无隐私 API）返回 false，有 API 返回 true', () => {
  assert.equal(privacy.supported(), false);
  installPrivacyApis();
  assert.equal(privacy.supported(), true);
});

test('低版本降级：getSetting 返回 unsupported 且无需授权', async () => {
  const s = await privacy.getSetting();
  assert.deepEqual(s, { needAuthorization: false, unsupported: true });
});

test('低版本降级：ensure 直接放行', async () => {
  assert.equal(await privacy.ensure(), true);
});

test('getSetting：映射 needAuthorization 与协议名', async () => {
  installPrivacyApis({ needAuthorization: true });
  const s = await privacy.getSetting();
  assert.equal(s.needAuthorization, true);
  assert.equal(s.unsupported, false);
  assert.equal(s.privacyContractName, '行测小助手隐私保护指引');
});

test('getSetting：平台查询失败时按无需授权放行（不阻塞业务）', async () => {
  installPrivacyApis({ settingFail: true });
  const s = await privacy.getSetting();
  assert.equal(s.needAuthorization, false);
  assert.equal(s.unsupported, false);
});

test('ensure：用户同意授权返回 true', async () => {
  installPrivacyApis({ needAuthorization: true });
  assert.equal(await privacy.ensure(), true);
});

test('ensure：用户拒绝授权返回 false（业务应静默中止）', async () => {
  installPrivacyApis({ needAuthorization: true, authorizeFail: true });
  assert.equal(await privacy.ensure(), false);
});

test('openContract：正常打开协议', async () => {
  installPrivacyApis();
  privacy.openContract();
  assert.equal(env.calls.privacyContract.length, 1);
  assert.equal(env.calls.toast.length, 0, '不应出现降级 toast');
});

test('openContract：打开失败时 toast 提示', async () => {
  installPrivacyApis({ openContractFail: true });
  privacy.openContract();
  assert.equal(env.calls.toast.length, 1);
  assert.match(env.calls.toast[0].title, /失败/);
});

test('openContract：低版本降级为升级提示', () => {
  privacy.openContract();
  assert.equal(env.calls.toast.length, 1);
  assert.match(env.calls.toast[0].title, /版本过低/);
});
