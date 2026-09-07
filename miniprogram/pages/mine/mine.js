const { getStats, updateProfile } = require('../../services/user');
const { calendar } = require('../../services/checkin');
const fmt = require('../../utils/format');
const store = require('../../utils/store');
const privacy = require('../../utils/privacy');

Page({
  data: {
    avatarUrl: '',
    nickName: '',
    totalDone: 0,
    accuracy: 0,
    streak: 0,
    totalDays: 0,
    wrongCount: 0,
    modules: [],
    needAuth: false
  },

  onLoad() {
    this._load();
  },

  onShow() {
    if (this._loaded) this._load();
  },

  async _load() {
    getApp().onAppReady(async () => {
      // 隐私协议未授权时不拉用户资料，避免触发审核问题
      // （低版本基础库没有隐私 API，getSetting 内部会降级为「无需授权」）
      const setting = await privacy.getSetting();
      this.setData({ needAuth: setting.needAuthorization });

      const [stats, cal] = await Promise.all([
        getStats().catch(() => null),
        calendar().catch(() => null)
      ]);

      const s = (stats && stats.stats) || { totalDone: 0, totalCorrect: 0, byModule: {} };
      const modules = fmt.MODULES.map((m) => {
        const r = (s.byModule && s.byModule[m]) || { done: 0, correct: 0 };
        return { name: m, done: r.done, accuracy: fmt.percent(r.correct, r.done) };
      });

      this.setData({
        avatarUrl: (stats && stats.profile && stats.profile.avatarUrl) || '',
        nickName: (stats && stats.profile && stats.profile.nickName) || '',
        totalDone: s.totalDone,
        accuracy: fmt.percent(s.totalCorrect, s.totalDone),
        streak: (cal && cal.streak) || 0,
        totalDays: (cal && cal.totalDays) || 0,
        wrongCount: (stats && stats.wrongCount) || 0,
        modules
      });
      this._loaded = true;
    });
  },

  /** wx.getUserProfile 已废弃，头像与昵称必须走这两个组件 */
  onChooseAvatar(e) {
    const url = e.detail.avatarUrl;
    if (!url) return;
    this.setData({ avatarUrl: url });
    this._uploadAvatar(url);
  },

  async _uploadAvatar(tempPath) {
    try {
      const ext = tempPath.split('.').pop() || 'png';
      const res = await wx.cloud.uploadFile({
        cloudPath: `avatar/${getApp().globalData.openid}_${Date.now()}.${ext}`,
        filePath: tempPath
      });
      await updateProfile({ avatarUrl: res.fileID });
    } catch (err) {
      wx.showToast({ title: '头像上传失败', icon: 'none' });
    }
  },

  onNicknameBlur(e) {
    const nickName = (e.detail.value || '').trim();
    if (!nickName || nickName === this.data.nickName) return;
    this.setData({ nickName });
    updateProfile({ nickName }).catch(() => {});
  },

  onOpenPrivacy() {
    wx.openPrivacyContract({});
  },

  onShareAppMessage() {
    return {
      title: '行测小助手，五大模块免费刷',
      path: `/pages/index/index?inv=${getApp().globalData.openid}`
    };
  }
});
