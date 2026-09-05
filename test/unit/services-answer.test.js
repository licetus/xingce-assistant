'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createWxEnv, uninstall } = require('../helpers/mock-wx.js');
const { resetDb } = require('../helpers/mock-sdk.js').__mock;

// services/answer → utils/cloud → wx；先装好 wx 再 require
const env = createWxEnv();
env.install();
env.installApp({ openid: 'u-svc', config: { checkin_tmpl_id: 'TMPL1' } });

// 每个用例前清 require 缓存，让 services 拿到干净的模块级状态（如 track 队列）
function fresh(path) {
  delete require.cache[require.resolve(path)];
  return require(path);
}

beforeEach(() => {
  for (const k of [...env.storage.keys()]) env.storage.delete(k);
  resetDb({});
});

test('submitSafe：断网时入队并提示', async () => {
  const { registerAll } = require('../helpers/load-cf.js');
  resetDb({});
  registerAll(['answer']);

  const svc = fresh('../../miniprogram/services/answer.js');
  // 第一次调用网络失败（cloudFailTimes 是 env 级的，这里用错误注入模拟一次网络异常）
  const origCall = env.wx.cloud.callFunction;
  env.wx.cloud.callFunction = async () => { throw { errMsg: 'fail' }; };

  const res = await svc.submitSafe({ scene: 'practice', items: [{ qid: 1, chosen: ['B'], costMs: 100 }] });
  env.wx.cloud.callFunction = origCall;

  assert.equal(res, null, '断网时 submitSafe 返回 null 不抛错');
  const pending = svc.getPending();
  assert.equal(pending.length, 1, '作答应入本地队列');
  assert.equal(pending[0].items[0].qid, 1);
  assert.equal(env.calls.toast.length, 1, '应提示已保存');
});

test('flushPending：网络恢复后补交并清空队列', async () => {
  const { loadCf } = require('../helpers/load-cf.js');
  const { seedQuestions } = require('../helpers/fixtures.js');
  const mockSdk = require('../helpers/mock-sdk.js');
  mockSdk.__mock.resetDb({ questions: seedQuestions() });
  loadCf('answer');

  const svc = fresh('../../miniprogram/services/answer.js');
  // 模拟断网入队
  const origCall = env.wx.cloud.callFunction;
  env.wx.cloud.callFunction = async () => { throw { errMsg: 'fail' }; };
  await svc.submitSafe({ scene: 'practice', items: [{ qid: 1, chosen: ['B'], costMs: 100 }] });
  env.wx.cloud.callFunction = origCall;

  // 恢复网络后补交
  const okCount = await svc.flushPending();
  assert.equal(okCount, 1, '补交成功 1 条');
  assert.equal(svc.getPending().length, 0, '队列应清空');
  assert.equal(mockSdk.__mock.raw('records').length, 1, '补交后流水应落库');
});

test('flushPending：连续失败 3 次后丢弃', async () => {
  const { registerAll } = require('../helpers/load-cf.js');
  resetDb({});
  registerAll(['answer']);

  const svc = fresh('../../miniprogram/services/answer.js');
  // 断网入队（submitSafe retry:0，快速失败）
  const origCall = env.wx.cloud.callFunction;
  env.wx.cloud.callFunction = async () => { throw { errMsg: 'fail' }; };
  await svc.submitSafe({ scene: 'practice', items: [{ qid: 1, chosen: ['B'], costMs: 1 }] });
  assert.equal(svc.getPending().length, 1);
  // 网络持续失败：重试 MAX_RETRY=3 次
  await svc.flushPending();
  assert.equal(svc.getPending().length, 1, '失败 1 次后仍保留（retry < 3）');

  await svc.flushPending();
  assert.equal(svc.getPending().length, 1, '失败 2 次后仍保留');

  await svc.flushPending();
  assert.equal(svc.getPending().length, 0, '失败 3 次后丢弃（retry 达到上限）');
  env.wx.cloud.callFunction = origCall;
});

test('submit：成功后同步 store 的错题数', async () => {
  const { loadCf } = require('../helpers/load-cf.js');
  const { seedQuestions } = require('../helpers/fixtures.js');
  const mockSdk = require('../helpers/mock-sdk.js');
  mockSdk.__mock.resetDb({ questions: seedQuestions() });
  loadCf('answer');

  const store = fresh('../../miniprogram/utils/store.js');
  const svc = fresh('../../miniprogram/services/answer.js');

  // store 与 services/answer 不共享 require 缓存路径下的同一实例？
  // services/answer 内部 require('../utils/store') —— 与这里 require 的是同一模块
  const res = await svc.submit({ scene: 'practice', items: [{ qid: 1, chosen: ['A'], costMs: 10 }] });
  assert.equal(res.total, 1);
  assert.equal(res.wrongCount, 1, '答错一题 wrongCount=1');
  assert.equal(store.state.wrongCount, 1, 'store 应同步错题数');
});

process.on('exit', () => uninstall());
