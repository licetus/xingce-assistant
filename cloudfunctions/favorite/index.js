const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const ok = (data) => ({ code: 0, data, message: 'ok' });
const fail = (code, message) => ({ code, data: null, message });

/** 收藏状态依赖唯一索引 (_openid + qid) 防重复，这里不额外查一次，靠 errCode 判重 */
async function handleAdd(payload) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail(401, '未登录');

  const qid = Number(payload.qid);
  if (!qid) return fail(400, '缺少题目 ID');

  try {
    await db.collection('favorites').add({
      data: { _openid: OPENID, qid, createdAt: db.serverDate() }
    });
  } catch (err) {
    if (err && err.errCode === -502005) {
      return ok({ favorited: true, duplicated: true });
    }
    throw err;
  }

  return ok({ favorited: true });
}

async function handleRemove(payload) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail(401, '未登录');

  const qid = Number(payload.qid);
  if (!qid) return fail(400, '缺少题目 ID');

  await db.collection('favorites').where({ _openid: OPENID, qid }).remove();
  return ok({ favorited: false });
}

async function handleToggle(payload) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail(401, '未登录');

  const qid = Number(payload.qid);
  const exist = await db.collection('favorites').where({ _openid: OPENID, qid }).limit(1).get();

  if (exist.data.length) {
    await db.collection('favorites').where({ _openid: OPENID, qid }).remove();
    return ok({ favorited: false });
  }

  await db.collection('favorites').add({
    data: { _openid: OPENID, qid, createdAt: db.serverDate() }
  });
  return ok({ favorited: true });
}

async function handleList(payload) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail(401, '未登录');

  const page = Math.max(0, Number(payload.page) || 0);
  const size = Math.min(Math.max(Number(payload.size) || 20, 1), 50);

  const res = await db
    .collection('favorites')
    .where({ _openid: OPENID })
    .orderBy('createdAt', 'desc')
    .skip(page * size)
    .limit(size)
    .get();

  if (!res.data.length) return ok({ list: [], hasMore: false });

  const qids = res.data.map((f) => f.qid);
  const qRes = await db.collection('questions').where({ qid: _.in(qids) }).limit(50).get();
  const qMap = {};
  qRes.data.forEach((q) => (qMap[q.qid] = q));

  return ok({
    list: qids
      .filter((id) => qMap[id])
      .map((id) => ({
        qid: id,
        stem: qMap[id].stem,
        module: qMap[id].module,
        subtype: qMap[id].subtype
      })),
    hasMore: res.data.length === size
  });
}

exports.main = async (event) => {
  const { action, payload = {} } = event;
  try {
    switch (action) {
      case 'add':
        return await handleAdd(payload);
      case 'remove':
        return await handleRemove(payload);
      case 'toggle':
        return await handleToggle(payload);
      case 'list':
        return await handleList(payload);
      default:
        return fail(404, '未知操作: ' + action);
    }
  } catch (err) {
    console.error('[favorite] error', action, err);
    return fail(500, err.message || '服务异常');
  }
};
