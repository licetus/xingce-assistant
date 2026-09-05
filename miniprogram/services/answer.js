const { call } = require('../utils/cloud');
const cache = require('../utils/cache');
const store = require('../utils/store');

const PENDING_KEY = 'pending_answers';
const MAX_RETRY = 3;

function getPending() {
  return cache.get(PENDING_KEY, []);
}

function savePending(list) {
  cache.set(PENDING_KEY, list, 7 * cache.DAY);
}

/**
 * 提交作答
 * 做完 10 题一次性提交，云端单事务完成判题 + 流水 + 错题本 + 统计，一次网络往返搞定。
 * @param {object} payload  { scene, items, taskId? }
 * @param {object} [opts]   透传 utils/cloud.call 的选项（submitSafe 用 silent + retry:0 快速失败）
 */
function submit(payload, opts = {}) {
  const { scene = 'practice', items = [] } = payload;
  if (!items.length) return Promise.resolve(null);

  return call(
    'answer',
    'submit',
    { scene, items, taskId: payload.taskId },
    { loading: true, loadingText: '判题中', ...opts }
  ).then((res) => {
    if (res && typeof res.wrongCount === 'number') {
      store.setWrongCount(res.wrongCount);
    }
    return res;
  });
}

/** 断网时落本地队列 */
function enqueue(payload) {
  const list = getPending();
  list.push({ ...payload, retry: 0, createdAt: Date.now() });
  savePending(list);
}

/** 尝试提交，失败自动入队；调用方无需关心网络状态 */
function submitSafe(payload) {
  // 静默 + 不重试：断网时快速失败入队，避免「网络不太给力」和「已保存」两个 toast 连弹，
  // 也避免默认重试 2 次（约 1.2s）拖慢离线体验
  return submit(payload, { silent: true, retry: 0 }).catch(() => {
    enqueue(payload);
    wx.showToast({ title: '已保存，联网后自动提交', icon: 'none' });
    return null;
  });
}

/** 网络恢复 / 冷启动时补交，每个包最多重试 3 次 */
function flushPending() {
  const list = getPending();
  if (!list.length) return Promise.resolve(0);

  let chain = Promise.resolve();
  const remain = [];
  let okCount = 0;

  list.forEach((item) => {
    chain = chain.then(() =>
      call('answer', 'submit', item, { silent: true, retry: 0 })
        .then(() => {
          okCount += 1;
        })
        .catch(() => {
          item.retry = (item.retry || 0) + 1;
          if (item.retry < MAX_RETRY) remain.push(item);
        })
    );
  });

  return chain.then(() => {
    savePending(remain);
    return okCount;
  });
}

module.exports = { submit, submitSafe, flushPending, getPending };
