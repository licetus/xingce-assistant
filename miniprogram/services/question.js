const { call } = require('../utils/cloud');

/**
 * 抽题
 * 注意：云端返回的题目不含 answer / analysis，客户端无法本地判题。
 * 这是刻意设计——题库是核心资产，杜绝客户端拖库。
 */
function draw({ module = '', count = 10, scene = 'practice', subtype = '' }) {
  return call(
    'question',
    'draw',
    { module, count, scene, subtype },
    { loading: true, loadingText: '出题中' }
  );
}

function detail(qid) {
  return call('question', 'detail', { qid }, { silent: true });
}

/** 材料题的共用材料（资料分析/言语理解），单独拉取，多题共享一份 */
function material(gid) {
  return call('question', 'material', { gid }, { silent: true });
}

/** 题库页：五大模块的题量与用户作答进度 */
function moduleStats() {
  return call('question', 'moduleStats', {}, { silent: true });
}

/** 题库页：某模块的二级考点列表，用于筛选 chips */
function subtypes(module) {
  return call('question', 'subtypes', { module }, { silent: true });
}

module.exports = { draw, detail, material, moduleStats, subtypes };
