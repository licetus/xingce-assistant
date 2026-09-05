'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadCf } = require('../helpers/load-cf.js');
const mockSdk = require('../helpers/mock-sdk.js');
const { seedQuestions } = require('../helpers/fixtures.js');

const OPENID = 'u-wrong-001';

beforeEach(() => {
  mockSdk.__mock.resetDb({ questions: seedQuestions() });
  mockSdk.__mock.setOpenid(OPENID);
  mockSdk.__mock.setNow(new Date('2026-09-06T10:00:00+08:00'));
});

function wbDoc(qid, opts = {}) {
  return {
    _openid: OPENID,
    qid,
    wrongCount: opts.wrongCount || 1,
    rightStreak: opts.rightStreak || 0,
    mastered: opts.mastered || false,
    lastWrongAt: opts.lastWrongAt || new Date('2026-09-01'),
    createdAt: new Date('2026-08-30')
  };
}

test('list：默认只看未掌握，含题目摘要', async () => {
  const cf = loadCf('wrongbook');
  mockSdk.__mock.resetDb({
    questions: seedQuestions(),
    wrong_book: [wbDoc(1), wbDoc(2, { mastered: true }), wbDoc(3)]
  });

  const res = await cf.main({ action: 'list', payload: {} });
  assert.equal(res.code, 0);
  assert.equal(res.data.list.length, 2);
  assert.equal(res.data.total, 2);
  assert.equal(res.data.hasMore, false);

  const item = res.data.list.find((w) => w.qid === 1);
  assert.ok(item.stem);
  assert.equal(item.module, '常识判断');
  assert.equal('answer' in item, false, '错题列表不泄露答案');
});

test('list：mastered=true 查看全部（含已掌握）', async () => {
  const cf = loadCf('wrongbook');
  mockSdk.__mock.resetDb({
    questions: seedQuestions(),
    wrong_book: [wbDoc(1), wbDoc(2, { mastered: true })]
  });

  const res = await cf.main({ action: 'list', payload: { mastered: true } });
  assert.equal(res.data.list.length, 2);
  assert.equal(res.data.total, 2);
});

test('list：分页与 hasMore', async () => {
  const cf = loadCf('wrongbook');
  const docs = [];
  for (let qid = 1; qid <= 25; qid++) docs.push(wbDoc(qid, { lastWrongAt: new Date(2026, 8, 1, 0, qid) }));
  mockSdk.__mock.resetDb({ questions: seedQuestions(), wrong_book: docs });

  const p1 = await cf.main({ action: 'list', payload: { page: 0, size: 20 } });
  assert.equal(p1.data.list.length, 20);
  assert.equal(p1.data.total, 25);
  assert.equal(p1.data.hasMore, true);

  const p2 = await cf.main({ action: 'list', payload: { page: 1, size: 20 } });
  assert.equal(p2.data.list.length, 5);
  assert.equal(p2.data.hasMore, false);
});

test('list：按 lastWrongAt 降序（最近错的在前）', async () => {
  const cf = loadCf('wrongbook');
  mockSdk.__mock.resetDb({
    questions: seedQuestions(),
    wrong_book: [
      wbDoc(1, { lastWrongAt: new Date('2026-09-01') }),
      wbDoc(2, { lastWrongAt: new Date('2026-09-05') }),
      wbDoc(3, { lastWrongAt: new Date('2026-09-03') })
    ]
  });

  const res = await cf.main({ action: 'list', payload: {} });
  assert.deepEqual(res.data.list.map((w) => w.qid), [2, 3, 1]);
});

test('list：题目已下架的错题自动消失', async () => {
  const cf = loadCf('wrongbook');
  const questions = seedQuestions().filter((q) => q.qid !== 3);
  mockSdk.__mock.resetDb({
    questions,
    wrong_book: [wbDoc(1), wbDoc(3)]
  });

  const res = await cf.main({ action: 'list', payload: {} });
  assert.equal(res.data.list.length, 1);
  assert.equal(res.data.list[0].qid, 1);
});

test('remove：手动移出（标记掌握）', async () => {
  const cf = loadCf('wrongbook');
  mockSdk.__mock.resetDb({ questions: seedQuestions(), wrong_book: [wbDoc(5)] });

  const res = await cf.main({ action: 'remove', payload: { qid: 5 } });
  assert.equal(res.code, 0);
  assert.equal(mockSdk.__mock.raw('wrong_book')[0].mastered, true);
});

test('redraw：只抽未掌握，最久未复习的在前', async () => {
  const cf = loadCf('wrongbook');
  mockSdk.__mock.resetDb({
    questions: seedQuestions(),
    wrong_book: [
      wbDoc(1, { lastWrongAt: new Date('2026-09-05') }),
      wbDoc(2, { lastWrongAt: new Date('2026-09-01') }), // 最久
      wbDoc(3, { lastWrongAt: new Date('2026-09-03') }),
      wbDoc(4, { mastered: true }) // 已掌握，不抽
    ]
  });

  const res = await cf.main({ action: 'redraw', payload: { count: 2 } });
  assert.equal(res.code, 0);
  assert.deepEqual(res.data.list.map((q) => q.qid), [2, 3]);
  res.data.list.forEach((q) => {
    assert.ok(q.stem && q.options);
    assert.equal('answer' in q, false, '重做列表不泄露答案');
  });
});

test('redraw：错题为空返回空列表', async () => {
  const cf = loadCf('wrongbook');
  const res = await cf.main({ action: 'redraw', payload: {} });
  assert.equal(res.code, 0);
  assert.deepEqual(res.data.list, []);
});

test('未登录返回 401（list/remove/redraw）', async () => {
  mockSdk.__mock.setOpenid('');
  const cf = loadCf('wrongbook');
  assert.equal((await cf.main({ action: 'list', payload: {} })).code, 401);
  assert.equal((await cf.main({ action: 'remove', payload: { qid: 1 } })).code, 401);
  assert.equal((await cf.main({ action: 'redraw', payload: {} })).code, 401);
});
