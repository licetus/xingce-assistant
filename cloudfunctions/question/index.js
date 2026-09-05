const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const RECENT_DAYS = 7;

/** 行测五大模块，顺序与题库页展示顺序一致 */
const MODULES = ['常识判断', '言语理解', '数量关系', '判断推理', '资料分析'];

const CACHE_MS = 5 * 60 * 1000;

/**
 * 模块题量与考点列表的进程内缓存。
 * 题库是固定的（1~2 万条），只在导入新题后才变化，没必要每次请求都 count。
 * 云函数实例复用期间有效，冷启动后自动重建，最多有 5 分钟的陈旧窗口。
 */
let moduleCountCache = null;
let moduleCountCacheAt = 0;
const subtypeCache = {};

const ok = (data) => ({ code: 0, data, message: 'ok' });
const fail = (code, message) => ({ code, data: null, message });

/** 东八区今天 */
function todayStr(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate());
}

/** 返回给客户端前剥除答案与解析，杜绝题库泄露 */
function sanitize(q) {
  return {
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
  };
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sample(list, n) {
  return shuffle(list).slice(0, n);
}

/**
 * 按用户近期正确率动态配比难度，避免新手一上来被难题劝退
 * 返回三个难度桶的占比
 */
function difficultyMix(rate) {
  if (rate >= 0.8) return { easy: 0, mid: 0.7, hard: 0.3 };
  if (rate >= 0.4) return { easy: 0.2, mid: 0.6, hard: 0.2 };
  return { easy: 0.5, mid: 0.5, hard: 0 };
}

/** 取用户近 N 天答过的 qid，用于去重（结果缓存 5 分钟） */
async function recentQids(openid) {
  const from = Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000;
  let set = new Set();
  let lastId = null;

  // records 集合量大，用分页游标遍历，每页 1000（云开发单次上限）
  for (let i = 0; i < 10; i++) {
    let query = db
      .collection('records')
      .where({ _openid: openid, createdAt: _.gte(from) })
      .orderBy('createdAt', 'desc')
      .limit(1000);

    if (lastId) query = query.where({ createdAt: _.lt(lastId) });

    const page = await query.field({ qid: true, createdAt: true }).get();
    if (!page.data.length) break;

    page.data.forEach((r) => set.add(r.qid));
    const last = page.data[page.data.length - 1];
    lastId = last.createdAt;

    if (page.data.length < 1000) break;
  }

  return set;
}

/**
 * 抽题
 *
 * scene=checkin 时所有人共用 daily_task 预生成的题目，保证公平且可缓存；
 * scene=practice 时按模块 + 难度配比 + 近期去重动态抽取。
 */
async function handleDraw(payload) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail(401, '未登录');

  const { module = '', count = 10, scene = 'practice', subtype = '' } = payload;
  const size = Math.min(Math.max(parseInt(count, 10) || 10, 1), 50);

  // 打卡场景：读预生成的每日任务，所有人同一套题
  if (scene === 'checkin') {
    const date = todayStr();
    const task = await db.collection('daily_task').where({ date }).limit(1).get();
    if (!task.data.length) return fail(404, '今日题目还没准备好，请稍后再来');

    const qids = (task.data[0].qids || []).slice(0, size);
    const res = await db.collection('questions').where({ qid: _.in(qids) }).limit(50).get();
    const order = {};
    qids.forEach((id, i) => (order[id] = i));
    const list = res.data.sort((a, b) => (order[a.qid] ?? 99) - (order[b.qid] ?? 99));
    return ok({ taskId: date, list: list.map(sanitize) });
  }

  const where = { status: 1 };
  if (module) where.module = module;
  if (subtype) where.subtype = subtype;

  // 题库量级 1~2 万，一次性捞回按 difficulty 分桶，比 $sample 更可控
  const pool = await db
    .collection('questions')
    .where(where)
    .field({ qid: true, module: true, subtype: true, type: true, stem: true, options: true,
             difficulty: true, tags: true, materialId: true, images: true })
    .limit(1000)
    .get();

  if (!pool.data.length) return fail(404, '该模块暂无题目');

  const user = await db.collection('users').where({ _openid: OPENID }).limit(1).get();
  const stats = (user.data[0] && user.data[0].stats) || { totalDone: 0, totalCorrect: 0, byModule: {} };
  const modStat = module && stats.byModule && stats.byModule[module]
    ? stats.byModule[module]
    : { done: stats.totalDone || 0, correct: stats.totalCorrect || 0 };
  const rate = modStat.done > 0 ? modStat.correct / modStat.done : 0.5;

  const done = await recentQids(OPENID);
  let candidates = pool.data.filter((q) => !done.has(q.qid));

  // 题目做完了就放宽去重限制，允许重刷
  if (candidates.length < size) candidates = pool.data;

  const mix = difficultyMix(rate);
  const buckets = { easy: [], mid: [], hard: [] };
  candidates.forEach((q) => {
    const d = q.difficulty || 3;
    if (d <= 2) buckets.easy.push(q);
    else if (d === 3) buckets.mid.push(q);
    else buckets.hard.push(q);
  });

  let picked = [];
  Object.keys(mix).forEach((k) => {
    const want = Math.round(size * mix[k]);
    if (want > 0) picked = picked.concat(sample(buckets[k], want));
  });

  // 配比取整可能有缺口，用剩余候选补齐
  if (picked.length < size) {
    const used = new Set(picked.map((q) => q.qid));
    picked = picked.concat(sample(candidates.filter((q) => !used.has(q.qid)), size - picked.length));
  }

  return ok({ taskId: null, list: shuffle(picked.slice(0, size)).map(sanitize) });
}

async function handleDetail(payload) {
  const { qid } = payload;
  const res = await db.collection('questions').where({ qid: Number(qid) }).limit(1).get();
  if (!res.data.length) return fail(404, '题目不存在');
  return ok(sanitize(res.data[0]));
}

async function handleMaterial(payload) {
  const { gid } = payload;
  const res = await db.collection('qgroups').where({ gid: Number(gid) }).limit(1).get();
  if (!res.data.length) return fail(404, '材料不存在');
  return ok({ gid: res.data[0].gid, material: res.data[0].material, images: res.data[0].images });
}

/**
 * 题库页：五大模块的题量与用户作答进度
 *
 * 题量走 count 并缓存 5 分钟；用户进度直接读 users.stats.byModule（已冗余，无需聚合 records）。
 */
async function handleModuleStats() {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail(401, '未登录');

  const now = Date.now();
  if (!moduleCountCache || now - moduleCountCacheAt > CACHE_MS) {
    const counts = {};
    await Promise.all(
      MODULES.map(async (m) => {
        const r = await db.collection('questions').where({ module: m, status: 1 }).count();
        counts[m] = r.total;
      })
    );
    moduleCountCache = counts;
    moduleCountCacheAt = now;
  }

  const user = await db.collection('users').where({ _openid: OPENID }).limit(1).get();
  const byModule = (user.data[0] && user.data[0].stats && user.data[0].stats.byModule) || {};

  const modules = MODULES.map((m) => {
    const s = byModule[m] || { done: 0, correct: 0 };
    const total = moduleCountCache[m] || 0;
    const done = s.done || 0;
    return {
      name: m,
      total,
      done,
      correct: s.correct || 0,
      // 进度按「做过多少题」算；题库为空时返回 0，避免除零
      progress: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
    };
  });

  return ok({ modules });
}

/**
 * 题库页：某模块的二级考点列表（用于筛选 chips）
 *
 * 云开发没有 distinct，这里只取 subtype 字段后在内存去重。
 * 单模块题目量级约 2~3 千，配合 module+status 索引可接受，结果同样缓存 5 分钟。
 */
async function handleSubtypes(payload) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail(401, '未登录');

  const { module } = payload || {};
  if (!module) return fail(400, '缺少模块参数');

  const now = Date.now();
  const hit = subtypeCache[module];
  if (hit && now - hit.at < CACHE_MS) return ok({ list: hit.list });

  const res = await db
    .collection('questions')
    .where({ module, status: 1 })
    .field({ subtype: true })
    .limit(1000)
    .get();

  const set = new Set();
  res.data.forEach((q) => {
    if (q.subtype) set.add(q.subtype);
  });
  const list = Array.from(set).sort();

  subtypeCache[module] = { at: now, list };
  return ok({ list });
}

exports.main = async (event) => {
  const { action, payload = {} } = event;
  try {
    switch (action) {
      case 'draw':
        return await handleDraw(payload);
      case 'detail':
        return await handleDetail(payload);
      case 'material':
        return await handleMaterial(payload);
      case 'moduleStats':
        return await handleModuleStats();
      case 'subtypes':
        return await handleSubtypes(payload);
      default:
        return fail(404, '未知操作: ' + action);
    }
  } catch (err) {
    console.error('[question] error', action, err);
    return fail(500, err.message || '服务异常');
  }
};
