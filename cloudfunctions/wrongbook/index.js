const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const ok = (data) => ({ code: 0, data, message: 'ok' });
const fail = (code, message) => ({ code, data: null, message });

/** 错题本列表：分页 + 关联题目 */
async function handleList(payload) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail(401, '未登录');

  const page = Math.max(0, Number(payload.page) || 0);
  const size = Math.min(Math.max(Number(payload.size) || 20, 1), 50);
  const onlyUnmastered = payload.mastered !== true;

  // 默认只看未掌握；mastered=true 时查看全部（含已掌握），不过滤该字段
  const where = { _openid: OPENID };
  if (onlyUnmastered) where.mastered = false;

  const [res, countRes] = await Promise.all([
    db.collection('wrong_book')
      .where(where)
      .orderBy('lastWrongAt', 'desc')
      .skip(page * size)
      .limit(size)
      .get(),
    db.collection('wrong_book').where(where).count()
  ]);

  if (!res.data.length) return ok({ list: [], total: 0, hasMore: false });

  const qids = res.data.map((w) => w.qid);
  const qRes = await db.collection('questions').where({ qid: _.in(qids) }).limit(50).get();
  const qMap = {};
  qRes.data.forEach((q) => (qMap[q.qid] = q));

  const list = res.data
    .filter((w) => qMap[w.qid]) // 题目已下架，错题自动消失
    .map((w) => ({
      qid: w.qid,
      wrongCount: w.wrongCount,
      mastered: w.mastered,
      lastWrongAt: w.lastWrongAt,
      stem: qMap[w.qid].stem,
      module: qMap[w.qid].module,
      subtype: qMap[w.qid].subtype
    }));

  return ok({
    list,
    total: countRes.total,
    hasMore: (page + 1) * size < countRes.total
  });
}

/** 手动移出错题本（用户认为已经会了） */
async function handleRemove(payload) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail(401, '未登录');

  const qid = Number(payload.qid);
  if (!qid) return fail(400, '缺少题目 ID');

  await db
    .collection('wrong_book')
    .where({ _openid: OPENID, qid })
    .update({ data: { mastered: true } });

  return ok({ removed: true });
}

/** 错题重做：只抽未掌握的，最多 20 题 */
async function handleRedraw(payload) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail(401, '未登录');

  const size = Math.min(Math.max(Number(payload.count) || 10, 1), 20);

  const res = await db
    .collection('wrong_book')
    .where({ _openid: OPENID, mastered: false })
    .orderBy('lastWrongAt', 'asc') // 最久没复习的先练，贴合遗忘曲线
    .limit(size)
    .get();

  if (!res.data.length) return ok({ list: [] });

  const qids = res.data.map((w) => w.qid);
  const qRes = await db.collection('questions').where({ qid: _.in(qids) }).limit(50).get();

  return ok({
    list: qRes.data.map((q) => ({
      qid: q.qid,
      module: q.module,
      subtype: q.subtype,
      type: q.type,
      stem: q.stem,
      options: q.options,
      difficulty: q.difficulty,
      tags: q.tags,
      materialId: q.materialId,
      images: q.images
    }))
  });
}

exports.main = async (event) => {
  const { action, payload = {} } = event;
  try {
    switch (action) {
      case 'list':
        return await handleList(payload);
      case 'remove':
        return await handleRemove(payload);
      case 'redraw':
        return await handleRedraw(payload);
      default:
        return fail(404, '未知操作: ' + action);
    }
  } catch (err) {
    console.error('[wrongbook] error', action, err);
    return fail(500, err.message || '服务异常');
  }
};
