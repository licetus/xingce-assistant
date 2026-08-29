const { call } = require('../utils/cloud');

function toggle(qid) {
  return call('favorite', 'toggle', { qid }, { silent: true });
}

function list(page = 0, size = 20) {
  return call('favorite', 'list', { page, size }, { silent: true });
}

module.exports = { toggle, list };
