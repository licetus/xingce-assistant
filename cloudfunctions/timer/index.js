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

/**
 * 打卡提醒：向「昨天打过、今天还没打」且仍有订阅配额的用户发订阅消息
 *
 * 一次性订阅消息每次授权只能发一条，users.subMsg.checkin 是剩余配额：
 * 前端打卡成功后拉授权（requestCheckinSubscribe），用户同意一次
 * user.grantSubscribe +1（封顶 3）；这里发送成功 -1。配额自然衰减，
 * 长期未授权的用户不会被打扰。
 *
 * 模板字段 key（thing1/thing2/date1...）因申请的模板而异，放
 * config.checkin_tmpl_fields = { date: 'thing1', streak: 'thing2' } 可热更，
 * 字段对不上时不用发版，控制台改 config 即可。
 */
async function handleCheckinNotice() {
  const cfgRes = await db.collection('config').limit(20).get();
  const cfg = {};
  cfgRes.data.forEach((c) => {
    cfg[c.key] = c.value;
  });

  const tmplId = cfg.checkin_tmpl_id;
  if (!tmplId) return ok({ skipped: 'no_tmpl_id' });

  const fields = cfg.checkin_tmpl_fields || {};
  const dateKey = fields.date || 'thing1';
  const streakKey = fields.streak || 'thing2';

  const today = todayStr();
  // 提醒对象：昨天/前天打过（连续中或刚断一天，最有挽回价值）、今天还没打、有配额。
  // 今天打卡会把 lastDate 更新为 today，天然不会重复提醒。
  const activeDays = [
    todayStr(new Date(Date.now() - 24 * 60 * 60 * 1000)),
    todayStr(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000))
  ];

  const res = await db
    .collection('users')
    .where({
      'subMsg.checkin': _.gt(0),
      'checkin.lastDate': _.in(activeDays)
    })
    .limit(200)
    .get();

  let sent = 0;
  let failed = 0;
  for (const u of res.data) {
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: u._openid,
        templateId: tmplId,
        page: 'pages/index/index',
        data: {
          [dateKey]: { value: today },
          [streakKey]: { value: `${(u.checkin && u.checkin.streak) || 0}天` }
        }
      });
      // 发送成功才扣配额；失败保留，下次提醒再试
      await db
        .collection('users')
        .doc(u._id)
        .update({ data: { 'subMsg.checkin': _.inc(-1) } });
      sent += 1;
    } catch (e) {
      failed += 1;
      // 常见失败：47003 模板字段不匹配 → 改 config.checkin_tmpl_fields；
      // 43101 用户拒收 → 配额下次授权后恢复
      console.error('[timer] notice send failed', u._openid, e.errCode || e.message);
    }
  }
  return ok({ candidates: res.data.length, sent, failed, today });
}

exports.main = async (event) => {
  // 云函数间调用走 event.action；定时触发器的 event 是
  // { Type: 'Timer', TriggerName: 'dailyTask' }，需要映射（此前漏了这层，
  // 定时任务一直 404，靠手动调用掩盖了问题）
  const triggerName = event && event.Type === 'Timer' ? event.TriggerName : '';
  const action = event && event.action ? event.action : triggerName;
  const payload = (event && event.payload) || {};
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
      case 'notify':
        return await handleCheckinNotice();
      default:
        return fail(404, '未知操作: ' + action);
    }
  } catch (err) {
    console.error('[timer] error', action, err);
    return fail(500, err.message || '服务异常');
  }
};
