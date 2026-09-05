'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadCf } = require('../helpers/load-cf.js');
const mockSdk = require('../helpers/mock-sdk.js');
const { newUser, checkin } = require('../helpers/fixtures.js');

const OPENID = 'u-checkin-001';

beforeEach(() => {
  mockSdk.__mock.resetDb({ users: [newUser(OPENID)] });
  mockSdk.__mock.setOpenid(OPENID);
  mockSdk.__mock.setNow(new Date('2026-09-06T10:00:00+08:00'));
});

test('calendar：返回近 30 天日历与连续天数', async () => {
  const cf = loadCf('checkin');
  mockSdk.__mock.resetDb({
    users: [newUser(OPENID, { checkin: { streak: 3, maxStreak: 5, lastDate: '2026-09-05', totalDays: 20 } })],
    checkins: [
      checkin(OPENID, '2026-09-05', 10, 7),
      checkin(OPENID, '2026-09-04', 10, 8),
      checkin(OPENID, '2026-09-03', 10, 6)
    ]
  });

  const res = await cf.main({ action: 'calendar' });
  assert.equal(res.code, 0);
  assert.equal(res.data.days.length, 30);

  const today = res.data.days.find((d) => d.date === '2026-09-06');
  const yesterday = res.data.days.find((d) => d.date === '2026-09-05');
  assert.equal(today.checked, false);
  assert.equal(today.correctCount, 0);
  assert.equal(yesterday.checked, true);
  assert.equal(yesterday.correctCount, 7);

  assert.equal(res.data.streak, 3);
  assert.equal(res.data.maxStreak, 5);
  assert.equal(res.data.totalDays, 20);
  assert.equal(res.data.todayChecked, false);
});

test('calendar：今天已打卡', async () => {
  const cf = loadCf('checkin');
  mockSdk.__mock.resetDb({
    users: [newUser(OPENID, { checkin: { streak: 1, maxStreak: 1, lastDate: '2026-09-06', totalDays: 1 } })],
    checkins: [checkin(OPENID, '2026-09-06', 10, 9)]
  });

  const res = await cf.main({ action: 'calendar' });
  assert.equal(res.data.todayChecked, true);
  const today = res.data.days.find((d) => d.date === '2026-09-06');
  assert.equal(today.checked, true);
  assert.equal(today.correctCount, 9);
});

test('submit：昨日打卡过 → 连续 +1', async () => {
  const cf = loadCf('checkin');
  mockSdk.__mock.resetDb({
    users: [newUser(OPENID, { checkin: { streak: 4, maxStreak: 6, lastDate: '2026-09-05', totalDays: 10 } })],
    checkins: [checkin(OPENID, '2026-09-05')]
  });

  const res = await cf.main({ action: 'submit', payload: { doneCount: 10, correctCount: 8, durationSec: 300 } });
  assert.equal(res.code, 0);
  assert.equal(res.data.already, false);
  assert.equal(res.data.streak, 5);
  assert.equal(res.data.maxStreak, 6);
  assert.equal(res.data.totalDays, 11);
  assert.equal(res.data.canSubscribe, true, 'subMsg.checkin=0 < 3 应可订阅');

  // 落库校验
  const checkins = mockSdk.__mock.raw('checkins');
  assert.equal(checkins.length, 2);
  const todayRec = checkins.find((c) => c.date === '2026-09-06');
  assert.ok(todayRec);
  assert.equal(todayRec.doneCount, 10);
  assert.equal(todayRec.correctCount, 8);
});

test('submit：中断后重新打卡 → 连续从 1 开始，maxStreak 保持', async () => {
  const cf = loadCf('checkin');
  mockSdk.__mock.resetDb({
    users: [newUser(OPENID, { checkin: { streak: 9, maxStreak: 9, lastDate: '2026-09-01', totalDays: 9 } })]
  });

  const res = await cf.main({ action: 'submit', payload: {} });
  assert.equal(res.data.streak, 1);
  assert.equal(res.data.maxStreak, 9);
});

test('submit：今天已打过 → already=true，不重复落库', async () => {
  const cf = loadCf('checkin');
  mockSdk.__mock.resetDb({
    users: [newUser(OPENID, { checkin: { streak: 1, maxStreak: 1, lastDate: '2026-09-06', totalDays: 1 } })],
    checkins: [checkin(OPENID, '2026-09-06')]
  });

  const res = await cf.main({ action: 'submit', payload: { doneCount: 5, correctCount: 5 } });
  assert.equal(res.code, 0);
  assert.equal(res.data.already, true);
  assert.equal(mockSdk.__mock.raw('checkins').length, 1, '不应重复写入打卡记录');
});

test('submit：订阅额度满 3 次不再提示', async () => {
  const cf = loadCf('checkin');
  mockSdk.__mock.resetDb({
    users: [newUser(OPENID, { subMsg: { checkin: 3 }, checkin: { streak: 0, maxStreak: 0, lastDate: '', totalDays: 0 } })]
  });

  const res = await cf.main({ action: 'submit', payload: {} });
  assert.equal(res.data.canSubscribe, false);
});

test('submit：并发唯一索引冲突（-502005）按已打卡处理', async () => {
  const cf = loadCf('checkin');
  mockSdk.__mock.failOn({ collection: 'checkins', op: 'add', err: { errCode: -502005, message: 'duplicate key' } });

  const res = await cf.main({ action: 'submit', payload: {} });
  assert.equal(res.code, 0);
  assert.equal(res.data.already, true);
});

test('submit：用户不存在返回 404', async () => {
  const cf = loadCf('checkin');
  mockSdk.__mock.resetDb({});
  const res = await cf.main({ action: 'submit', payload: {} });
  assert.equal(res.code, 404);
});

test('submit：其他事务错误返回 500 且回滚', async () => {
  const cf = loadCf('checkin');
  mockSdk.__mock.failOn({ collection: 'checkins', op: 'add', err: { errCode: -501000, message: 'db down' } });

  const res = await cf.main({ action: 'submit', payload: {} });
  assert.equal(res.code, 500);
  // 用户打卡字段不应被更新（事务回滚）
  const users = mockSdk.__mock.raw('users');
  assert.equal(users[0].checkin.lastDate, '');
});

test('未登录返回 401（calendar 与 submit）', async () => {
  mockSdk.__mock.setOpenid('');
  const cf = loadCf('checkin');
  assert.equal((await cf.main({ action: 'calendar' })).code, 401);
  assert.equal((await cf.main({ action: 'submit', payload: {} })).code, 401);
});

test('东八区正确性：UTC 时间 00:30（东八 08:30）应为当天', async () => {
  const cf = loadCf('checkin');
  mockSdk.__mock.setNow(new Date('2026-09-06T00:30:00Z'));
  const res = await cf.main({ action: 'submit', payload: {} });
  assert.equal(res.code, 0);

  const checkins = mockSdk.__mock.raw('checkins');
  assert.equal(checkins[0].date, '2026-09-06', 'UTC 00:30 = 东八区 08:30，应为 09-06');
});
