const { call } = require('../../utils/cloud');
const { list: favList } = require('../../services/favorite');
const track = require('../../utils/track');
const fmt = require('../../utils/format');

Page({
  data: {
    tab: 'wrong',
    list: [],
    favs: [],
    loading: true,
    hasMore: true,
    page: 0,
    empty: false
  },

  onLoad() {
    this._load(true);
  },

  onShow() {
    if (this._loaded) this._load(true);
  },

  onPullDownRefresh() {
    this._load(true).then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.tab === 'wrong' && this.data.hasMore) this._load(false);
  },

  async _load(reset) {
    if (reset) {
      this.setData({ page: 0, list: [], hasMore: true });
    }

    const page = this.data.page;
    this.setData({ loading: true });

    try {
      if (this.data.tab === 'wrong') {
        const res = await call('wrongbook', 'list', { page, size: 20 }, { silent: true });
        const list = (res && res.list) || [];
        this.setData({
          list: reset ? list : this.data.list.concat(list),
          hasMore: !!(res && res.hasMore),
          page: page + 1,
          loading: false,
          empty: reset && list.length === 0
        });
      } else {
        const res = await favList(page, 20);
        const list = (res && res.list) || [];
        this.setData({
          favs: reset ? list : this.data.favs.concat(list),
          hasMore: !!(res && res.hasMore),
          page: page + 1,
          loading: false,
          empty: reset && list.length === 0
        });
      }
      this._loaded = true;
    } catch (err) {
      this.setData({ loading: false });
    }
  },

  onSwitchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.tab) return;
    this.setData({ tab, page: 0 });
    this._load(true);
  },

  onRedraw() {
    if (!this.data.list.length) {
      wx.showToast({ title: '暂时没有错题', icon: 'none' });
      return;
    }
    track.push('wrong_redraw');
    wx.navigateTo({
      url: '/pages/practice/practice?scene=review&mode=instant'
    });
  },

  onRemove(e) {
    const { qid } = e.currentTarget.dataset;
    call('wrongbook', 'remove', { qid }, { silent: true })
      .then(() => {
        this.setData({
          list: this.data.list.filter((i) => i.qid !== Number(qid))
        });
        wx.showToast({ title: '已标记为掌握', icon: 'none' });
      });
  },

  onTapItem(e) {
    const { qid } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/practice/practice?scene=practice&qid=${qid}`
    });
  }
});
