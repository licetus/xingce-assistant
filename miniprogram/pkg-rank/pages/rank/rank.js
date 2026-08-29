const { rank } = require('../../../services/checkin');
const track = require('../../../utils/track');

Page({
  data: {
    type: 'week',
    list: [],
    me: null,
    loading: true
  },

  onLoad() {
    this._load();
    track.page('rank');
  },

  async _load() {
    this.setData({ loading: true });
    const res = await rank(this.data.type).catch(() => null);
    this.setData({
      list: (res && res.list) || [],
      me: (res && res.me) || null,
      loading: false
    });
  },

  onSwitchType(e) {
    const type = e.currentTarget.dataset.type;
    if (type === this.data.type) return;
    this.setData({ type });
    this._load();
  },

  onShareAppMessage() {
    return {
      title: '行测打卡排行榜，来比比谁的连续天数多',
      path: `/pkg-rank/pages/rank/rank?inv=${getApp().globalData.openid}`
    };
  }
});
