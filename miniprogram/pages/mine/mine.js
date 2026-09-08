const { getStats, updateProfile } = require('../../services/user');
const { requestCheckinSubscribe } = require('../../services/user');
const { calendar } = require('../../services/checkin');
const cloudUtil = require('../../utils/cloud');
const fmt = require('../../utils/format');
const store = require('../../utils/store');
const privacy = require('../../utils/privacy');
const ad = require('../../utils/ad');
const update = require('../../utils/update');

const SLOT_NAMES = ['上午', '下午', '晚上'];

function fmtCooldown(ms) {
  if (ms <= 0) return '无';
  const m = Math.ceil(ms / 60000);
  return m >= 60 ? Math.floor(m / 60) + 'h' + (m % 60) + 'm' : m + 'm';
}

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
    needAuth: false,
    debugMode: false,
    debugInfo: {}
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

      // 头像可能是 cloud:// fileID，渲染层直填不稳定，先换 https 临时链接
      const rawAvatar = (stats && stats.profile && stats.profile.avatarUrl) || '';
      const avatarUrl = await cloudUtil.resolveFileUrl(rawAvatar);

      this.setData({
        avatarUrl,
        nickName: (stats && stats.profile && stats.profile.nickName) || '',
        totalDone: s.totalDone,
        accuracy: fmt.percent(s.totalCorrect, s.totalDone),
        streak: (cal && cal.streak) || 0,
        totalDays: (cal && cal.totalDays) || 0,
        wrongCount: (stats && stats.wrongCount) || 0,
        modules
      });

      // 调试面板：config.debug_mode 热开关控制显隐，audit_mode 下强制隐藏
      const app = getApp();
      const cfg = app.globalData.config || {};
      if (app.canShow('debug') && cfg.debug_mode === true) {
        this.setData({ debugMode: true });
        this._refreshDebug();
      }

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
  },

  // ---------- 调试面板（config.debug_mode=true 且非审核模式时显示） ----------

  _refreshDebug() {
    const app = getApp();
    const cfg = app.globalData.config || {};
    const acc = update.getAccountInfo();
    const st = ad.interstitialState();
    const slotName = SLOT_NAMES[st.slot] || String(st.slot);

    this.setData({
      debugInfo: {
        version: acc.version || '(未发布)',
        envVersion: acc.envVersion,
        auditMode: !!app.globalData.isAuditMode,
        banner: ad.bannerId() || '未配置',
        video: ad.bannerId('ad_video') || '未配置',
        tmpl: cfg.checkin_tmpl_id ? '已配置' : '未配置',
        interstitial: st.enabled
          ? `当前时段：${slotName}${st.slotShown ? '（已弹）' : '（未弹）'} · 冷却剩 ${fmtCooldown(st.cooldownRemain)}`
          : '未配置',
        configKeys: Object.keys(cfg).join('、')
      }
    });
  },

  /** 模拟旧版本触发强更弹窗（min_version=1.0.0，0.0.1 必命中） */
  onDebugForceCheck() {
    update.checkVersion(getApp().globalData.config || {}, '0.0.1');
  },

  /** 模拟次新版本触发柔性更新提示（绕过当日只弹一次的缓存） */
  onDebugSoftCheck() {
    update.checkVersion(getApp().globalData.config || {}, '0.0.2');
  },

  /** 立即弹插屏，忽略冷却与时段频控（启用门禁仍生效） */
  async onDebugInterstitial() {
    const shown = await ad.tryShowOpenInterstitial(Date.now(), { force: true });
    wx.showToast({ title: shown ? '已拉起插屏' : '未启用或拉取失败', icon: 'none' });
    this._refreshDebug();
  },

  /** 播放一次激励视频 */
  async onDebugVideo() {
    const ended = await ad.showVideoAd();
    wx.showToast({ title: ended ? '完整观看' : '未看完/未播放', icon: 'none' });
  },

  /** 手动拉起打卡订阅授权 */
  async onDebugSubscribe() {
    const tmplId = (getApp().globalData.config || {}).checkin_tmpl_id;
    if (!tmplId) {
      wx.showToast({ title: 'config 未配置 checkin_tmpl_id', icon: 'none' });
      return;
    }
    const ok = await requestCheckinSubscribe(tmplId);
    wx.showToast({ title: ok ? '已同意订阅' : '未同意/失败', icon: 'none' });
  },

  onDebugPrivacy() {
    privacy.openContract();
  }
});
