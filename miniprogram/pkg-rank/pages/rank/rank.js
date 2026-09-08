const { rank } = require('../../../services/checkin');
const cloudUtil = require('../../../utils/cloud');
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
    const list = (res && res.list) || [];
    const me = (res && res.me) || null;

    // 榜单头像多为 cloud:// fileID，渲染层直填不稳定，批量换 https 临时链接
    const fileIds = [];
    list.forEach((u) => {
      if (u.avatarUrl) fileIds.push(u.avatarUrl);
    });
    if (me && me.avatarUrl) fileIds.push(me.avatarUrl);
    const urlMap = await cloudUtil.resolveFileUrls(fileIds);
    const toUrl = (u) => {
      if (!u) return u;
      // 换链结果可能为空串（失败兜底），此时直接用空串让 WXML 走默认头像，
      // 严禁回退 u.avatarUrl（cloud:// fileID 直填 src 渲染层必报错）
      return Object.assign({}, u, { avatarUrl: u.avatarUrl ? urlMap.get(u.avatarUrl) || '' : '' });
    };

    this.setData({
      list: list.map(toUrl),
      me: toUrl(me),
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
