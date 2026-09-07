const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const ok = (data) => ({ code: 0, data, message: 'ok' });
const fail = (code, message) => ({ code, data: null, message });

/** 头像昵称之外的可更新字段白名单，防止 payload 塞脏数据 */
const PROFILE_FIELDS = ['nickName', 'avatarUrl', 'grade'];

/**
 * 用户统计与资料
 *
 * 首页与「我的」页聚合展示：资料 + 作答统计 + 未掌握错题数。
 * stats.byModule 已由 answer 云函数增量冗余维护，这里不做聚合。
 */
async function handleStats() {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail(401, '未登录');

  const [userRes, wrongRes] = await Promise.all([
    db.collection('users').where({ _openid: OPENID }).limit(1).get(),
    db.collection('wrong_book').where({ _openid: OPENID, mastered: false }).count()
  ]);

  const user = userRes.data[0];
  if (!user) return fail(404, '用户不存在，请重新进入小程序');

  return ok({
    profile: user.profile || { nickName: '', avatarUrl: '', grade: '' },
    stats: user.stats || { totalDone: 0, totalCorrect: 0, byModule: {} },
    checkin: user.checkin || { streak: 0, maxStreak: 0, lastDate: '', totalDays: 0 },
    wrongCount: wrongRes.total
  });
}

/**
 * 更新资料（头像 / 昵称 / 年级）
 * 微信已废弃 wx.getUserProfile，资料全部由用户主动填写组件提交，逐字段合并。
 */
async function handleUpdateProfile(payload) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail(401, '未登录');

  const data = {};
  PROFILE_FIELDS.forEach((f) => {
    if (payload && typeof payload[f] === 'string' && payload[f].length > 0) {
      data['profile.' + f] = payload[f].slice(0, 64);
    }
  });

  if (!Object.keys(data).length) return fail(400, '没有可更新的资料');

  const userRes = await db.collection('users').where({ _openid: OPENID }).limit(1).get();
  if (!userRes.data.length) return fail(404, '用户不存在，请重新进入小程序');

  await db.collection('users').doc(userRes.data[0]._id).update({ data });
  return ok({ updated: Object.keys(data).length });
}

/**
 * 记录订阅消息授权结果
 * 授权 +1，封顶 3 次（timer 打卡提醒的发送池），防无限推送骚扰
 */
async function handleGrantSubscribe(payload) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail(401, '未登录');

  const type = payload && payload.type === 'checkin' ? 'checkin' : null;
  if (!type) return fail(400, '未知订阅类型');

  const userRes = await db.collection('users').where({ _openid: OPENID }).limit(1).get();
  if (!userRes.data.length) return fail(404, '用户不存在');

  const current = ((userRes.data[0].subMsg || {})[type]) || 0;
  if (current >= 3) return ok({ granted: false, reason: 'quota_full' });

  await db
    .collection('users')
    .doc(userRes.data[0]._id)
    .update({ data: { [`subMsg.${type}`]: _.inc(1) } });

  return ok({ granted: true });
}

exports.main = async (event) => {
  const { action, payload = {} } = event;
  try {
    switch (action) {
      case 'stats':
        return await handleStats();
      case 'updateProfile':
        return await handleUpdateProfile(payload);
      case 'grantSubscribe':
        return await handleGrantSubscribe(payload);
      default:
        return fail(404, '未知操作: ' + action);
    }
  } catch (err) {
    console.error('[user] error', action, err);
    return fail(500, err.message || '服务异常');
  }
};
