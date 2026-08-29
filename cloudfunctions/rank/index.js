const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const ok = (data) => ({ code: 0, data, message: 'ok' });
const fail = (code, message) => ({ code, data: null, message });

function todayStr(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate());
}

function offsetDay(n, base = new Date()) {
  return todayStr(new Date(base.getTime() + n * 24 * 60 * 60 * 1000));
}

/**
 * 排行榜
 *
 * 关键设计：绝不实时聚合 checkins（500 万级）。
 * 由 timer 定时任务每小时把前 200 名算好写进 rank_week，这里只读缓存。
 * 缓存缺失时降级为实时聚合前 50 名，保证功能不空。
 */
async function handleList(payload) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail(401, '未登录');

  const type = payload.type === 'total' ? 'total' : 'week';
  const cacheKey = type === 'week' ? 'week' : 'total';

  const cached = await db.collection('rank_cache').doc(cacheKey).get().catch(() => null);

  let list = [];
  if (cached && cached.data && cached.data.list) {
    list = cached.data.list;
  } else {
    list = await buildRank(type);
  }

  const myIndex = list.findIndex((i) => i._openid === OPENID);
  const me =
    myIndex >= 0
      ? { rank: myIndex + 1, ...list[myIndex] }
      : await buildSelf(OPENID, type);

  return ok({
    list: list.slice(0, 100),
    me,
    updatedAt: cached && cached.data ? cached.data.updatedAt : null
  });
}

async function buildRank(type) {
  const where = type === 'week' ? { date: _.gte(offsetDay(-6)) } : {};

  const res = await db
    .collection('checkins')
    .aggregate()
    .match(where)
    .group({ _id: '$_openid', totalCorrect: _.sum('$correctCount'), totalDone: _.sum('$doneCount'), days: _.sum(1) })
    .sort({ totalCorrect: -1 })
    .limit(200)
    .end()
    .catch(() => ({ list: [] }));

  const rows = res.list || [];

  const uids = rows.map((r) => r._id);
  const users = uids.length
    ? await db.collection('users').where({ _openid: _.in(uids) }).limit(200).get().catch(() => ({ data: [] }))
    : { data: [] };
  const uMap = {};
  users.data.forEach((u) => (uMap[u._openid] = u));

  return rows.map((r) => ({
    _openid: r._id,
    nickName: (uMap[r._id] && uMap[r._id].profile && uMap[r._id].profile.nickName) || '考友',
    avatarUrl: (uMap[r._id] && uMap[r._id].profile && uMap[r._id].profile.avatarUrl) || '',
    totalCorrect: r.totalCorrect,
    totalDone: r.totalDone,
    days: r.days
  }));
}

async function buildSelf(openid, type) {
  const where = Object.assign({ _openid: openid }, type === 'week' ? { date: _.gte(offsetDay(-6)) } : {});
  const mine = await db
    .collection('checkins')
    .aggregate()
    .match(where)
    .group({ _id: '$_openid', totalCorrect: _.sum('$correctCount'), totalDone: _.sum('$doneCount'), days: _.sum(1) })
    .end()
    .catch(() => ({ list: [] }));

  const r = (mine.list || [])[0];
  if (!r) return { rank: 0, totalCorrect: 0, totalDone: 0, days: 0, nickName: '考友' };

  const all = await buildRank(type);
  const idx = all.findIndex((i) => i._openid === openid);
  return {
    rank: idx >= 0 ? idx + 1 : 0,
    _openid: openid,
    totalCorrect: r.totalCorrect,
    totalDone: r.totalDone,
    days: r.days
  };
}

/** 由 timer 定时调用，刷新榜单缓存 */
async function handleRebuild() {
  const week = await buildRank('week');
  const total = await buildRank('total');
  const now = new Date();

  await db.collection('rank_cache').doc('week').set({
    data: { list: week, updatedAt: now }
  });
  await db.collection('rank_cache').doc('total').set({
    data: { list: total, updatedAt: now }
  });

  return ok({ week: week.length, total: total.length });
}

exports.main = async (event) => {
  const { action, payload = {} } = event;
  try {
    switch (action) {
      case 'list':
        return await handleList(payload);
      case 'rebuild':
        return await handleRebuild();
      default:
        return fail(404, '未知操作: ' + action);
    }
  } catch (err) {
    console.error('[rank] error', action, err);
    return fail(500, err.message || '服务异常');
  }
};
