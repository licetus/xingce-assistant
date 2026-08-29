/**
 * 埋点上报
 *
 * V1 用云数据库落库即可，量大了再换成微信自建分析或第三方。
 * 上报必须「失败静默」——任何情况下不能因为埋点影响主流程。
 */

const { call } = require('./cloud');
const cache = require('./cache');

const BATCH_KEY = 'track_queue';
const FLUSH_SIZE = 10;

let queue = cache.get(BATCH_KEY, []);

function push(event, payload = {}) {
  queue.push({
    event,
    payload,
    ts: Date.now()
  });

  if (queue.length >= FLUSH_SIZE) {
    flush();
  } else {
    cache.set(BATCH_KEY, queue, 7 * cache.DAY);
  }
}

function flush() {
  if (!queue.length) return;
  const batch = queue.slice();
  queue = [];
  cache.set(BATCH_KEY, queue, 7 * cache.DAY);

  call('track', 'batch', { events: batch }, { silent: true }).catch(() => {
    // 上报错了把数据塞回去，下次再试（最多保留 200 条，防止无限膨胀）
    queue = batch.concat(queue).slice(0, 200);
    cache.set(BATCH_KEY, queue, 7 * cache.DAY);
  });
}

function error(name, detail) {
  push('error', { name, detail });
}

/** 页面 PV，配合 onLoad 使用 */
function page(path) {
  push('page_view', { path });
}

module.exports = { push, flush, error, page };
