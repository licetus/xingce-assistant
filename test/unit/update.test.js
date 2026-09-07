'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createWxEnv, uninstall } = require('../helpers/mock-wx.js');

const env = createWxEnv();
env.install();

let update;
function freshUpdate() {
  delete require.cache[require.resolve('../../miniprogram/utils/update.js')];
  update = require('../../miniprogram/utils/update.js');
}

/** mock 账号信息：envVersion 决定 checkVersion 是否走正式校验 */
function installAccount(envVersion, version) {
  env.wx.getAccountInfoSync = () => ({
    miniProgram: { envVersion, version: version || '' }
  });
}

beforeEach(() => {
  freshUpdate();
  uninstall();
  env.install();
  env.storage.clear();
  env.calls.modal = [];
});

test('checkVersion：非 release 环境默认跳过（体验版不被自己的弹窗挡住）', () => {
  installAccount('trial', '');
  update.checkVersion({ min_version: '1.0.0' });
  assert.equal(env.calls.modal.length, 0);
});

test('checkVersion：debugVersion 绕过 release 守卫，命中强更弹窗', () => {
  installAccount('trial', '');
  update.checkVersion({ min_version: '1.0.0', update_note: '整改测试' }, '0.0.1');

  assert.equal(env.calls.modal.length, 1);
  const modal = env.calls.modal[0];
  assert.equal(modal.showCancel, false, '强更弹窗不可取消');
  assert.equal(modal.title, '需要更新');
  assert.equal(modal.content, '整改测试');
});

test('checkVersion：debugVersion 命中柔性提示，且绕过当日缓存', () => {
  installAccount('trial', '');
  const config = { latest_version: '1.0.0' };

  update.checkVersion(config, '0.0.2');
  assert.equal(env.calls.modal.length, 1);
  assert.equal(env.calls.modal[0].title, '有新版本');

  // 同日第二次调试触发仍能弹（正式路径会被 SOFT_TIP_KEY 挡住）
  update.checkVersion(config, '0.0.2');
  assert.equal(env.calls.modal.length, 2);
});

test('checkVersion：debugVersion 高于 min/latest 时不弹任何窗', () => {
  installAccount('trial', '');
  update.checkVersion(
    { min_version: '1.0.0', latest_version: '1.0.0' },
    '1.0.0'
  );
  assert.equal(env.calls.modal.length, 0);
});
