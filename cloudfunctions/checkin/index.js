const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const ok = (data) => ({ code: 0, data, message: 'ok' });
const fail = (code, message) => ({ code, data: null, message });

/** 打卡、连续天数、排行榜全部以东八区为准，不能用 UTC，否则每天 8 点前会算错 */
function todayStr(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate());
}

function offsetDay(n, base = new Date()) {
  return todayStr(new Date(base.getTime() + n * 24 * 60 * 60 * 1000));
}

/** 打卡日历：近 30 天记录 + 连续天数 + 累计天数 */
async function handleCalendar() {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail(401, '未登录');

  const from = offsetDay(-29);

  const [userRes, listRes] = await Promise.all([
    db.collection('users').where({ _openid: OPENID }).limit(1).get(),
    db.collection('checkins')
      .where({ _openid: OPENID, date: _.gte(from) })
      .orderBy('date', 'desc')
      .limit(30)
      .get()
  ]);

  const user = userRes.data[0] || {};
  const map = {};
  listRes.data.forEach((c) => (map[c.date] = c));

  const days = [];
  for (let i = 0; i < 30; i++) {
    const date = offsetDay(-i);
    const rec = map[date];
    days.push({
      date,
      checked: !!rec,
      correctCount: rec ? rec.correctCount : 0,
      doneCount: rec ? rec.doneCount : 0
    });
  }

  return ok({
    days,
    streak: (user.checkin && user.checkin.streak) || 0,
    maxStreak: (user.checkin && user.checkin.maxStreak) || 0,
    totalDays: (user.checkin && user.checkin.totalDays) || 0,
    todayChecked: !!(user.checkin && user.checkin.lastDate === todayStr())
  });
}

/**
 * 提交打卡
 * 唯一索引 (_openid + date) 兜底防重复，这里先查一次是为了给友好提示而不是报数据库错误
 */
async function handleSubmit(payload) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail(401, '未登录');

  const date = todayStr();
  const doneCount = Math.max(0, Number(payload.doneCount) || 0);
  const correctCount = Math.max(0, Number(payload.correctCount) || 0);
  const durationSec = Math.max(0, Number(payload.durationSec) || 0);

  const users = db.collection('users');
  const userRes = await users.where({ _openid: OPENID }).limit(1).get();
  if (!userRes.data.length) return fail(404, '用户不存在，请重新进入小程序');

  const user = userRes.data[0];
  const checkin = user.checkin || { streak: 0, maxStreak: 0, lastDate: '', totalDays: 0 };

  if (checkin.lastDate === date) {
    return ok({ already: true, streak: checkin.streak, message: '今天已经打过卡啦' });
  }

  // 连续判定：昨天打过就 +1，否则从 1 重新开始
  const streak = checkin.lastDate === offsetDay(-1) ? (checkin.streak || 0) + 1 : 1;
  const maxStreak = Math.max(streak, checkin.maxStreak || 0);
  const totalDays = (checkin.totalDays || 0) + 1;

  const transaction = await db.startTransaction();
  try {
    await transaction.collection('checkins').add({
      data: {
        _openid: OPENID,
        date,
        doneCount,
        correctCount,
        durationSec,
        createdAt: db.serverDate()
      }
    });

    await transaction.collection('users').doc(user._id).update({
      data: {
        checkin: { streak, maxStreak, lastDate: date, totalDays }
      }
    });

    await transaction.commit();
  } catch (err) {
    await transaction.rollback().catch(() => {});
    // 并发导致唯一索引冲突，说明已经打过卡了，按成功处理
    if (err && err.errCode === -502005) {
      return ok({ already: true, streak: checkin.streak, message: '今天已经打过卡啦' });
    }
    console.error('[checkin] transaction failed', err);
    return fail(500, '打卡失败，请重试');
  }

  // 打卡成功是申请订阅消息的黄金时机，返回剩余可推送次数给前端决定是否弹窗
  return ok({
    already: false,
    streak,
    maxStreak,
    totalDays,
    canSubscribe: (user.subMsg && user.subMsg.checkin ? user.subMsg.checkin : 0) < 3
  });
}

exports.main = async (event) => {
  const { action, payload = {} } = event;
  try {
    switch (action) {
      case 'calendar':
        return await handleCalendar();
      case 'submit':
        return await handleSubmit(payload);
      default:
        return fail(404, '未知操作: ' + action);
    }
  } catch (err) {
    console.error('[checkin] error', action, err);
    return fail(500, err.message || '服务异常');
  }
};
