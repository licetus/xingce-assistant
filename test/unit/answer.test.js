'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadCf } = require('../helpers/load-cf.js');
const mockSdk = require('../helpers/mock-sdk.js');
const { seedQuestions, newUser } = require('../helpers/fixtures.js');

const OPENID = 'u-answer-001';

beforeEach(() => {
  mockSdk.__mock.resetDb({ questions: seedQuestions(), users: [newUser(OPENID)] });
  mockSdk.__mock.setOpenid(OPENID);
  mockSdk.__mock.setNow(new Date('2026-09-06T10:00:00+08:00'));
});

/** 造一批 items：前 n 对后 m 错（答案全是 B） */
function items(qids, wrongCount = 0) {
  return qids.map((qid, i) => ({
    qid,
    chosen: i < qids.length - wrongCount ? ['B'] : ['A'],
    costMs: 5000
  }));
}

test('submit：判题正确、返回对错与解析', async () => {
  const cf = loadCf('answer');
  const res = await cf.main({
    action: 'submit',
    payload: { scene: 'practice', items: items([1, 2, 3, 11, 12], 2) }
  });

  assert.equal(res.code, 0);
  assert.equal(res.data.total, 5);
  assert.equal(res.data.correctCount, 3);
  // 每题返回答案与解析（用户已作答完，此时下发是安全的）
  res.data.results.forEach((r) => {
    assert.ok(Array.isArray(r.answer));
    assert.ok(r.analysis);
  });
});

test('submit：用户统计正确累加（总量 + 分模块）', async () => {
  const cf = loadCf('answer');
  // qid 1~5 属常识判断，11~12 属言语理解
  await cf.main({ action: 'submit', payload: { items: items([1, 2, 3, 11], 1) } });

  const users = mockSdk.__mock.raw('users');
  const stats = users[0].stats;
  assert.equal(stats.totalDone, 4);
  assert.equal(stats.totalCorrect, 3);
  assert.equal(stats.byModule['常识判断'].done, 3);
  assert.equal(stats.byModule['常识判断'].correct, 3);
  assert.equal(stats.byModule['言语理解'].done, 1);
  assert.equal(stats.byModule['言语理解'].correct, 0);
});

test('submit：答错进错题本，答对不进', async () => {
  const cf = loadCf('answer');
  await cf.main({ action: 'submit', payload: { items: items([1, 2], 1) } });

  const wb = mockSdk.__mock.raw('wrong_book');
  assert.equal(wb.length, 1);
  assert.equal(wb[0].qid, 2);
  assert.equal(wb[0].wrongCount, 1);
  assert.equal(wb[0].mastered, false);
});

test('submit：错题重做答对 → 连对计满 2 次标记掌握并出统计', async () => {
  const cf = loadCf('answer');

  // 第一轮：qid 2 答错进错题本
  await cf.main({ action: 'submit', payload: { items: [{ qid: 2, chosen: ['A'], costMs: 1000 }] } });
  // 第二轮：答对一次（streak=1，未掌握）
  await cf.main({ action: 'submit', payload: { items: [{ qid: 2, chosen: ['B'], costMs: 1000 }] } });
  let wb = mockSdk.__mock.raw('wrong_book');
  assert.equal(wb[0].rightStreak, 1);
  assert.equal(wb[0].mastered, false);
  assert.equal(wb[0].wrongCount, 1, '答对不应累加 wrongCount');

  // 第三轮：再答对（streak=2 → 掌握）
  await cf.main({ action: 'submit', payload: { items: [{ qid: 2, chosen: ['B'], costMs: 1000 }] } });
  wb = mockSdk.__mock.raw('wrong_book');
  assert.equal(wb[0].rightStreak, 2);
  assert.equal(wb[0].mastered, true);

  // 返回的 wrongCount（未掌握数）应为 0
  const res = await cf.main({ action: 'submit', payload: { items: [{ qid: 1, chosen: ['B'], costMs: 1000 }] } });
  assert.equal(res.data.wrongCount, 0);
});

test('submit：掌握后再答错 → 回炉重置连对', async () => {
  const cf = loadCf('answer');
  await cf.main({ action: 'submit', payload: { items: [{ qid: 2, chosen: ['A'], costMs: 1000 }] } });
  await cf.main({ action: 'submit', payload: { items: [{ qid: 2, chosen: ['B'], costMs: 1000 }] } });
  await cf.main({ action: 'submit', payload: { items: [{ qid: 2, chosen: ['B'], costMs: 1000 }] } });
  await cf.main({ action: 'submit', payload: { items: [{ qid: 2, chosen: ['A'], costMs: 1000 }] } });

  const wb = mockSdk.__mock.raw('wrong_book');
  assert.equal(wb[0].mastered, false);
  assert.equal(wb[0].rightStreak, 0);
  assert.equal(wb[0].wrongCount, 2);
});

test('submit：答题流水落库（含场景与耗时截断）', async () => {
  const cf = loadCf('answer');
  await cf.main({
    action: 'submit',
    payload: { scene: 'checkin', items: [{ qid: 1, chosen: ['B'], costMs: 999999999 }] }
  });

  const records = mockSdk.__mock.raw('records');
  assert.equal(records.length, 1);
  assert.equal(records[0].scene, 'checkin');
  assert.equal(records[0].costMs, 600000, 'costMs 超过 10 分钟应截断');
  assert.equal(records[0]._openid, OPENID);
});

test('submit：多选题顺序无关判对', async () => {
  const cf = loadCf('answer');
  mockSdk.__mock.resetDb({
    questions: [
      { ...seedQuestions()[0], qid: 100, type: 'multi', answer: ['A', 'C'] }
    ],
    users: [newUser(OPENID)]
  });

  const r1 = await cf.main({
    action: 'submit', payload: { items: [{ qid: 100, chosen: ['C', 'A'], costMs: 100 }] }
  });
  assert.equal(r1.data.results[0].correct, true, '多选答案顺序无关');

  const r2 = await cf.main({
    action: 'submit', payload: { items: [{ qid: 100, chosen: ['A'], costMs: 100 }] }
  });
  assert.equal(r2.data.results[0].correct, false, '少选判错');
});

test('submit：不存在的 qid 跳过；全部不存在返回 404', async () => {
  const cf = loadCf('answer');
  const res = await cf.main({
    action: 'submit',
    payload: { items: [{ qid: 99999, chosen: ['B'], costMs: 100 }] }
  });
  assert.equal(res.code, 404);
});

test('submit：空 items 返回 400', async () => {
  const cf = loadCf('answer');
  const res = await cf.main({ action: 'submit', payload: { items: [] } });
  assert.equal(res.code, 400);
});

test('submit：未登录返回 401', async () => {
  mockSdk.__mock.setOpenid('');
  const cf = loadCf('answer');
  const res = await cf.main({ action: 'submit', payload: { items: [{ qid: 1, chosen: ['B'], costMs: 1 }] } });
  assert.equal(res.code, 401);
});

test('submit：事务失败返回 500 且数据不落库', async () => {
  const cf = loadCf('answer');
  mockSdk.__mock.failOn({ collection: 'wrong_book', op: 'add', err: new Error('mock tx fail') });

  const res = await cf.main({ action: 'submit', payload: { items: items([1], 1) } });
  assert.equal(res.code, 500);
  assert.equal(res.message, '成绩保存失败，请重试');
  // 事务回滚：错题本与流水都不应有写入
  assert.equal(mockSdk.__mock.raw('wrong_book').length, 0);
  assert.equal(mockSdk.__mock.raw('records').length, 0);
});

test('submit：流水写失败不影响判题结果（最终一致）', async () => {
  const cf = loadCf('answer');
  mockSdk.__mock.failOn({ collection: 'records', op: 'add', err: new Error('mock record fail') });

  const res = await cf.main({ action: 'submit', payload: { items: items([1], 0) } });
  assert.equal(res.code, 0, '流水失败不应导致提交失败');
  assert.equal(res.data.total, 1);
});
