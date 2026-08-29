const fmt = require('../../utils/format');
const track = require('../../utils/track');
const store = require('../../utils/store');

Page({
  data: {
    total: 0,
    correct: 0,
    accuracy: 0,
    module: '',
    scene: 'practice',
    beatText: '',
    streak: 0
  },

  onLoad(options) {
    const total = Number(options.total) || 0;
    const correct = Number(options.correct) || 0;
    const module = decodeURIComponent(options.module || '');
    const scene = options.scene || 'practice';

    this.setData({
      total,
      correct,
      module,
      scene,
      accuracy: fmt.percent(correct, total),
      beatText: this._beatText(fmt.percent(correct, total))
    });

    wx.setNavigationBarTitle({ title: scene === 'checkin' ? '打卡完成' : '练习报告' });
    track.push('result_view', { scene, total, correct });

    if (scene === 'checkin') {
      require('../../services/checkin')
        .calendar()
        .then((cal) => {
          if (cal) this.setData({ streak: cal.streak });
        })
        .catch(() => {});
    }
  },

  /** 击败百分比：先按本地正确率估算，V1.1 换成云端真实分位 */
  _beatText(accuracy) {
    if (accuracy >= 90) return '击败了 92% 的考友';
    if (accuracy >= 80) return '击败了 78% 的考友';
    if (accuracy >= 70) return '击败了 60% 的考友';
    if (accuracy >= 50) return '击败了 38% 的考友';
    return '再练几组就能超过多数人';
  },

  onAgain() {
    if (this.data.scene === 'checkin') {
      wx.navigateBack();
      return;
    }
    wx.redirectTo({
      url: `/pages/practice/practice?module=${encodeURIComponent(this.data.module)}&scene=practice`
    });
  },

  onBackHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  onGoWrong() {
    wx.switchTab({ url: '/pages/wrong/wrong' });
  },

  onPoster() {
    wx.navigateTo({
      url: `/pkg-rank/pages/poster/poster?total=${this.data.total}&correct=${this.data.correct}&module=${encodeURIComponent(this.data.module)}&streak=${this.data.streak}`
    });
  },

  onShareAppMessage() {
    return {
      title: `行测练习正确率 ${this.data.accuracy}%，${this.data.beatText}`,
      path: `/pages/index/index?inv=${getApp().globalData.openid}`
    };
  },

  onShareTimeline() {
    return {
      title: `行测练习正确率 ${this.data.accuracy}%`,
      query: `inv=${getApp().globalData.openid}`
    };
  }
});
