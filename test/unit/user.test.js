'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadCf } = require('../helpers/load-cf.js');
const mockSdk = require('../helpers/mock-sdk.js');
const { newUser, seedQuestions } = require('../helpers/fixtures.js');

const OPENID = 'u-user-001';

beforeEach(() => {
  mockSdk.__mock.resetDb({});
  mockSdk.__mock.setOpenid(OPENID);
  mockSdk.__mock.setNow(new Date('2026-09-06T10:00:00+08:00'));
});

test('stats：返回资料、统计与未掌握错题数', async () => {
  const cf = loadCf('user');
  const user = newUser(OPENID, {
    profile: { nickName: '小明', avatarUrl: 'cloud://av', grade: '大三' },
    stats: { totalDone: 10, totalCorrect: 7, byModule: { 常识判断: { done: 10, correct: 7 } } }
  });
  mockSdk.__mock.resetDb({
    users: [user],
    wrong_book: [
      { _openid: OPENID, qid: 1, mastered: false },
      { _openid: OPENID, qid: 2, mastered: false },
      { _openid: OPENID, qid: 3, mastered: true }
    ]
  });

  const res = await cf.main({ action: 'stats' });
  assert.equal(res.code, 0);
  assert.equal(res.data.profile.nickName, '小明');
  assert.equal(res.data.stats.totalDone, 10);
  assert.equal(res.data.wrongCount, 2, '只统计未掌握错题');
});

test('stats：用户不存在返回 404', async () => {
  const cf = loadCf('user');
  const res = await cf.main({ action: 'stats' });
  assert.equal(res.code, 404);
});

test('updateProfile：逐字段合并，白名单外字段忽略', async () => {
  const cf = loadCf('user');
  mockSdk.__mock.resetDb({
    users: [newUser(OPENID, { profile: { nickName: '旧名', avatarUrl: 'old', grade: '' } })]
  });

  const res = await cf.main({
    action: 'updateProfile',
    payload: { nickName: '新名', grade: '应届', isAdmin: true }
  });
  assert.equal(res.code, 0);

  const p = mockSdk.__mock.raw('users')[0].profile;
  assert.equal(p.nickName, '新名');
  assert.equal(p.grade, '应届');
  assert.equal(p.avatarUrl, 'old', '未提交字段保持原值');
  assert.equal('isAdmin' in p, false, '白名单外字段不得写入');
});

test('updateProfile：空 payload 返回 400', async () => {
  const cf = loadCf('user');
  mockSdk.__mock.resetDb({ users: [newUser(OPENID)] });
  const res = await cf.main({ action: 'updateProfile', payload: {} });
  assert.equal(res.code, 400);
});

test('updateProfile：超长昵称截断 64 字符', async () => {
  const cf = loadCf('user');
  mockSdk.__mock.resetDb({ users: [newUser(OPENID)] });
  await cf.main({ action: 'updateProfile', payload: { nickName: '非'.repeat(100) } });
  assert.equal(mockSdk.__mock.raw('users')[0].profile.nickName.length, 64);
});

test('grantSubscribe：授权计数 +1', async () => {
  const cf = loadCf('user');
  mockSdk.__mock.resetDb({ users: [newUser(OPENID)] });

  const res = await cf.main({ action: 'grantSubscribe', payload: { type: 'checkin' } });
  assert.equal(res.code, 0);
  assert.equal(mockSdk.__mock.raw('users')[0].subMsg.checkin, 1);
});

test('grantSubscribe：未知类型返回 400', async () => {
  const cf = loadCf('user');
  mockSdk.__mock.resetDb({ users: [newUser(OPENID)] });
  const res = await cf.main({ action: 'grantSubscribe', payload: { type: 'marketing' } });
  assert.equal(res.code, 400);
});

test('未登录返回 401', async () => {
  mockSdk.__mock.setOpenid('');
  const cf = loadCf('user');
  assert.equal((await cf.main({ action: 'stats' })).code, 401);
  assert.equal((await cf.main({ action: 'updateProfile', payload: { nickName: 'x' } })).code, 401);
  assert.equal((await cf.main({ action: 'grantSubscribe', payload: { type: 'checkin' } })).code, 401);
});

test('grantSubscribe：配额封顶 3 次后不再累加', async () => {
  const cf = loadCf('user');
  mockSdk.__mock.resetDb({ users: [newUser(OPENID, { subMsg: { checkin: 3 } })] });

  const res = await cf.main({ action: 'grantSubscribe', payload: { type: 'checkin' } });
  assert.equal(res.code, 0);
  assert.equal(res.data.granted, false);
  assert.equal(res.data.reason, 'quota_full');
  assert.equal(mockSdk.__mock.raw('users')[0].subMsg.checkin, 3, '封顶后不应再累加');
});
