const { calendar } = require('../../../services/checkin');

Page({
  data: {
    days: [],
    streak: 0,
    maxStreak: 0,
    totalDays: 0,
    todayChecked: false,
    showRank: true,
    weekdayRow: ['日', '一', '二', '三', '四', '五', '六']
  },

  onLoad() {
    // 审核模式下隐藏排行榜入口（与首页快捷入口同一开关）
    this.setData({ showRank: getApp().canShow('rank') });
    this._load();
  },

  async _load() {
    const res = await calendar().catch(() => null);
    if (!res) return;

    // 日历按周对齐：前面补空位，让 1 号落在正确的星期下
    const first = res.days[res.days.length - 1];
    const pad = first ? new Date(first.date + 'T00:00:00+08:00').getDay() : 0;
    const blanks = [];
    for (let i = 0; i < pad; i++) blanks.push({ blank: true });

    this.setData({
      days: blanks.concat(res.days.slice().reverse()),
      streak: res.streak,
      maxStreak: res.maxStreak,
      totalDays: res.totalDays,
      todayChecked: res.todayChecked
    });
  },

  onTapCheckin() {
    if (this.data.todayChecked) return;
    wx.navigateTo({
      url: '/pages/practice/practice?scene=checkin&mode=batch'
    });
  },

  onTapRank() {
    // 双保险：即使 UI 被绕过，审核模式下也不放行跳转
    if (!getApp().canShow('rank')) return;
    wx.navigateTo({ url: '/pkg-rank/pages/rank/rank' });
  }
});
