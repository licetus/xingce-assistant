'use strict';

/**
 * 测试种子数据
 *
 * 与 database/import/ 中的真实导入数据同构，保证字段形态一致。
 * 难度分布刻意覆盖 1~5 全档，供抽题配比用例断言。
 */

/** 生成一道题 */
function q(qid, module, subtype, opts = {}) {
  return {
    qid,
    module,
    subtype,
    type: opts.type || 'single',
    stem: opts.stem || `第 ${qid} 题：下列说法正确的是？`,
    options: opts.options || ['选项A', '选项B', '选项C', '选项D'],
    answer: opts.answer || ['B'],
    analysis: opts.analysis || '解析：正确答案为 B。',
    difficulty: opts.difficulty !== undefined ? opts.difficulty : 3,
    tags: opts.tags || [],
    materialId: opts.materialId || null,
    images: opts.images || [],
    status: opts.status !== undefined ? opts.status : 1,
    stat: { done: 0, correct: 0 }
  };
}

/** 标准题库：五大模块 × 难度 1~5，共 40 题 */
function seedQuestions() {
  const list = [];
  const modules = ['常识判断', '言语理解', '数量关系', '判断推理', '资料分析'];
  let qid = 1;
  modules.forEach((m, mi) => {
    for (let d = 1; d <= 5; d++) {
      for (let i = 0; i < 2; i++) {
        list.push(q(qid++, m, `${m}考点${d}`, { difficulty: d }));
      }
    }
  });
  return list;
}

/** 新用户档案（与 login 云函数 newUser 输出同构） */
function newUser(openid, overrides = {}) {
  const byModule = {};
  ['常识判断', '言语理解', '数量关系', '判断推理', '资料分析'].forEach((m) => {
    byModule[m] = { done: 0, correct: 0 };
  });
  return {
    _id: 'user-' + openid,
    _openid: openid,
    profile: { nickName: '', avatarUrl: '', grade: '' },
    inviteBy: null,
    checkin: { streak: 0, maxStreak: 0, lastDate: '', totalDays: 0 },
    stats: { totalDone: 0, totalCorrect: 0, byModule },
    subMsg: { checkin: 0 },
    createdAt: new Date(),
    lastActiveAt: new Date(),
    ...overrides
  };
}

/** 打卡记录 */
function checkin(openid, date, done = 10, correct = 6) {
  return { _openid: openid, date, doneCount: done, correctCount: correct, durationSec: 300, createdAt: new Date() };
}

module.exports = { q, seedQuestions, newUser, checkin, MODULES: ['常识判断', '言语理解', '数量关系', '判断推理', '资料分析'] };
