/**
 * 轻量全局状态 + 事件总线
 *
 * 不引入 mobx-miniprogram（约 30KB）：V1 的跨页状态只有「用户资料」和「错题数」两项，
 * 一个发布订阅就够，省下的体积留给业务。
 */

const listeners = {};

const state = {
  user: null,
  wrongCount: 0,
  checkinToday: false
};

function on(event, fn) {
  if (!listeners[event]) listeners[event] = [];
  listeners[event].push(fn);
  return () => off(event, fn);
}

function off(event, fn) {
  if (!listeners[event]) return;
  listeners[event] = listeners[event].filter((item) => item !== fn);
}

function emit(event, payload) {
  (listeners[event] || []).slice().forEach((fn) => {
    try {
      fn(payload);
    } catch (err) {
      console.error('[store] listener error', event, err);
    }
  });
}

function setUser(user) {
  state.user = user;
  if (user && user.checkin) {
    state.checkinToday = user.checkin.lastDate === require('./format').today();
  }
  emit('user', user);
}

function setWrongCount(n) {
  if (state.wrongCount === n) return;
  state.wrongCount = n;
  emit('wrongCount', n);
}

function setCheckinToday(done) {
  state.checkinToday = done;
  emit('checkinToday', done);
}

module.exports = {
  state,
  on,
  off,
  emit,
  setUser,
  setWrongCount,
  setCheckinToday
};
