const { call } = require('../../../utils/cloud');
const fmt = require('../../../utils/format');
const track = require('../../../utils/track');

const W = 300;
const H = 460;

Page({
  data: {
    total: 0,
    correct: 0,
    accuracy: 0,
    module: '',
    streak: 0,
    drawing: true,
    posterPath: ''
  },

  onLoad(options) {
    const total = Number(options.total) || 0;
    const correct = Number(options.correct) || 0;

    this.setData({
      total,
      correct,
      module: decodeURIComponent(options.module || ''),
      streak: Number(options.streak) || 0,
      accuracy: fmt.percent(correct, total)
    });

    this._draw();
  },

  async _draw() {
    try {
      // 1. 取带邀请参数的小程序码
      const qr = await call('share', 'qrcode', { page: 'pages/index/index' }, { silent: true });
      const urlRes = await wx.cloud.getTempFileURL({ fileList: [qr.fileID] });
      const qrUrl = urlRes.fileList[0].tempFileURL;

      // 2. 拿 canvas 节点（Canvas 2D 必须走 SelectorQuery，旧的 canvasId 方式已废弃）
      const query = wx.createSelectorQuery();
      const nodeRes = await new Promise((resolve) => {
        query
          .select('#poster')
          .fields({ node: true, size: true })
          .exec((res) => resolve(res && res[0]));
      });

      if (!nodeRes || !nodeRes.node) throw new Error('canvas 未就绪');

      const canvas = nodeRes.node;
      const ctx = canvas.getContext('2d');
      const dpr = wx.getSystemInfoSync().pixelRatio;

      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.scale(dpr, dpr);

      // 3. 加载小程序码
      const qrImg = canvas.createImage();
      await new Promise((resolve, reject) => {
        qrImg.onload = resolve;
        qrImg.onerror = reject;
        qrImg.src = qrUrl;
      });

      this._paint(ctx, qrImg);

      // 4. 导出：destWidth 必须乘 dpr，否则保存到相册的图是模糊的
      const out = await new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvas,
          x: 0,
          y: 0,
          width: W,
          height: H,
          destWidth: W * dpr,
          destHeight: H * dpr,
          success: resolve,
          fail: reject
        });
      });

      this.setData({ posterPath: out.tempFilePath, drawing: false });
      track.push('poster_generated', { module: this.data.module });
    } catch (err) {
      console.error('[poster] draw failed', err);
      this.setData({ drawing: false });
      wx.showToast({ title: '海报生成失败', icon: 'none' });
    }
  },

  _paint(ctx, qrImg) {
    const { accuracy, total, correct, module, streak } = this.data;

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#2B6CF6';
    ctx.fillRect(0, 0, W, 96);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = '500 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('行测小助手', W / 2, 42);

    ctx.font = '13px sans-serif';
    ctx.globalAlpha = 0.85;
    ctx.fillText(module ? module + ' · 练习报告' : '今日练习报告', W / 2, 68);
    ctx.globalAlpha = 1;

    ctx.fillStyle = '#2B6CF6';
    ctx.font = '500 64px sans-serif';
    ctx.fillText(String(accuracy), W / 2, 168);

    const numWidth = ctx.measureText(String(accuracy)).width;
    ctx.font = '20px sans-serif';
    ctx.fillText('%', W / 2 + numWidth / 2 + 14, 168);

    ctx.fillStyle = '#5C6270';
    ctx.font = '13px sans-serif';
    ctx.fillText('正确率', W / 2, 194);

    ctx.fillStyle = '#1A1C1F';
    ctx.font = '15px sans-serif';
    ctx.fillText(`答对 ${correct} / ${total} 题`, W / 2, 232);

    if (streak > 0) {
      ctx.fillStyle = '#F5A524';
      ctx.font = '13px sans-serif';
      ctx.fillText(`连续打卡 ${streak} 天`, W / 2, 258);
    }

    ctx.strokeStyle = '#EBEDF0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(40, 288);
    ctx.lineTo(W - 40, 288);
    ctx.stroke();

    ctx.drawImage(qrImg, W / 2 - 45, 306, 90, 90);

    ctx.fillStyle = '#9A9EA6';
    ctx.font = '12px sans-serif';
    ctx.fillText('长按识别小程序码', W / 2, 418);
    ctx.fillText('一起刷题，一起上岸', W / 2, 438);
  },

  async onSave() {
    if (!this.data.posterPath) return;
    try {
      await wx.saveImageToPhotosAlbum({ filePath: this.data.posterPath });
      track.push('poster_saved');
      wx.showToast({ title: '已保存到相册', icon: 'success' });
    } catch (err) {
      // 用户拒绝过授权后，需要引导去设置页开启
      if (String(err.errMsg).indexOf('auth') >= 0) {
        wx.showModal({
          title: '需要相册权限',
          content: '保存海报需要访问相册，请在设置中开启',
          confirmText: '去设置',
          success: (r) => {
            if (r.confirm) wx.openSetting();
          }
        });
      }
    }
  },

  onShareAppMessage() {
    return {
      title: `行测练习正确率 ${this.data.accuracy}%，来挑战我`,
      path: `/pages/index/index?inv=${getApp().globalData.openid}`
    };
  }
});
