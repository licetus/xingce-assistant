const MODULES = ['常识判断', '言语理解', '数量关系', '判断推理', '资料分析'];

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** 东八区日期字符串 YYYY-MM-DD —— 打卡、榜单全部以东八区为准，不能用 UTC */
function today(date = new Date()) {
  const d = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

/** 相对今天偏移 n 天的日期串，n 为负表示过去 */
function offsetDay(n, base = new Date()) {
  const d = new Date(base.getTime() + n * 24 * 60 * 60 * 1000);
  return today(d);
}

/** 毫秒转 mm:ss */
function duration(ms) {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return pad(m) + ':' + pad(s);
}

/** 毫秒转「1分20秒」，用于战报海报 */
function durationText(ms) {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? m + '分' + s + '秒' : s + '秒';
}

function percent(correct, total) {
  if (!total) return 0;
  return Math.round((correct / total) * 100);
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + '分钟前';
  if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + '小时前';
  if (diff < 7 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + '天前';
  const d = new Date(ts);
  return d.getMonth() + 1 + '月' + d.getDate() + '日';
}

module.exports = { MODULES, today, offsetDay, duration, durationText, percent, relativeTime, pad };
