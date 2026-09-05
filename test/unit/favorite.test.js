'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadCf } = require('../helpers/load-cf.js');
const mockSdk = require('../helpers/mock-sdk.js');
const { seedQuestions } = require('../helpers/fixtures.js');

const OPENID = 'u-fav-001';

beforeEach(() => {
  mockSdk.__mock.resetDb({ questions: seedQuestions() });
  mockSdk.__mock.setOpenid(OPENID);
  mockSdk.__mock.setNow(new Date('2026-09-06T10:00:00+08:00'));
});

test('add：收藏成功', async () => {
  const cf = loadCf('favorite');
  const res = await cf.main({ action: 'add', payload: { qid: 1 } });

  assert.equal(res.code, 0);
  assert.equal(res.data.favorited, true);
  const favs = mockSdk.__mock.raw('favorites');
  assert.equal(favs.length, 1);
  assert.equal(favs[0].qid, 1);
  assert.equal(favs[0]._openid, OPENID);
});

test('add：唯一索引冲突（-502005）幂等返回 duplicated', async () => {
  const cf = loadCf('favorite');
  mockSdk.__mock.failOn({ collection: 'favorites', op: 'add', err: { errCode: -502005 } });

  const res = await cf.main({ action: 'add', payload: { qid: 1 } });
  assert.equal(res.code, 0);
  assert.equal(res.data.favorited, true);
  assert.equal(res.data.duplicated, true);
});

test('add：缺少 qid 返回 400', async () => {
  const cf = loadCf('favorite');
  const res = await cf.main({ action: 'add', payload: {} });
  assert.equal(res.code, 400);
});

test('remove：取消收藏', async () => {
  const cf = loadCf('favorite');
  mockSdk.__mock.resetDb({
    questions: seedQuestions(),
    favorites: [{ _openid: OPENID, qid: 1, createdAt: new Date() }]
  });

  const res = await cf.main({ action: 'remove', payload: { qid: 1 } });
  assert.equal(res.code, 0);
  assert.equal(res.data.favorited, false);
  assert.equal(mockSdk.__mock.raw('favorites').length, 0);
});

test('toggle：无则加，有则删', async () => {
  const cf = loadCf('favorite');

  const r1 = await cf.main({ action: 'toggle', payload: { qid: 1 } });
  assert.equal(r1.data.favorited, true);
  assert.equal(mockSdk.__mock.raw('favorites').length, 1);

  const r2 = await cf.main({ action: 'toggle', payload: { qid: 1 } });
  assert.equal(r2.data.favorited, false);
  assert.equal(mockSdk.__mock.raw('favorites').length, 0);
});

test('toggle：不影响其他用户与其他题目', async () => {
  const cf = loadCf('favorite');
  mockSdk.__mock.resetDb({
    questions: seedQuestions(),
    favorites: [
      { _openid: OPENID, qid: 1, createdAt: new Date() },
      { _openid: 'other-user', qid: 2, createdAt: new Date() }
    ]
  });

  await cf.main({ action: 'toggle', payload: { qid: 2 } }); // 自己没收藏过 2 → 收藏
  const favs = mockSdk.__mock.raw('favorites');
  assert.equal(favs.length, 3);
  assert.ok(favs.some((f) => f._openid === OPENID && f.qid === 2));
});

test('list：分页返回收藏，已下架题目过滤', async () => {
  const cf = loadCf('favorite');
  const questions = seedQuestions().filter((q) => q.qid !== 3);
  mockSdk.__mock.resetDb({
    questions,
    favorites: [
      { _openid: OPENID, qid: 3, createdAt: new Date('2026-09-05') }, // 已下架
      { _openid: OPENID, qid: 1, createdAt: new Date('2026-09-04') },
      { _openid: OPENID, qid: 2, createdAt: new Date('2026-09-06') }
    ]
  });

  const res = await cf.main({ action: 'list', payload: {} });
  assert.equal(res.code, 0);
  assert.equal(res.data.list.length, 2);
  // 按收藏时间倒序
  assert.deepEqual(res.data.list.map((f) => f.qid), [2, 1]);
  assert.equal('answer' in res.data.list[0], false);
});

test('未登录返回 401', async () => {
  mockSdk.__mock.setOpenid('');
  const cf = loadCf('favorite');
  assert.equal((await cf.main({ action: 'add', payload: { qid: 1 } })).code, 401);
  assert.equal((await cf.main({ action: 'toggle', payload: { qid: 1 } })).code, 401);
});
