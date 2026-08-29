const { call } = require('../utils/cloud');
const store = require('../utils/store');

/** 打卡日历：近 30 天打卡情况 + 连续天数 + 总天数 */
function calendar() {
  return call('checkin', 'calendar', {}, { silent: true });
}

/** 完成每日任务后打卡，返回连续天数（可能触发订阅消息授权时机） */
function submit({ doneCount, correctCount, durationSec }) {
  return call(
    'checkin',
    'submit',
    { doneCount, correctCount, durationSec },
    { loading: true, loadingText: '打卡中' }
  ).then((res) => {
    store.setCheckinToday(true);
    return res;
  });
}

/** 周榜 / 总榜，读云端缓存集合，不实时聚合 */
function rank(type = 'week') {
  return call('rank', 'list', { type }, { silent: true });
}

module.exports = { calendar, submit, rank };
