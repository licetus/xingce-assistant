const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const ok = (data) => ({ code: 0, data, message: 'ok' });
const fail = (code, message) => ({ code, data: null, message });

const MASTER_STREAK = 2; // 连续答对 2 次判定为已掌握，移出错题本

function todayStr(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate());
}

/** 选项对比，顺序无关 */
function isCorrect(chosen, answer) {
  const a = (chosen || []).slice().sort().join('');
  const b = (answer || []).slice().sort().join('');
  return a.length > 0 && a === b;
}

/**
 * 提交作答并判题
 *
 * 一次调用完成四件事：判题 → 写流水 → 更新错题本 → 更新用户统计。
 *
 * 一致性策略（重要）：
 * 云开发事务有执行时间上限，20 题全量写入会产生 60+ 次操作，容易超时。
 * 因此这里只对「必须强一致」的两项加事务——错题本和用户统计；
 * records 是只增不改的日志，questions.stat 只用于难度校准，
 * 这两项允许最终一致，放在事务外异步写，失败不影响用户看到的结果。
 */
async function handleSubmit(payload) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail(401, '未登录');

  const items = (payload.items || []).filter((i) => i && i.qid);
  if (!items.length) return fail(400, '没有作答内容');
  if (items.length > 50) return fail(400, '单次提交不能超过 50 题');

  const scene = payload.scene || 'practice';
  const date = todayStr();

  // 1. 取题目、已有错题记录与用户档案（并行）
  const qids = items.map((i) => Number(i.qid));
  const [qRes, wbRes, userRes] = await Promise.all([
    db.collection('questions').where({ qid: _.in(qids) }).limit(50).get(),
    db.collection('wrong_book')
      .where({ _openid: OPENID, qid: _.in(qids) })
      .limit(50)
      .get(),
    db.collection('users').where({ _openid: OPENID }).limit(1).get()
  ]);

  const qMap = {};
  qRes.data.forEach((q) => (qMap[q.qid] = q));
  const wbMap = {};
  wbRes.data.forEach((w) => (wbMap[w.qid] = w));
  const userDoc = userRes.data[0];

  // 2. 判题
  const judged = [];
  const dateNow = new Date();
  items.forEach((item) => {
    const qid = Number(item.qid);
    const q = qMap[qid];
    if (!q) return; // 题目已下架，跳过
    const correct = isCorrect(item.chosen, q.answer);
    judged.push({
      qid,
      module: q.module,
      correct,
      chosen: item.chosen || [],
      costMs: Math.min(Number(item.costMs) || 0, 600000),
      answer: q.answer,
      analysis: q.analysis
    });
  });

  if (!judged.length) return fail(404, '题目不存在或已下架');

  // 3. 预计算错题本变更与分模块统计增量
  const wbOps = [];
  const modDelta = {};
  let addDone = 0;
  let addCorrect = 0;

  judged.forEach((j) => {
    addDone += 1;
    if (j.correct) addCorrect += 1;

    const key = j.module || '其他';
    if (!modDelta[key]) modDelta[key] = { done: 0, correct: 0 };
    modDelta[key].done += 1;
    if (j.correct) modDelta[key].correct += 1;

    const exist = wbMap[j.qid];
    if (j.correct) {
      // 答对：只在错题本里已有该题时才更新（连续答对达标则标记掌握）
      if (exist) {
        const streak = (exist.rightStreak || 0) + 1;
        wbOps.push({
          type: 'update',
          id: exist._id,
          data: {
            rightStreak: streak,
            mastered: streak >= MASTER_STREAK
          }
        });
      }
    } else {
      // 答错：已有则累加并清零连对，没有则新建
      if (exist) {
        wbOps.push({
          type: 'update',
          id: exist._id,
          data: {
            wrongCount: _.inc(1),
            rightStreak: 0,
            mastered: false,
            lastWrongAt: dateNow
          }
        });
      } else {
        wbOps.push({
          type: 'add',
          data: {
            _openid: OPENID,
            qid: j.qid,
            wrongCount: 1,
            rightStreak: 0,
            mastered: false,
            lastWrongAt: dateNow,
            createdAt: db.serverDate()
          }
        });
      }
    }
  });

  // 4. 事务：错题本 + 用户统计（强一致）
  //    注意：云开发事务只支持单文档操作（collection.doc / collection.add），
  //    where().update() 批量更新在事务内不可用，用户档案必须在第 1 步先查出来
  const statUpdate = {
    'stats.totalDone': _.inc(addDone),
    'stats.totalCorrect': _.inc(addCorrect)
  };
  Object.keys(modDelta).forEach((m) => {
    statUpdate[`stats.byModule.${m}.done`] = _.inc(modDelta[m].done);
    statUpdate[`stats.byModule.${m}.correct`] = _.inc(modDelta[m].correct);
  });

  const transaction = await db.startTransaction();
  try {
    for (const op of wbOps) {
      if (op.type === 'add') {
        await transaction.collection('wrong_book').add({ data: op.data });
      } else {
        await transaction.collection('wrong_book').doc(op.id).update({ data: op.data });
      }
    }

    if (userDoc) {
      await transaction.collection('users').doc(userDoc._id).update({ data: statUpdate });
    } else {
      // 登录竞态兜底：档案缺失（理论上前端已保证先登录）时直接建档，
      // 与 login 云函数 newUser 的结构保持一致
      const byModule = {};
      Object.keys(modDelta).forEach((m) => {
        byModule[m] = { done: modDelta[m].done, correct: modDelta[m].correct };
      });
      await transaction.collection('users').add({
        data: {
          _openid: OPENID,
          profile: { nickName: '', avatarUrl: '', grade: '' },
          inviteBy: null,
          checkin: { streak: 0, maxStreak: 0, lastDate: '', totalDays: 0 },
          stats: { totalDone: addDone, totalCorrect: addCorrect, byModule },
          subMsg: { checkin: 0 },
          createdAt: db.serverDate(),
          lastActiveAt: db.serverDate()
        }
      });
    }
    await transaction.commit();
  } catch (err) {
    await transaction.rollback().catch(() => {});
    console.error('[answer] transaction failed', err);
    return fail(500, '成绩保存失败，请重试');
  }

  // 5. 事务外：写答题流水（失败不影响用户已看到的结果）
  const recordDocs = judged.map((j) => ({
    _openid: OPENID,
    qid: j.qid,
    module: j.module,
    chosen: j.chosen,
    correct: j.correct,
    costMs: j.costMs,
    scene,
    date,
    createdAt: db.serverDate()
  }));

  // 云开发单次批量上限 500，20 题一批足够，这里按 100 切分留余量
  for (let i = 0; i < recordDocs.length; i += 100) {
    const batch = recordDocs.slice(i, i + 100);
    await Promise.all(
      batch.map((doc) =>
        db.collection('records').add({ data: doc }).catch((e) => {
          console.error('[answer] record write failed', e);
        })
      )
    );
  }

  // 6. 事务外：题目全局统计，用于后续难度校准（失败可容忍）
  Promise.all(
    judged.map((j) =>
      db
        .collection('questions')
        .where({ qid: j.qid })
        .update({
          data: {
            'stat.done': _.inc(1),
            'stat.correct': _.inc(j.correct ? 1 : 0)
          }
        })
        .catch(() => {})
    )
  ).catch(() => {});

  const wrongCount = await db
    .collection('wrong_book')
    .where({ _openid: OPENID, mastered: false })
    .count();

  return ok({
    taskId: payload.taskId || null,
    total: judged.length,
    correctCount: judged.filter((j) => j.correct).length,
    wrongCount: wrongCount.total,
    results: judged.map((j) => ({
      qid: j.qid,
      correct: j.correct,
      answer: j.answer,
      analysis: j.analysis
    }))
  });
}

exports.main = async (event) => {
  const { action, payload = {} } = event;
  try {
    switch (action) {
      case 'submit':
        return await handleSubmit(payload);
      default:
        return fail(404, '未知操作: ' + action);
    }
  } catch (err) {
    console.error('[answer] error', action, err);
    return fail(500, err.message || '服务异常');
  }
};
