const { call } = require('../utils/cloud');

/** 错题本列表（默认只看未掌握） */
function list(page = 0, size = 20, opts = {}) {
  return call('wrongbook', 'list', { page, size, ...opts }, { silent: true });
}

/** 错题重做：取最久未复习的未掌握错题，贴合遗忘曲线 */
function redraw(count = 10) {
  return call('wrongbook', 'redraw', { count }, { loading: true, loadingText: '出题中' });
}

/** 手动移出错题本 */
function remove(qid) {
  return call('wrongbook', 'remove', { qid }, { silent: true });
}

module.exports = { list, redraw, remove };
