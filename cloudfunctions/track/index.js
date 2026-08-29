const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const ok = (data) => ({ code: 0, data, message: 'ok' });
const fail = (code, message) => ({ code, data: null, message });

/**
 * 埋点批量写入
 * 客户端攒够 10 条发一次，这里按顺序写入，失败只记录不抛错——埋点绝不能影响业务
 */
async function handleBatch(payload) {
  const { OPENID } = cloud.getWXContext();
  const events = payload.events || [];
  if (!events.length) return ok({ count: 0 });

  const docs = events.slice(0, 50).map((e) => ({
    _openid: OPENID || '',
    event: String(e.event || '').slice(0, 64),
    payload: e.payload || {},
    ts: e.ts ? new Date(e.ts) : db.serverDate(),
    createdAt: db.serverDate()
  }));

  let done = 0;
  for (const doc of docs) {
    try {
      await db.collection('events').add({ data: doc });
      done += 1;
    } catch (err) {
      console.error('[track] write failed', err);
    }
  }

  return ok({ count: done });
}

exports.main = async (event) => {
  try {
    const { action, payload = {} } = event;
    if (action === 'batch') return await handleBatch(payload);
    return fail(404, '未知操作: ' + action);
  } catch (err) {
    console.error('[track] error', err);
    return fail(500, err.message || '服务异常');
  }
};
