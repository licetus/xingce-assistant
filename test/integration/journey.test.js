'use strict';

/**
 * 集成测试：核心用户旅程全链路
 *
 * 链路：前端 services → mock wx.cloud → 真实云函数代码 → mock 数据库
 * 覆盖 V1 三大核心功能：刷题与解析、错题本、打卡排行榜。
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createWxEnv, uninstall } = require('../helpers/mock-wx.js');
const { registerAll } = require('../helpers/load-cf.js');
const mockSdk = require('../helpers/mock-sdk.js');
const { seedQuestions } = require('../helpers/fixtures.js');

const OPENID = 'u-journey-001';
const ALL_CFS = ['login', 'user', 'question', 'answer', 'wrongbook', 'favorite', 'checkin', 'rank', 'timer', 'track', 'share'];

// 前端模块依赖全局 wx，先装环境再 require
const env = createWxEnv();
env.install();
env.installApp({ openid: OPENID, config: { checkin_tmpl_id: 'TMPL_JOURNEY' } });

// 云函数全量注册（resetDb 会清空注册表，故在每个用例内重新注册）
const svcUser = require('../../miniprogram/services/user.js');
const svcQuestion = require('../../miniprogram/services/question.js');
const svcAnswer = require('../../miniprogram/services/answer.js');
const svcCheckin = require('../../miniprogram/services/checkin.js');
const svcFav = require('../../miniprogram/services/favorite.js');
const store = require('../../miniprogram/utils/store.js');

beforeEach(() => {
  for (const k of [...env.storage.keys()]) env.storage.delete(k);
  // track 模块有内存队列，重置以保证用例间隔离
  const trackPath = require.resolve('../../miniprogram/utils/track.js');
  delete require.cache[trackPath];
  mockSdk.__mock.setOpenid(OPENID);
  mockSdk.__mock.setNow(new Date('2026-09-06T10:00:00+08:00'));
  mockSdk.__mock.resetDb({
    questions: seedQuestions(),
    config: [
      { key: 'audit_mode', value: false },
      { key: 'min_version', value: '1.0.0' },
      { key: 'latest_version', value: '1.0.0' },
      { key: 'checkin_tmpl_id', value: 'TMPL_JOURNEY' },
      { key: 'share_text', value: '来一起刷行测' }
    ]
  });
  registerAll(ALL_CFS);
});

test('完整旅程：登录 → 专项刷题 → 错题本 → 掌握 → 首页统计', async () => {
  // 1. 登录建档
  const loginRes = await svcUser.login();
  assert.equal(loginRes.isNew, true);
  assert.equal(mockSdk.__mock.raw('users').length, 1);

  // 2. 拉运营配置
  const config = await svcUser.fetchConfig();
  assert.equal(config.checkin_tmpl_id, 'TMPL_JOURNEY');

  // 3. 题库页：模块进度（新用户全部 0）
  const ms = await svcQuestion.moduleStats();
  assert.equal(ms.modules.length, 5);
  assert.ok(ms.modules.every((m) => m.done === 0 && m.progress === 0));

  // 4. 专项练习：常识判断 6 题，答案全 B
  const drawn = await svcQuestion.draw({ module: '常识判断', count: 6 });
  assert.equal(drawn.list.length, 6);
  drawn.list.forEach((q) => assert.equal('answer' in q, false, '抽题不得泄露答案'));

  // 5. 作答：前 4 对后 2 错
  const items = drawn.list.map((q, i) => ({
    qid: q.qid,
    chosen: i < 4 ? ['B'] : ['A'],
    costMs: 10000
  }));
  const submitRes = await svcAnswer.submit({ scene: 'practice', items });
  assert.equal(submitRes.total, 6);
  assert.equal(submitRes.correctCount, 4);
  assert.equal(submitRes.wrongCount, 2);
  submitRes.results.forEach((r) => {
    assert.ok(Array.isArray(r.answer) && r.analysis, '提交后必须返回答案与解析');
  });

  // 6. 端侧状态同步
  assert.equal(store.state.wrongCount, 2);

  // 7. 云端一致性：流水、统计、错题本
  assert.equal(mockSdk.__mock.raw('records').length, 6);
  const user = mockSdk.__mock.raw('users')[0];
  assert.equal(user.stats.totalDone, 6);
  assert.equal(user.stats.totalCorrect, 4);
  assert.equal(user.stats.byModule['常识判断'].done, 6);
  assert.equal(mockSdk.__mock.raw('wrong_book').length, 2);

  // 8. 首页统计（user.stats）
  const stats = await svcUser.getStats();
  assert.equal(stats.stats.totalDone, 6);
  assert.equal(stats.wrongCount, 2);

  // 9. 错题重做两轮全对 → 全部掌握
  for (let round = 0; round < 2; round++) {
    const redo = await require('../../miniprogram/services/wrongbook.js').redraw(10);
    assert.ok(redo.list.length > 0, `第 ${round + 1} 轮应有错题可重做`);
    await svcAnswer.submit({
      scene: 'practice',
      items: redo.list.map((q) => ({ qid: q.qid, chosen: ['B'], costMs: 5000 }))
    });
  }
  const wb = mockSdk.__mock.raw('wrong_book');
  assert.ok(wb.every((w) => w.mastered), '两轮全对后全部掌握');

  const stats2 = await svcUser.getStats();
  assert.equal(stats2.wrongCount, 0, '掌握后未掌握错题数归零');
  assert.equal(stats2.stats.totalDone, 6 + 2 * 2, '重做也计入统计');
});

test('完整旅程：每日打卡（daily_task → checkin 抽题 → 提交 → 打卡 → 日历）', async () => {
  await svcUser.login();

  // timer 生成当日任务
  const timerCf = require('../../cloudfunctions/timer/index.js');
  const task = await timerCf.main({ action: 'dailyTask', payload: {} });
  assert.equal(task.code, 0);
  assert.equal(task.data.qids.length, 10);

  // checkin 场景抽题：所有人同一套
  const drawn = await svcQuestion.draw({ scene: 'checkin', count: 10 });
  assert.equal(drawn.taskId, '2026-09-06');
  assert.equal(drawn.list.length, 10);
  assert.deepEqual(drawn.list.map((q) => q.qid), task.data.qids);

  // 作答 10 题对 7
  const submitRes = await svcAnswer.submit({
    scene: 'checkin',
    items: drawn.list.map((q, i) => ({ qid: q.qid, chosen: i < 7 ? ['B'] : ['A'], costMs: 30000 }))
  });
  assert.equal(submitRes.correctCount, 7);

  // 打卡
  const ck = await svcCheckin.submit({ doneCount: 10, correctCount: 7, durationSec: 480 });
  assert.equal(ck.already, false);
  assert.equal(ck.streak, 1);
  assert.equal(ck.totalDays, 1);
  assert.equal(ck.canSubscribe, true);

  // 重复打卡幂等
  const ck2 = await svcCheckin.submit({ doneCount: 10, correctCount: 7, durationSec: 100 });
  assert.equal(ck2.already, true);

  // 日历
  const cal = await svcCheckin.calendar();
  assert.equal(cal.todayChecked, true);
  assert.equal(cal.streak, 1);
  assert.equal(cal.totalDays, 1);
  const today = cal.days.find((d) => d.date === '2026-09-06');
  assert.equal(today.checked, true);
  assert.equal(today.doneCount, 10);

  // 打卡记录唯一
  assert.equal(mockSdk.__mock.raw('checkins').length, 1);
});

test('完整旅程：多用户排行榜（打卡聚合 → 缓存 → 榜单）', async () => {
  const timerCf = require('../../cloudfunctions/timer/index.js');

  // 我与两位考友各自打卡（直接走 checkin CF 保证数据一致）
  const players = [
    { openid: 'u-journey-001', done: 10, correct: 8 },
    { openid: 'u-journey-002', done: 10, correct: 9 },
    { openid: 'u-journey-003', done: 10, correct: 5 }
  ];
  for (const p of players) {
    mockSdk.__mock.setOpenid(p.openid);
    await svcUser.login();
    const checkinCf = require('../../cloudfunctions/checkin/index.js');
    await checkinCf.main({ action: 'submit', payload: { doneCount: p.done, correctCount: p.correct, durationSec: 300 } });
  }
  mockSdk.__mock.setOpenid(OPENID);

  // timer 重建榜单缓存
  const rebuild = await timerCf.main({ action: 'rebuildRank', payload: {} });
  assert.equal(rebuild.code, 0);

  // 读周榜
  const rank = await svcCheckin.rank('week');
  assert.equal(rank.list.length, 3);
  // 正确数降序：002(9) > 001(8) > 003(5)
  assert.deepEqual(
    rank.list.map((i) => i.totalCorrect),
    [9, 8, 5]
  );
  assert.equal(rank.me.rank, 2);
  assert.equal(rank.me.totalCorrect, 8);
});

test('完整旅程：收藏开关与列表', async () => {
  await svcUser.login();

  const r1 = await svcFav.toggle(1);
  assert.equal(r1.favorited, true);
  const r2 = await svcFav.toggle(2);
  assert.equal(r2.favorited, true);

  const list = await svcFav.list(0, 20);
  assert.equal(list.list.length, 2);

  const r3 = await svcFav.toggle(1);
  assert.equal(r3.favorited, false);
  const list2 = await svcFav.list(0, 20);
  assert.equal(list2.list.length, 1);
  assert.equal(list2.list[0].qid, 2);
});

test('完整旅程：断网作答 → 恢复补交，数据最终一致', async () => {
  await svcUser.login();

  const origCall = env.wx.cloud.callFunction;
  env.wx.cloud.callFunction = async () => { throw { errMsg: 'cloud.callFunction:fail 断网' }; };

  const res = await svcAnswer.submitSafe({
    scene: 'practice',
    items: [{ qid: 1, chosen: ['B'], costMs: 3000 }]
  });
  assert.equal(res, null);

  // 恢复网络，补交
  env.wx.cloud.callFunction = origCall;
  const okCount = await svcAnswer.flushPending();
  assert.equal(okCount, 1);

  const records = mockSdk.__mock.raw('records');
  assert.equal(records.length, 1);
  assert.equal(records[0].correct, true);
  assert.equal(mockSdk.__mock.raw('users')[0].stats.totalDone, 1);
});

test('完整旅程：埋点批量上报不阻塞业务', async () => {
  const track = require('../../miniprogram/utils/track.js');
  track.push('page_view', { path: 'pages/index/index' });
  track.push('tap_module', { module: '常识判断' });
  track.flush();

  // flush 是 fire-and-forget，等微任务队列排空
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mockSdk.__mock.raw('events').length, 2);
});

process.on('exit', () => uninstall());
