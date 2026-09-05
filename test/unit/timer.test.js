'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadCf, registerAll } = require('../helpers/load-cf.js');
const mockSdk = require('../helpers/mock-sdk.js');
const { seedQuestions } = require('../helpers/fixtures.js');

beforeEach(() => {
  mockSdk.__mock.resetDb({ questions: seedQuestions() });
  mockSdk.__mock.setOpenid('u-timer-001');
  mockSdk.__mock.setNow(new Date('2026-09-06T10:00:00+08:00'));
});

test('dailyTask：生成当日任务，五模块均匀、难度限定 2~4', async () => {
  const cf = loadCf('timer');
  const res = await cf.main({ action: 'dailyTask', payload: {} });

  assert.equal(res.code, 0);
  assert.equal(res.data.date, '2026-09-06');
  assert.equal(res.data.qids.length, 10);

  // 校验落库
  const task = mockSdk.__mock.raw('daily_task')[0];
  assert.equal(task.date, '2026-09-06');
  assert.equal(task.qids.length, 10);

  // 五大模块每模块 2 题
  const mods = {};
  seedQuestions().forEach((q) => { mods[q.qid] = q.module; });
  const counts = {};
  res.data.qids.forEach((qid) => {
    const m = mods[qid];
    counts[m] = (counts[m] || 0) + 1;
  });
  Object.keys(counts).forEach((m) => {
    assert.equal(counts[m], 2, `模块 ${m} 应有 2 题`);
  });

  // 难度 2~4
  const diffs = {};
  seedQuestions().forEach((q) => { diffs[q.qid] = q.difficulty; });
  res.data.qids.forEach((qid) => {
    assert.ok(diffs[qid] >= 2 && diffs[qid] <= 4, `qid ${qid} 难度 ${diffs[qid]} 超出 2~4`);
  });
});

test('dailyTask：幂等——已存在且未 force 时跳过', async () => {
  const cf = loadCf('timer');
  mockSdk.__mock.resetDb({
    questions: seedQuestions(),
    daily_task: [{ date: '2026-09-06', qids: [1, 2, 3] }]
  });

  const res = await cf.main({ action: 'dailyTask', payload: {} });
  assert.equal(res.code, 0);
  assert.equal(res.data.skipped, true);
  assert.equal(mockSdk.__mock.raw('daily_task').length, 1);
  assert.equal(mockSdk.__mock.raw('daily_task')[0].qids.length, 3, '跳过时不覆盖已有任务');
});

test('dailyTask：force=true 覆盖重建', async () => {
  const cf = loadCf('timer');
  mockSdk.__mock.resetDb({
    questions: seedQuestions(),
    daily_task: [{ _id: 't1', date: '2026-09-06', qids: [1, 2, 3] }]
  });

  const res = await cf.main({ action: 'dailyTask', payload: { force: true } });
  assert.equal(res.code, 0);
  assert.equal(res.data.qids.length, 10);
  assert.equal(mockSdk.__mock.raw('daily_task').length, 1, '覆盖而非新增');
});

test('dailyTask：可指定历史日期（补数据）', async () => {
  const cf = loadCf('timer');
  const res = await cf.main({ action: 'dailyTask', payload: { date: '2026-09-01' } });
  assert.equal(res.data.date, '2026-09-01');
  assert.equal(mockSdk.__mock.raw('daily_task')[0].date, '2026-09-01');
});

test('rebuildRank：经 callFunction 链式调 rank 函数刷新缓存', async () => {
  registerAll(['rank']);
  const cf = loadCf('timer');

  const res = await cf.main({ action: 'rebuildRank', payload: {} });
  assert.equal(res.code, 0);
  // rank.rebuild 返回 { code:0, data:{week,total} }
  assert.equal(res.data.data.week >= 0, true);
  assert.equal(mockSdk.__mock.raw('rank_cache').length, 2);
});

test('archive：清理 90 天前的流水', async () => {
  const cf = loadCf('timer');
  mockSdk.__mock.resetDb({
    records: [
      { _openid: 'a', qid: 1, date: '2026-06-01', createdAt: new Date('2026-06-01') }, // 97 天前，删
      { _openid: 'a', qid: 2, date: '2026-08-30', createdAt: new Date('2026-08-30') } // 7 天前，留
    ]
  });

  const res = await cf.main({ action: 'archive', payload: {} });
  assert.equal(res.code, 0);
  assert.equal(res.data.removed, 1);
  assert.equal(mockSdk.__mock.raw('records').length, 1);
  assert.equal(mockSdk.__mock.raw('records')[0].date, '2026-08-30');
});

test('archive：删除失败不抛错（静默降级）', async () => {
  const cf = loadCf('timer');
  mockSdk.__mock.failOn({ collection: 'records', op: 'remove', err: new Error('mock') });
  const res = await cf.main({ action: 'archive', payload: {} });
  assert.equal(res.code, 0);
  assert.equal(res.data.removed, 0);
});
