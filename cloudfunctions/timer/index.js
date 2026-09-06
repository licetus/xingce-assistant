const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const ok = (data) => ({ code: 0, data, message: 'ok' });
const fail = (code, message) => ({ code, data: null, message });

const MODULES = ['常识判断', '言语理解', '数量关系', '判断推理', '资料分析'];
const DAILY_COUNT = 10;

function todayStr(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate());
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 生成每日打卡题目
 *
 * 所有人同一套题——保证排行榜公平，也让 daily_task 只有 365 条记录就能覆盖全年。
 * 五大模块各抽 2 题，难度固定在 2~4（避开偏题怪题，打卡是培养习惯不是劝退）。
 */
async function handleDailyTask(payload) {
  const date = payload && payload.date ? payload.date : todayStr();

  const exist = await db.collection('daily_task').where({ date }).limit(1).get();
  if (exist.data.length && !(payload && payload.force)) {
    return ok({ date, skipped: true });
  }

  const perModule = Math.floor(DAILY_COUNT / MODULES.length);
  const picked = [];

  for (const mod of MODULES) {
    const res = await db
      .collection('questions')
      .where({ module: mod, status: 1, difficulty: _.gte(2).and(_.lte(4)) })
      .field({ qid: true })
      .limit(200)
      .get();

    picked.push(...shuffle(res.data).slice(0, perModule).map((q) => q.qid));
  }

  // 模块题量不均导致不足时，随机补齐
  if (picked.length < DAILY_COUNT) {
    const res = await db
      .collection('questions')
      .where({ status: 1, difficulty: _.gte(2).and(_.lte(4)) })
      .field({ qid: true })
      .limit(300)
      .get();
    const used = new Set(picked);
    picked.push(
      ...shuffle(res.data.filter((q) => !used.has(q.qid)))
        .slice(0, DAILY_COUNT - picked.length)
        .map((q) => q.qid)
    );
  }

  const qids = shuffle(picked).slice(0, DAILY_COUNT);

  if (exist.data.length) {
    await db.collection('daily_task').doc(exist.data[0]._id).update({ data: { qids, updatedAt: db.serverDate() } });
  } else {
    await db.collection('daily_task').add({ data: { date, qids, createdAt: db.serverDate() } });
  }

  return ok({ date, qids });
}

/** 刷新排行榜缓存，避免榜单页实时聚合 500 万级 checkins */
async function handleRebuildRank() {
  const res = await cloud.callFunction({ name: 'rank', data: { action: 'rebuild', payload: {} } });
  return ok(res.result);
}

/**
 * 归档冷数据：90 天前的答题流水移出主集合
 * records 增长最快（日活 1 万时月增约 900 万条），不清理会拖慢查询并推高存储费用
 */
async function handleArchive() {
  const before = todayStr(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
  const res = await db
    .collection('records')
    .where({ date: _.lt(before) })
    .limit(1000)
    .remove()
    .catch(() => ({ stats: { removed: 0 } }));

  return ok({ removed: (res.stats && res.stats.removed) || 0, before });
}

/**
 * 健康巡检：检查 daily_task / rank_cache / records / users 集合状态
 *
 * 由 `healthCheck` 定时触发器每天 09:10 触发（晚于 dailyTask 00:05，留出 9 小时容错窗口）。
 * 任何子项失败都会写一条 type=health_alert 到 events 集合，可在管理后台 / CLS 日志里查。
 *
 * 注意：故意不调外网 webhook——云函数默认不开外网，避免对环境出流量计费。
 * 真要推送，把 webhook URL 写进 config.health_webhook，用 wx-server-sdk 的
 * cloud.callFunction + 内部 HTTP 函数转发（不走外网）。
 */
async function handleHealthCheck() {
  const today = todayStr();
  const checks = [];

  // 1. daily_task 今日是否生成（dailyTask 触发器是否成功跑）
  try {
    const dtRes = await db.collection('daily_task').where({ date: today }).limit(1).get();
    checks.push({ name: 'daily_task_today', ok: dtRes.data.length > 0, today });
  } catch (e) {
    checks.push({ name: 'daily_task_today', ok: false, error: e.message });
  }

  // 2. rank_cache 是否有数据（rebuildRank 触发器是否成功跑）
  try {
    const rcRes = await db.collection('rank_cache').limit(1).get();
    checks.push({ name: 'rank_cache_any', ok: rcRes.data.length > 0 });
  } catch (e) {
    checks.push({ name: 'rank_cache_any', ok: false, error: e.message });
  }

  // 3. records 总数（容量预警：1000 万条为硬上限，500 万条为软预警）
  try {
    const recRes = await db.collection('records').count();
    checks.push({
      name: 'records_count',
      ok: recRes.total < 10_000_000,
      count: recRes.total,
      warn: recRes.total > 5_000_000
    });
  } catch (e) {
    checks.push({ name: 'records_count', ok: false, error: e.message });
  }

  // 4. users 总数（用户量指标，不算失败）
  try {
    const uRes = await db.collection('users').count();
    checks.push({ name: 'users_count', ok: true, count: uRes.total });
  } catch (e) {
    checks.push({ name: 'users_count', ok: false, error: e.message });
  }

  const failed = checks.filter((c) => !c.ok);
  const healthy = failed.length === 0;

  // 异常 → 写 events 集合（不阻塞返回，让监控知道出问题了）
  if (!healthy) {
    try {
      await db.collection('events').add({
        data: {
          type: 'health_alert',
          level: failed.length > 1 ? 'critical' : 'warn',
          checks,
          failed: failed.map((f) => f.name),
          createdAt: db.serverDate()
        }
      });
    } catch (e) {
      console.error('[timer] healthCheck write event failed', e);
    }
  }

  return ok({ healthy, checks, failed: failed.length, ts: Date.now() });
}

exports.main = async (event) => {
  const { action, payload = {} } = event;
  try {
    switch (action) {
      case 'dailyTask':
        return await handleDailyTask(payload);
      case 'rebuildRank':
        return await handleRebuildRank();
      case 'archive':
        return await handleArchive();
      case 'healthCheck':
        return await handleHealthCheck();
      default:
        return fail(404, '未知操作: ' + action);
    }
  } catch (err) {
    console.error('[timer] error', action, err);
    return fail(500, err.message || '服务异常');
  }
};
