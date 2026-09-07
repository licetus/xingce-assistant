'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadCf } = require('../helpers/load-cf.js');
const mockSdk = require('../helpers/mock-sdk.js');
const { seedQuestions, newUser } = require('../helpers/fixtures.js');

const OPENID = 'u-question-001';

beforeEach(() => {
  mockSdk.__mock.resetDb({ questions: seedQuestions() });
  mockSdk.__mock.setOpenid(OPENID);
  mockSdk.__mock.setNow(new Date('2026-09-06T10:00:00+08:00'));
});

test('draw：practice 场景按模块抽题，数量正确且不含答案字段', async () => {
  const cf = loadCf('question');
  const res = await cf.main({ action: 'draw', payload: { module: '常识判断', count: 6 } });

  assert.equal(res.code, 0);
  assert.equal(res.data.list.length, 6);
  res.data.list.forEach((item) => {
    assert.equal(item.module, '常识判断');
    // 答案与解析绝不下发
    assert.equal('answer' in item, false, '下发题目不得包含 answer');
    assert.equal('analysis' in item, false, '下发题目不得包含 analysis');
    assert.ok(item.qid && item.stem && Array.isArray(item.options));
  });
  assert.equal(res.data.taskId, null);
});

test('draw：subtype 考点筛选生效', async () => {
  const cf = loadCf('question');
  const res = await cf.main({ action: 'draw', payload: { module: '言语理解', subtype: '言语理解考点5', count: 10 } });

  assert.equal(res.code, 0);
  assert.ok(res.data.list.length > 0);
  res.data.list.forEach((item) => assert.equal(item.subtype, '言语理解考点5'));
});

test('draw：不存在的模块返回 404', async () => {
  const cf = loadCf('question');
  const res = await cf.main({ action: 'draw', payload: { module: '不存在的模块' } });
  assert.equal(res.code, 404);
});

test('draw：未登录返回 401', async () => {
  mockSdk.__mock.setOpenid('');
  const cf = loadCf('question');
  const res = await cf.main({ action: 'draw', payload: {} });
  assert.equal(res.code, 401);
});

test('draw：count 边界收敛（0→1，超 50→50）', async () => {
  const cf = loadCf('question');
  const r1 = await cf.main({ action: 'draw', payload: { count: 0 } });
  assert.equal(r1.code, 0);

  const r2 = await cf.main({ action: 'draw', payload: { count: 999 } });
  assert.equal(r2.code, 0);
  assert.ok(r2.data.list.length <= 50);
});

test('draw：近期做过的题去重，做完了放宽允许重刷', async () => {
  const cf = loadCf('question');
  // 常识判断模块只有 10 题：先提交全做过
  const records = [];
  for (let qid = 1; qid <= 10; qid++) {
    records.push({
      _openid: OPENID,
      qid,
      module: '常识判断',
      chosen: ['A'],
      correct: false,
      costMs: 1000,
      scene: 'practice',
      date: '2026-09-05',
      createdAt: new Date('2026-09-05T10:00:00+08:00')
    });
  }
  mockSdk.__mock.resetDb({
    questions: seedQuestions(),
    records,
    users: [newUser(OPENID)]
  });

  // 模块内 10 题全部做过 → candidates 为空 → 放宽去重重刷
  const res = await cf.main({ action: 'draw', payload: { module: '常识判断', count: 5 } });
  assert.equal(res.code, 0);
  assert.equal(res.data.list.length, 5);
});

test('draw：难度配比随用户正确率变化（新手偏向简单题）', async () => {
  const cf = loadCf('question');
  // 真实题库单模块数千题，这里补足易/中档题量，避免「补齐逻辑」混入难题干扰断言
  const questions = seedQuestions();
  let extraId = 500;
  for (let i = 0; i < 10; i++) {
    questions.push({ ...questions[20], qid: extraId++, difficulty: i % 2 === 0 ? 1 : 2, subtype: '数量关系考点1' });
  }
  for (let i = 0; i < 8; i++) {
    questions.push({ ...questions[20], qid: extraId++, difficulty: 3, subtype: '数量关系考点2' });
  }
  const user = newUser(OPENID);
  user.stats.byModule['数量关系'] = { done: 0, correct: 0 };
  mockSdk.__mock.resetDb({ questions, users: [user] });

  const res = await cf.main({ action: 'draw', payload: { module: '数量关系', count: 10 } });
  assert.equal(res.code, 0);
  const hard = res.data.list.filter((i) => i.difficulty >= 4).length;
  // 新手不应抽到难题（mix.hard = 0，易/中题量充足时补齐也不会用难题）
  assert.equal(hard, 0, `新手不应抽到难题，实际 ${hard} 道`);
});

test('draw：checkin 场景读预生成 daily_task，所有人同题', async () => {
  const cf = loadCf('question');
  mockSdk.__mock.resetDb({
    questions: seedQuestions(),
    daily_task: [{ date: '2026-09-06', qids: [1, 3, 5, 11, 13, 15, 21, 23, 25, 31] }]
  });

  const res = await cf.main({ action: 'draw', payload: { scene: 'checkin', count: 10 } });
  assert.equal(res.code, 0);
  assert.equal(res.data.taskId, '2026-09-06');
  assert.equal(res.data.list.length, 10);
  // 顺序必须与 daily_task.qids 一致（题面顺序不能乱）
  assert.deepEqual(res.data.list.map((i) => i.qid), [1, 3, 5, 11, 13, 15, 21, 23, 25, 31]);
});

test('draw：checkin 场景当日任务未生成返回 404', async () => {
  const cf = loadCf('question');
  const res = await cf.main({ action: 'draw', payload: { scene: 'checkin' } });
  assert.equal(res.code, 404);
});

test('detail：按 qid 查详情（同样剥除答案）', async () => {
  const cf = loadCf('question');
  const res = await cf.main({ action: 'detail', payload: { qid: 1 } });
  assert.equal(res.code, 0);
  assert.equal(res.data.qid, 1);
  assert.equal('answer' in res.data, false);
});

test('detail：不存在的题目返回 404', async () => {
  const cf = loadCf('question');
  const res = await cf.main({ action: 'detail', payload: { qid: 99999 } });
  assert.equal(res.code, 404);
});

test('material：按 gid 取材料', async () => {
  const cf = loadCf('question');
  mockSdk.__mock.resetDb({
    qgroups: [{ _id: 'g1', gid: 101, material: '根据下列材料回答问题……', images: [] }]
  });
  const res = await cf.main({ action: 'material', payload: { gid: 101 } });
  assert.equal(res.code, 0);
  assert.equal(res.data.gid, 101);
  assert.ok(res.data.material.includes('材料'));
});

test('moduleStats：五模块题量与用户进度，正确计算 progress', async () => {
  const cf = loadCf('question');
  const user = newUser(OPENID);
  user.stats.byModule['常识判断'] = { done: 5, correct: 4 };
  mockSdk.__mock.resetDb({ questions: seedQuestions(), users: [user] });

  const res = await cf.main({ action: 'moduleStats' });
  assert.equal(res.code, 0);
  assert.equal(res.data.modules.length, 5);

  const cj = res.data.modules.find((m) => m.name === '常识判断');
  assert.equal(cj.total, 10);
  assert.equal(cj.done, 5);
  assert.equal(cj.correct, 4);
  assert.equal(cj.progress, 50);
});

test('moduleStats：未登录返回 401', async () => {
  mockSdk.__mock.setOpenid('');
  const cf = loadCf('question');
  const res = await cf.main({ action: 'moduleStats' });
  assert.equal(res.code, 401);
});

test('subtypes：返回模块下全部考点且排序去重', async () => {
  const cf = loadCf('question');
  const res = await cf.main({ action: 'subtypes', payload: { module: '常识判断' } });
  assert.equal(res.code, 0);
  assert.deepEqual(res.data.list, ['常识判断考点1', '常识判断考点2', '常识判断考点3', '常识判断考点4', '常识判断考点5']);
});

test('subtypes：缺模块参数返回 400', async () => {
  const cf = loadCf('question');
  const res = await cf.main({ action: 'subtypes', payload: {} });
  assert.equal(res.code, 400);
});

test('未知 action 返回 404', async () => {
  const cf = loadCf('question');
  const res = await cf.main({ action: 'nonsense' });
  assert.equal(res.code, 404);
});

// ---------- 题目来源标识（真题 / AI 生成） ----------

test('draw：下发 source 字段供前端展示来源标签', async () => {
  const cf = loadCf('question');
  const res = await cf.main({ action: 'draw', payload: { module: '常识判断', count: 6 } });

  assert.equal(res.code, 0);
  res.data.list.forEach((item) => {
    assert.equal(item.source, 'real', '真题题源应标记 real');
  });
});

test('draw：AI 生成题的 source 原样下发（前端挂「AI 生成」标签）', async () => {
  mockSdk.__mock.resetDb({
    questions: [{ ...require('../helpers/fixtures.js').seedQuestions()[0], qid: 9001, source: 'ai' }]
  });
  const cf = loadCf('question');
  const res = await cf.main({ action: 'draw', payload: { module: '常识判断', count: 5 } });

  assert.equal(res.code, 0);
  const ai = res.data.list.find((x) => x.qid === 9001);
  assert.ok(ai, 'AI 题应被抽中');
  assert.equal(ai.source, 'ai');
});

test('detail：返回 source；旧数据缺 source 时兜底为 real', async () => {
  mockSdk.__mock.resetDb({
    questions: [{ ...require('../helpers/fixtures.js').seedQuestions()[0], qid: 9002, source: undefined }]
  });
  delete mockSdk.__mock.raw('questions')[0].source;

  const cf = loadCf('question');
  const res = await cf.main({ action: 'detail', payload: { qid: 9002 } });

  assert.equal(res.code, 0);
  assert.equal(res.data.source, 'real', '缺失 source 应兜底 real');
  assert.equal('answer' in res.data, false);
  assert.equal('analysis' in res.data, false);
});
