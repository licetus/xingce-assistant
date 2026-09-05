'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadCf } = require('../helpers/load-cf.js');
const mockSdk = require('../helpers/mock-sdk.js');
const { newUser, checkin } = require('../helpers/fixtures.js');

const ME = 'u-rank-me';
const OTHERS = ['u-rank-a', 'u-rank-b', 'u-rank-c'];

beforeEach(() => {
  mockSdk.__mock.resetDb({});
  mockSdk.__mock.setOpenid(ME);
  mockSdk.__mock.setNow(new Date('2026-09-06T10:00:00+08:00'));
});

function seedRankWorld() {
  const users = [
    newUser(ME, { profile: { nickName: '我', avatarUrl: '', grade: '' } }),
    newUser(OTHERS[0], { profile: { nickName: '甲', avatarUrl: 'av-a', grade: '' } }),
    newUser(OTHERS[1], { profile: { nickName: '乙', avatarUrl: '', grade: '' } }),
    newUser(OTHERS[2], { profile: { nickName: '丙', avatarUrl: '', grade: '' } })
  ];
  const checkins = [
    // 我：昨天 10 对 6，前天（超出周窗口）10 对 9
    checkin(ME, '2026-09-05', 10, 6),
    checkin(ME, '2026-08-28', 10, 9),
    // 甲：3 天前 10 对 8
    checkin(OTHERS[0], '2026-09-03', 10, 8),
    // 乙：昨天 10 对 7（周内第一）
    checkin(OTHERS[1], '2026-09-05', 10, 7),
    // 丙：25 天前（超出周窗口）
    checkin(OTHERS[2], '2026-08-12', 10, 10)
  ];
  mockSdk.__mock.resetDb({ users, checkins });
}

test('list：无缓存时实时聚合，周榜只统计近 7 天', async () => {
  const cf = loadCf('rank');
  seedRankWorld();

  const res = await cf.main({ action: 'list', payload: { type: 'week' } });
  assert.equal(res.code, 0);

  // 周榜：乙(7) > 我(6) > 甲(8)？不对——按 correctCount 排：甲 8 > 乙 7 > 我 6
  const names = res.data.list.map((i) => i._openid);
  assert.deepEqual(names, [OTHERS[0], OTHERS[1], ME], '周榜按周内正确数降序，丙已出窗口');
  assert.equal(res.data.list.length, 3);

  // 我的排名（1-based）
  assert.equal(res.data.me.rank, 3);
  assert.equal(res.data.me.totalCorrect, 6);
});

test('list：总榜不限时间窗口', async () => {
  const cf = loadCf('rank');
  seedRankWorld();

  const res = await cf.main({ action: 'list', payload: { type: 'total' } });
  assert.equal(res.code, 0);
  // 总榜：丙(10) > 甲(8) > 乙(7) > 我(15/6? 我 6+9=15)
  // 我总正确 = 6+9 = 15 → 第一
  assert.deepEqual(res.data.list.map((i) => i._openid), [ME, OTHERS[2], OTHERS[0], OTHERS[1]]);
  assert.equal(res.data.me.rank, 1);
  assert.equal(res.data.me.totalCorrect, 15);
});

test('list：读取 timer 写入的缓存不再聚合', async () => {
  const cf = loadCf('rank');
  mockSdk.__mock.resetDb({
    users: [newUser(ME)],
    rank_cache: [
      { _id: 'week', list: [{ _openid: 'someone', nickName: '缓存人', totalCorrect: 99, totalDone: 100, days: 10 }], updatedAt: new Date() }
    ]
  });

  const res = await cf.main({ action: 'list', payload: { type: 'week' } });
  assert.equal(res.data.list.length, 1);
  assert.equal(res.data.list[0].nickName, '缓存人');
  assert.ok(res.data.updatedAt, '应返回缓存时间');
  // 我不在榜内 → 实时算自己的名次
  assert.equal(res.data.me.totalCorrect, 0);
});

test('rebuild：重建周榜与总榜缓存', async () => {
  const cf = loadCf('rank');
  seedRankWorld();

  const res = await cf.main({ action: 'rebuild' });
  assert.equal(res.code, 0);
  assert.equal(res.data.week, 3);
  assert.equal(res.data.total, 4);

  const cache = mockSdk.__mock.raw('rank_cache');
  const week = cache.find((c) => c._id === 'week');
  const total = cache.find((c) => c._id === 'total');
  assert.ok(week && total);
  assert.equal(week.list.length, 3);
  assert.equal(total.list.length, 4);
});

test('list：未登录返回 401', async () => {
  mockSdk.__mock.setOpenid('');
  const cf = loadCf('rank');
  const res = await cf.main({ action: 'list', payload: {} });
  assert.equal(res.code, 401);
});

test('list：昵称缺失的榜内用户显示默认名「考友」', async () => {
  const cf = loadCf('rank');
  mockSdk.__mock.resetDb({
    users: [newUser(ME)],
    checkins: [checkin('ghost-user', '2026-09-05', 10, 5)]
  });

  const res = await cf.main({ action: 'list', payload: { type: 'week' } });
  const ghost = res.data.list.find((i) => i._openid === 'ghost-user');
  assert.equal(ghost.nickName, '考友');
});
