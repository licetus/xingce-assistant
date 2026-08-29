const { login, fetchConfig } = require('./services/user');

/**
 * 本地环境配置
 * config.js 不入库（已 gitignore），未创建时回退到 config.example.js 的占位值。
 * 这样公开仓库里不会出现真实云环境 ID，克隆下来也不会因为缺文件而崩溃。
 */
let envConfig;
try {
  envConfig = require('./config');
} catch (e) {
  envConfig = require('./config.example');
}

App({
  globalData: {
    openid: '',
    user: null,
    config: {},
    scene: 1001,
    inviteBy: '',
    isAuditMode: false
  },

  /** 页面通过 await getApp().ready() 拿到已就绪的登录态，避免各处重复判断 */
  _resolveReady: null,
  ready: null,

  onLaunch(options) {
    if (!wx.cloud) {
      wx.showModal({
        title: '基础库版本过低',
        content: '请升级微信后使用',
        showCancel: false
      });
      return;
    }

    if (envConfig.cloudEnv.indexOf('XXXX') >= 0) {
      console.warn('[app] 云环境 ID 仍是占位值，请复制 miniprogram/config.example.js 为 config.js 并填入真实环境 ID');
    }

    wx.cloud.init({
      env: envConfig.cloudEnv,
      traceUser: true
    });

    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });

    this._captureScene(options);
    this._bootstrap();
  },

  onShow(options) {
    if (options && options.scene) {
      this._captureScene(options);
    }
  },

  /** 解析分享/扫码来源，做增长归因 */
  _captureScene(options = {}) {
    this.globalData.scene = options.scene || 1001;
    this.globalData.inviteBy = options.query && options.query.inv ? options.query.inv : '';
  },

  /** 登录与拉配置并行发起，谁先回来谁先渲染，不串行等待 */
  async _bootstrap() {
    // 微信原生更新检查不依赖登录态，尽早触发，新包能更早就绪
    require('./utils/update').silentUpdate();

    try {
      const [config] = await Promise.all([
        fetchConfig().catch(() => ({})),
        this._ensureLogin()
      ]);

      this.globalData.config = config || {};
      this.globalData.isAuditMode = !!(config && config.audit_mode);

      this._resolveReady(true);
      this._notifyReady();
      this._watchNetwork();

      // 延后一帧再校验版本：强制更新弹窗若抢在首页渲染前弹出，会被页面覆盖导致白屏后弹窗
      setTimeout(() => {
        require('./utils/update').checkVersion(this.globalData.config);
      }, 800);
    } catch (err) {
      console.error('[app] bootstrap failed', err);
      // 登录失败不能让页面白屏，放行后由各页面按未登录态降级展示
      this._resolveReady(false);
      this._notifyReady();
    }
  },

  async _ensureLogin() {
    const res = await login(this.globalData.inviteBy);
    this.globalData.openid = res.openid;
    this.globalData.user = res.user;
    require('./utils/store').setUser(res.user);
    return res;
  },

  /** 事件总线：登录完成后广播，页面无需轮询 */
  _readyCallbacks: [],
  onAppReady(cb) {
    if (this.globalData.openid) return cb();
    this._readyCallbacks.push(cb);
  },
  _notifyReady() {
    const list = this._readyCallbacks;
    this._readyCallbacks = [];
    list.forEach((cb) => cb && cb());
  },

  /** 断网补交：刷题常在地铁/电梯里，作答先落本地，联网后自动回传 */
  _watchNetwork() {
    wx.onNetworkStatusChange((res) => {
      if (res.isConnected) {
        require('./services/answer').flushPending();
      }
    });
  },

  /** 审核模式下隐藏排行榜、邀请奖励等敏感入口，提审时云端改配置即可，不用重新发版 */
  canShow(key) {
    if (!this.globalData.isAuditMode) return true;
    const blocked = ['rank', 'invite', 'reward'];
    return blocked.indexOf(key) === -1;
  }
});
