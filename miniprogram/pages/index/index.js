const { getStats } = require('../../services/user');
const { calendar } = require('../../services/checkin');
const cache = require('../../utils/cache');
const store = require('../../utils/store');
const track = require('../../utils/track');
const fmt = require('../../utils/format');

const HOME_CACHE_KEY = 'home';

Page({
  data: {
    loading: true,
    nickName: '',
    totalDone: 0,
    accuracy: 0,
    streak: 0,
    todayChecked: false,
    wrongCount: 0,
    modules: [],
    showRank: true
  },

  onLoad() {
    // 先用缓存渲染，避免每次进首页都白屏等网络
    const cached = cache.get(HOME_CACHE_KEY, null);
    if (cached) {
      this.setData({ ...cached, loading: false });
    }

    this._load();
    store.on('wrongCount', (n) => this.setData({ wrongCount: n }));
    track.page('index');
  },

  onShow() {
    // 从刷题页返回时刷新统计，避免数据陈旧
    if (this._loaded) this._load(true);
  },

  async _load(silent = false) {
    getApp().onAppReady(async () => {
      const app = getApp();

      const [stats, cal] = await Promise.all([
        getStats().catch(() => null),
        calendar().catch(() => null)
      ]);

      const s = (stats && stats.stats) || { totalDone: 0, totalCorrect: 0, byModule: {} };
      const modules = fmt.MODULES.map((m) => {
        const r = (s.byModule && s.byModule[m]) || { done: 0, correct: 0 };
        return {
          name: m,
          done: r.done,
          accuracy: fmt.percent(r.correct, r.done)
        };
      });

      const payload = {
        loading: false,
        nickName: (stats && stats.profile && stats.profile.nickName) || '',
        totalDone: s.totalDone,
        accuracy: fmt.percent(s.totalCorrect, s.totalDone),
        streak: (cal && cal.streak) || 0,
        todayChecked: !!(cal && cal.todayChecked),
        wrongCount: (stats && stats.wrongCount) || 0,
        modules,
        showRank: app.canShow('rank')
      };

      this.setData(payload);
      cache.set(HOME_CACHE_KEY, payload, 5 * cache.MINUTE);
      this._loaded = true;
    });
  },

  onTapModule(e) {
    const { name } = e.currentTarget.dataset;
    track.push('tap_module', { module: name });
    wx.navigateTo({
      url: `/pages/practice/practice?module=${encodeURIComponent(name)}&scene=practice`
    });
  },

  onTapCheckin() {
    if (this.data.todayChecked) {
      wx.showToast({ title: '今天已打卡，明天再来', icon: 'none' });
      return;
    }
    track.push('tap_checkin');
    wx.navigateTo({
      url: '/pages/practice/practice?scene=checkin&mode=batch'
    });
  },

  onTapRank() {
    wx.navigateTo({ url: '/pkg-rank/pages/rank/rank' });
  },

  onTapWrong() {
    wx.switchTab({ url: '/pages/wrong/wrong' });
  },

  onShareAppMessage() {
    return {
      title: '行测每日一练，五大模块全覆盖',
      path: `/pages/index/index?inv=${getApp().globalData.openid}`
    };
  },

  onShareTimeline() {
    return {
      title: '行测每日一练，五大模块全覆盖',
      query: `inv=${getApp().globalData.openid}`
    };
  }
});
