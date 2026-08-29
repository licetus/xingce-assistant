const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const CACHE_MS = 5 * 60 * 1000;

const ok = (data) => ({ code: 0, data, message: 'ok' });
const fail = (code, message) => ({ code, data: null, message });

function emptyStats() {
  const byModule = {};
  ['常识判断', '言语理解', '数量关系', '判断推理', '资料分析'].forEach((m) => {
    byModule[m] = { done: 0, correct: 0 };
  });
  return { totalDone: 0, totalCorrect: 0, byModule };
}

function newUser(openid, inviteBy) {
  return {
    _openid: openid,
    profile: { nickName: '', avatarUrl: '', grade: '' },
    inviteBy: inviteBy || null,
    checkin: { streak: 0, maxStreak: 0, lastDate: '', totalDays: 0 },
    stats: emptyStats(),
    subMsg: { checkin: 0 },
    createdAt: db.serverDate(),
    lastActiveAt: db.serverDate()
  };
}

/**
 * 登录 / 注册
 *
 * 幂等：每次冷启动都会调用，但只在「新用户」或「距上次活跃超过 5 分钟」时写库，
 * 避免高频调用把数据库写配额打满。
 */
async function handleLogin(payload) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail(401, '无法获取用户身份');

  const users = db.collection('users');
  const exist = await users.where({ _openid: OPENID }).limit(1).get();

  if (exist.data.length === 0) {
    const doc = newUser(OPENID, payload.inviteBy);
    await users.add({ data: doc });
    return ok({ openid: OPENID, user: { ...doc, createdAt: Date.now(), lastActiveAt: Date.now() }, isNew: true });
  }

  const user = exist.data[0];
  const last = user.lastActiveAt ? new Date(user.lastActiveAt).getTime() : 0;
  const shouldTouch = !last || Date.now() - last > CACHE_MS;

  if (shouldTouch) {
    await users.doc(user._id).update({
      data: {
        lastActiveAt: db.serverDate(),
        // 补记邀请关系：用户可能是从分享链接首次进入的
        ...(!user.inviteBy && payload.inviteBy ? { inviteBy: payload.inviteBy } : {})
      }
    });
  }

  return ok({ openid: OPENID, user, isNew: false });
}

/** 运营配置一次性拉全，前端按 key 取用 */
async function handleConfig() {
  const res = await db.collection('config').limit(20).get();
  const map = {};
  res.data.forEach((item) => {
    map[item.key] = item.value;
  });
  return ok(map);
}

exports.main = async (event) => {
  const { action, payload = {} } = event;
  try {
    switch (action) {
      case 'login':
        return await handleLogin(payload);
      case 'config':
        return await handleConfig();
      default:
        return fail(404, '未知操作: ' + action);
    }
  } catch (err) {
    console.error('[login] error', action, err);
    return fail(500, err.message || '服务异常');
  }
};
