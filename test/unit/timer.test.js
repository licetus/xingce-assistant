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

// ---------- 打卡提醒 notify ----------

function seedNoticeUsers() {
  mockSdk.__mock.resetDb({
    // 当前测试时钟 2026-09-06：today=09-06 yesterday=09-05
    config: [
      { key: 'checkin_tmpl_id', value: 'TMPL_X' },
      { key: 'checkin_tmpl_fields', value: { date: 'thing1', streak: 'thing2' } }
    ],
    users: [
      // 该发：昨天打过、今天没打、有配额
      { _id: 'u1', _openid: 'oA', checkin: { streak: 3, lastDate: '2026-09-05' }, subMsg: { checkin: 1 } },
      // 不发：今天已打卡（lastDate 已更新）
      { _id: 'u2', _openid: 'oB', checkin: { streak: 5, lastDate: '2026-09-06' }, subMsg: { checkin: 2 } },
      // 不发：无配额
      { _id: 'u3', _openid: 'oC', checkin: { streak: 1, lastDate: '2026-09-05' }, subMsg: { checkin: 0 } },
      // 不发：断签太久（lastDate 是前天以前）
      { _id: 'u4', _openid: 'oD', checkin: { streak: 0, lastDate: '2026-09-01' }, subMsg: { checkin: 5 } }
    ]
  });
}

test('notify：只提醒昨天打过+今天没打+有配额的用户，发送成功扣配额', async () => {
  seedNoticeUsers();
  const cf = loadCf('timer');
  const res = await cf.main({ action: 'notify', payload: {} });

  assert.equal(res.code, 0);
  assert.equal(res.data.candidates, 1);
  assert.equal(res.data.sent, 1);
  assert.equal(res.data.failed, 0);

  const sends = mockSdk.__mock.subSends();
  assert.equal(sends.length, 1);
  assert.equal(sends[0].touser, 'oA');
  assert.equal(sends[0].templateId, 'TMPL_X');
  assert.equal(sends[0].data.thing1.value, '2026-09-06');
  assert.equal(sends[0].data.thing2.value, '3天');
  assert.equal(mockSdk.__mock.raw('users')[0].subMsg.checkin, 0, '发送成功应扣配额');
});

test('notify：未配置模板 ID 时跳过', async () => {
  mockSdk.__mock.resetDb({ config: [], users: [] });
  const cf = loadCf('timer');
  const res = await cf.main({ action: 'notify', payload: {} });
  assert.equal(res.data.skipped, 'no_tmpl_id');
  assert.equal(mockSdk.__mock.subSends().length, 0);
});

test('notify：发送失败不扣配额（下次再试）', async () => {
  seedNoticeUsers();
  mockSdk.__mock.setOpenapiResult(new Error('mock send fail'));
  const cf = loadCf('timer');
  const res = await cf.main({ action: 'notify', payload: {} });

  assert.equal(res.data.sent, 0);
  assert.equal(res.data.failed, 1);
  assert.equal(mockSdk.__mock.raw('users')[0].subMsg.checkin, 1, '失败不应扣配额');
  mockSdk.__mock.setOpenapiResult(null);
});

test('定时触发器 event：TriggerName 映射到 action（此前一直 404 的修复）', async () => {
  const cf = loadCf('timer');
  const res = await cf.main({ Type: 'Timer', TriggerName: 'dailyTask' });

  assert.equal(res.code, 0);
  assert.equal(res.data.date, '2026-09-06');
  assert.equal(mockSdk.__mock.raw('daily_task').length, 1);
});
