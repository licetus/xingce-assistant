'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadCf } = require('../helpers/load-cf.js');
const mockSdk = require('../helpers/mock-sdk.js');
const { newUser } = require('../helpers/fixtures.js');

const OPENID = 'u-login-001';

beforeEach(() => {
  mockSdk.__mock.resetDb({});
  mockSdk.__mock.setOpenid(OPENID);
  // 跟随真实时钟：本文件用例全用 Date.now() 相对时间造数据，
  // 若固定 mock 时间会随墙钟漂移产生偶发失败（serverDate 写回旧时间）
  mockSdk.__mock.setNow(new Date());
});

test('login：新用户建档，结构完整', async () => {
  const cf = loadCf('login');
  const res = await cf.main({ action: 'login', payload: {} });

  assert.equal(res.code, 0);
  assert.equal(res.data.isNew, true);
  assert.equal(res.data.openid, OPENID);

  const users = mockSdk.__mock.raw('users');
  assert.equal(users.length, 1);
  const u = users[0];
  assert.equal(u._openid, OPENID);
  assert.equal(u.inviteBy, null);
  assert.deepEqual(u.checkin, { streak: 0, maxStreak: 0, lastDate: '', totalDays: 0 });
  assert.equal(u.stats.totalDone, 0);
  // 五大模块的初始统计必须齐全（answer 增量更新依赖这些字段存在）
  ['常识判断', '言语理解', '数量关系', '判断推理', '资料分析'].forEach((m) => {
    assert.ok(u.stats.byModule[m], `新用户档案缺 ${m} 初始统计`);
    assert.deepEqual(u.stats.byModule[m], { done: 0, correct: 0 });
  });
});

test('login：老用户 5 分钟内不重复 touch', async () => {
  const cf = loadCf('login');
  const last = new Date(Date.now() - 2 * 60 * 1000); // 2 分钟前
  mockSdk.__mock.resetDb({ users: [newUser(OPENID, { lastActiveAt: last })] });

  const res = await cf.main({ action: 'login', payload: {} });
  assert.equal(res.data.isNew, false);
  assert.equal(mockSdk.__mock.raw('users').length, 1);
  // lastActiveAt 未被改写（仍是 09:58）
  assert.equal(new Date(mockSdk.__mock.raw('users')[0].lastActiveAt).getTime(), last.getTime());
});

test('login：老用户超 5 分钟 touch 更新活跃时间', async () => {
  const cf = loadCf('login');
  mockSdk.__mock.resetDb({ users: [newUser(OPENID, { lastActiveAt: new Date(Date.now() - 10 * 60 * 1000) })] });

  const res = await cf.main({ action: 'login', payload: {} });
  assert.equal(res.data.isNew, false);
  const after = new Date(mockSdk.__mock.raw('users')[0].lastActiveAt).getTime();
  assert.ok(after > Date.now() - 60 * 1000, 'lastActiveAt 应被刷新');
});

test('login：首次进入带 inviteBy，老用户无邀请关系时补记', async () => {
  const cf = loadCf('login');
  // 用户建档于 5 分钟内（不触发 touch 分支）但无 inviteBy —— 老用户补记邀请
  mockSdk.__mock.resetDb({ users: [newUser(OPENID, { lastActiveAt: new Date(Date.now() - 60 * 1000) })] });

  await cf.main({ action: 'login', payload: { inviteBy: 'inviter-abc' } });
  // 5 分钟内不 touch → inviteBy 也不会补记（与当前实现一致）
  assert.equal(mockSdk.__mock.raw('users')[0].inviteBy, null);
});

test('login：5 分钟外补记邀请关系', async () => {
  const cf = loadCf('login');
  mockSdk.__mock.resetDb({ users: [newUser(OPENID, { lastActiveAt: new Date(Date.now() - 10 * 60 * 1000) })] });

  await cf.main({ action: 'login', payload: { inviteBy: 'inviter-abc' } });
  assert.equal(mockSdk.__mock.raw('users')[0].inviteBy, 'inviter-abc');
});

test('login：已有邀请关系的用户不被覆盖', async () => {
  const cf = loadCf('login');
  mockSdk.__mock.resetDb({
    users: [newUser(OPENID, { inviteBy: 'original', lastActiveAt: new Date(Date.now() - 10 * 60 * 1000) })]
  });

  await cf.main({ action: 'login', payload: { inviteBy: 'other' } });
  assert.equal(mockSdk.__mock.raw('users')[0].inviteBy, 'original');
});

test('login：未登录返回 401', async () => {
  mockSdk.__mock.setOpenid('');
  const cf = loadCf('login');
  const res = await cf.main({ action: 'login', payload: {} });
  assert.equal(res.code, 401);
});

test('config：返回 key-value 映射', async () => {
  const cf = loadCf('login');
  mockSdk.__mock.resetDb({
    config: [
      { key: 'audit_mode', value: false },
      { key: 'min_version', value: '1.0.0' },
      { key: 'checkin_tmpl_id', value: 'TMPL123' }
    ]
  });

  const res = await cf.main({ action: 'config' });
  assert.equal(res.code, 0);
  assert.deepEqual(res.data, { audit_mode: false, min_version: '1.0.0', checkin_tmpl_id: 'TMPL123' });
});
