const { getStats } = require('../../services/user');
const { calendar } = require('../../services/checkin');
const cache = require('../../utils/cache');
const cloudUtil = require('../../utils/cloud');
const store = require('../../utils/store');
const track = require('../../utils/track');
const fmt = require('../../utils/format');
const ad = require('../../utils/ad');

const HOME_CACHE_KEY = 'home-v2'; // v2: 新增 icon/avatarUrl 字段，弃用旧缓存

/** 按当前时段返回问候语（东八区） */
function buildGreeting() {
  const h = new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCHours();
  if (h >= 5 && h < 11) return '早上好';
  if (h >= 11 && h < 13) return '中午好';
  if (h >= 13 && h < 18) return '下午好';
  return '晚上好';
}

Page({
  data: {
    loading: true,
    greeting: buildGreeting(),
    nickName: '',
    avatarUrl: '',
    totalDone: 0,
    accuracy: 0,
    streak: 0,
    todayChecked: false,
    wrongCount: 0,
    modules: [],
    showRank: true,
    adBannerId: ''
  },

  onLoad() {
    // 先用缓存渲染，避免每次进首页都白屏等网络
    const cached = cache.get(HOME_CACHE_KEY, null);
    if (cached) {
      this.setData({ ...cached, loading: false });
    }

    this._load();
    // 广告位 ID 来自云端 config：onLoad 时可能已就绪（二次进入），
    // _load 里 app ready 后再刷一次兜底（冷启动 config 并行拉取中）
    this.setData({ adBannerId: ad.bannerId() });
    store.on('wrongCount', (n) => this.setData({ wrongCount: n }));
    track.page('index');
  },

  onShow() {
    // 从刷题页返回时刷新统计，避免数据陈旧
    if (this._loaded) this._load(true);
    // 问候语随时间段变化，onShow 时刷新
    this.setData({ greeting: buildGreeting() });
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
          icon: m[0],
          done: r.done,
          accuracy: fmt.percent(r.correct, r.done)
        };
      });

      // 头像可能是 cloud:// fileID：渲染层直填不稳定（当相对路径加载失败），
      // 先换 https 临时链接再渲染（缓存里也存转换后的链接）
      const rawAvatar = (stats && stats.profile && stats.profile.avatarUrl) || '';
      const avatarUrl = await cloudUtil.resolveFileUrl(rawAvatar);

      const payload = {
        loading: false,
        nickName: (stats && stats.profile && stats.profile.nickName) || '',
        avatarUrl,
        totalDone: s.totalDone,
        accuracy: fmt.percent(s.totalCorrect, s.totalDone),
        streak: (cal && cal.streak) || 0,
        todayChecked: !!(cal && cal.todayChecked),
        wrongCount: (stats && stats.wrongCount) || 0,
        modules,
        showRank: app.canShow('rank'),
        adBannerId: ad.bannerId()
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

  onTapRandom() {
    track.push('tap_module', { module: '__random__' });
    // 不传 module，云函数从全部模块抽题
    wx.navigateTo({ url: '/pages/practice/practice?scene=practice' });
  },

  /** 广告加载失败（未开通流量主/无填充/网络异常）→ 隐藏容器，绝不打扰用户 */
  onAdError() {
    this.setData({ adBannerId: '' });
  },

  onTapMine() {
    // 「我的」是 tabBar 页，必须 switchTab
    wx.switchTab({ url: '/pages/mine/mine' });
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
