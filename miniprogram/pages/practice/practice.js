const { draw } = require('../../services/question');
const { submitSafe, submit } = require('../../services/answer');
const { submit: submitCheckin } = require('../../services/checkin');
const { requestCheckinSubscribe } = require('../../services/user');
const track = require('../../utils/track');
const store = require('../../utils/store');

/**
 * 两种作答模式：
 *
 * instant（默认）— 每答一题立即提交，秒出解析。答案依然只在用户作答后才下发，
 *   客户端事前拿不到，安全性不变；代价是每组 10 次请求，可接受。
 * batch — 做完一组统一提交，用于打卡和模考（模拟真实考试节奏，中途不看解析）。
 */
Page({
  data: {
    list: [],
    current: 0,
    total: 0,
    loading: true,
    mode: 'instant',
    moduleName: '',
    scene: 'practice',
    submitting: false
  },

  // 作答结果放实例属性而非 data：不参与渲染的数据绝不进 data，能显著减少 setData 体积
  _answers: {},
  _qStart: 0,
  _setStart: 0,

  onLoad(options) {
    const moduleName = decodeURIComponent(options.module || '');
    const subtype = decodeURIComponent(options.subtype || '');
    const scene = options.scene || 'practice';
    const mode = options.mode || (scene === 'checkin' ? 'batch' : 'instant');

    this.setData({ moduleName, scene, mode, subtype });
    this._setStart = Date.now();

    wx.setNavigationBarTitle({
      title: scene === 'checkin' ? '每日打卡' : subtype || moduleName || '专项练习'
    });

    this._draw(moduleName, scene, subtype);
  },

  onUnload() {
    track.flush();
  },

  async _draw(moduleName, scene, subtype) {
    try {
      const res = await draw({
        module: moduleName,
        subtype: subtype || '',
        scene,
        count: 10
      });

      if (!res || !res.list || !res.list.length) {
        this.setData({ loading: false });
        wx.showToast({ title: '暂无可用题目', icon: 'none' });
        return;
      }

      this.setData({
        list: res.list,
        total: res.list.length,
        loading: false
      });
      this._qStart = Date.now();
      this._taskId = res.taskId || null;
    } catch (err) {
      this.setData({ loading: false });
    }
  },

  onSwiperChange(e) {
    const current = e.detail.current;
    this.setData({ current });
    this._qStart = Date.now();
  },

  /** 子组件点击选项 */
  onSelect(e) {
    const { qid, chosen } = e.detail;
    const idx = this.data.current;
    const costMs = Date.now() - this._qStart;

    this._answers[qid] = { chosen, costMs };

    if (this.data.mode === 'instant') {
      this._submitOne(idx, qid, chosen, costMs);
    } else {
      // batch 模式：记录后自动跳下一题，最后一道交给用户点提交
      if (idx < this.data.total - 1) {
        setTimeout(() => this.setData({ current: idx + 1 }), 300);
        this._qStart = Date.now();
      }
    }
  },

  /** 逐题提交：只更新当前这一题的 result 字段，其余题目 DOM 不动 */
  async _submitOne(idx, qid, chosen, costMs) {
    const res = await submitSafe({
      scene: this.data.scene,
      taskId: this._taskId,
      items: [{ qid, chosen, costMs }]
    });

    if (!res || !res.results || !res.results.length) return;

    const r = res.results[0];
    // 路径 setData：只把这一题的解析写回去，不重建整个 list
    this.setData({ [`list[${idx}].result`]: r });

    if (!r.correct) {
      store.setWrongCount(store.state.wrongCount + 1);
    }
  },

  onFav(e) {
    const { qid } = e.detail;
    require('../../services/favorite')
      .toggle(qid)
      .then((res) => {
        wx.showToast({
          title: res.favorited ? '已收藏' : '已取消收藏',
          icon: 'none'
        });
      });
  },

  onNext() {
    const next = this.data.current + 1;
    if (next < this.data.total) {
      this.setData({ current: next });
      this._qStart = Date.now();
    }
  },

  onPrev() {
    const prev = this.data.current - 1;
    if (prev >= 0) {
      this.setData({ current: prev });
      this._qStart = Date.now();
    }
  },

  /** batch 模式统一提交 */
  async onSubmit() {
    if (this.data.submitting) return;

    const items = [];
    Object.keys(this._answers).forEach((qid) => {
      items.push({ qid: Number(qid), ...this._answers[qid] });
    });

    if (!items.length) {
      wx.showToast({ title: '还没有作答', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });

    try {
      const res = await submit({
        scene: this.data.scene,
        taskId: this._taskId,
        items
      });

      if (!res) {
        this.setData({ submitting: false });
        return;
      }

      // 打卡场景：提交后自动打卡，并在此刻申请订阅消息（授权率最高的时机）
      if (this.data.scene === 'checkin') {
        await this._checkin(items, res);
      }

      track.push('practice_finish', {
        scene: this.data.scene,
        module: this.data.moduleName,
        total: res.total,
        correct: res.correctCount
      });

      wx.redirectTo({
        url: `/pages/result/result?total=${res.total}&correct=${res.correctCount}&scene=${this.data.scene}&module=${encodeURIComponent(this.data.moduleName)}`
      });
    } catch (err) {
      this.setData({ submitting: false });
    }
  },

  async _checkin(items, res) {
    const durationSec = Math.round((Date.now() - this._setStart) / 1000);
    const ck = await submitCheckin({
      doneCount: items.length,
      correctCount: res.correctCount,
      durationSec
    }).catch(() => null);

    if (ck && ck.canSubscribe) {
      const tmplId = (getApp().globalData.config || {}).checkin_tmpl_id;
      if (tmplId) requestCheckinSubscribe(tmplId);
    }
  },

  onBack() {
    const answered = Object.keys(this._answers).length;
    if (answered > 0 && this.data.mode === 'batch') {
      wx.showModal({
        title: '要离开吗',
        content: '本次作答将不会保存',
        confirmText: '离开',
        cancelText: '继续答题',
        success: (r) => {
          if (r.confirm) wx.navigateBack();
        }
      });
      return;
    }
    wx.navigateBack();
  },

  onShareAppMessage() {
    return {
      title: `我在练「${this.data.moduleName || '行测'}」，一起上岸？`,
      path: `/pages/index/index?inv=${getApp().globalData.openid}`
    };
  }
});
