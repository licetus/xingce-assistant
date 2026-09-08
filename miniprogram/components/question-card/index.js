const { resolveFileUrls } = require('../../utils/cloud');

Component({
  options: {
    addGlobalClass: true
  },

  properties: {
    q: { type: Object, value: null },
    index: { type: Number, value: 0 },
    total: { type: Number, value: 0 },
    locked: { type: Boolean, value: false },
    result: { type: Object, value: null },
    // 当前题是否已收藏：由页面（practice）维护并传入，组件不自行查询
    // （页面进入时批量拉收藏集合，toggle 成功后路径 setData 单点更新）
    faved: { type: Boolean, value: false }
  },

  /**
   * 关键性能设计：chosen / showAnalysis 只存在于组件自身的 data 里。
   * 用户点选项时只触发这一个组件的 setData，另外 9 道题的 DOM 完全不参与 diff。
   * 若把选中态提到页面级 list[i].chosen，虽然也能用路径 setData 优化，
   * 但组件化后页面与卡片的渲染边界更清晰，长列表下收益更大。
   *
   * ⚠️ 2026-09-08 修复「选项无高亮」：WXML Mustache 不支持方法调用
   * （chosen.indexOf(...) 求值为空，类名永远加不上），改为在 JS 侧预计算
   * viewOptions 高亮标记，WXML 只做属性访问。组件内 setData，性能损耗可忽略。
   */
  data: {
    chosen: [],
    showAnalysis: false,
    viewOptions: [],
    answerText: '',
    sourceLabel: '',
    // cloud:// fileID 不能直填 <image src>（渲染层转换不稳定，见约束 #12），
    // 这里存 resolveFileUrls 换出的 https 临时链接；材料图+题干图按序在 q.images
    stemImgUrls: [],
    // key -> 临时链接（选项即图的题，如坐标图/公式选项）
    optionImgUrls: {}
  },

  observers: {
    q: function (q) {
      // 防御：页面 setData(list[i].faved / list[i].result) 会把整个 item 重传，
      // 本 observer 对同题也会触发。只有真正换题（qid 变化）才清空作答痕迹，
      // 否则点收藏会把已展开的解析折叠、已选答案清空
      const qid = q && q.qid;
      if (qid && qid === this._lastQid) return;
      this._lastQid = qid;

      this.setData({
        chosen: [],
        showAnalysis: false,
        answerText: '',
        sourceLabel: this._computeSourceLabel(q)
      });
      this._refreshOptions();
      this._loadImages();
    },
    result: function (result) {
      if (result) {
        // answerText 同理：join() 是方法调用，WXML 里渲染不出来，必须在 JS 侧算好
        this.setData({
          showAnalysis: true,
          answerText: Array.isArray(result.answer) ? result.answer.join('') : ''
        });
      }
      this._refreshOptions();
    }
  },

  methods: {
    /**
     * 来源标签文案（在 JS 侧算好再进 data，WXML 禁方法调用）：
     * - AI 题：'AI 生成'（审核红线，必须标识）
     * - 真题有出处：单卷 '2024国考·行政执法'；同年多卷 '2024国考·执法/地市'；跨年 '2024/2025国考'
     * - 无出处数据（旧缓存/兜底）：'真题'
     */
    _computeSourceLabel(q) {
      if (!q) return '';
      if (q.source === 'ai') return 'AI 生成';

      const exams = Array.isArray(q.exams) ? q.exams : [];
      if (!exams.length) return '真题';

      const years = [];
      exams.forEach((e) => {
        const y = String(e).slice(0, 4);
        if (years.indexOf(y) < 0) years.push(y);
      });

      if (exams.length === 1) {
        return exams[0].replace(/^(\d{4})/, '$1国考·');
      }
      if (years.length > 1) {
        return years.join('/') + '国考';
      }
      // 同年多卷：卷别短式拼接，按 副省 → 地市 → 执法 固定顺序
      const ORDER = ['副省', '地市', '执法'];
      const papers = exams
        .map((e) => {
          const p = String(e).slice(4);
          if (p === '副省级') return '副省';
          if (p === '地市级') return '地市';
          if (p === '行政执法') return '执法';
          return p;
        })
        .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
      return years[0] + '国考·' + papers.join('/');
    },

    /**
     * 换链题干图 + 选项图（一次批量 getTempFileURL，utils/cloud 内存缓存命中零开销）。
     * 仅换题时触发；换链完成前 WXML 的 wx:if 不渲染图片，不产生空 src 请求
     */
    _loadImages() {
      const q = this.properties.q;
      if (!q) return;

      const stemIds = Array.isArray(q.images) ? q.images : [];
      const optImgByKey = {}; // key -> fileID
      (q.options || []).forEach((o) => {
        if (o && typeof o.img === 'string' && o.img.indexOf('cloud://') === 0) optImgByKey[o.key] = o.img;
      });
      const optionIds = Object.keys(optImgByKey).map((k) => optImgByKey[k]);

      if (!stemIds.length && !optionIds.length) {
        this.setData({ stemImgUrls: [], optionImgUrls: {} });
        return;
      }

      resolveFileUrls(stemIds.concat(optionIds)).then((map) => {
        // 同题防御：换链期间用户可能已切题，以当前 qid 为准
        if (this.properties.q && this.properties.q.qid !== q.qid) return;
        const optionImgUrls = {};
        Object.keys(optImgByKey).forEach((k) => {
          const url = map.get(optImgByKey[k]);
          if (url) optionImgUrls[k] = url;
        });
        this.setData({
          stemImgUrls: stemIds.map((id) => map.get(id) || '').filter(Boolean),
          optionImgUrls
        });
      });
    },

    /** 把 chosen / result 折算进选项数组，供 WXML 直接渲染高亮类名 */
    _refreshOptions() {
      const chosen = this.data.chosen;
      const result = this.properties.result;
      const q = this.properties.q;
      const answer = result && result.answer ? result.answer : null;

      const viewOptions = (q && q.options ? q.options : []).map((o) => {
        const isChosen = chosen.indexOf(o.key) >= 0;
        const isRight = !!(answer && answer.indexOf(o.key) >= 0);
        return {
          key: o.key,
          text: o.text,
          isChosen,
          isRight,
          isWrong: isChosen && !!answer && !isRight
        };
      });

      this.setData({ viewOptions });
    },

    onTapOption(e) {
      if (this.data.locked || this.properties.result) return;

      const key = e.currentTarget.dataset.key;
      const isMulti = this.properties.q.type === 'multi';

      if (!isMulti) {
        this.setData({ chosen: [key] });
        this._refreshOptions();
        this.triggerEvent('select', {
          qid: this.properties.q.qid,
          chosen: [key]
        });
        return;
      }

      // 多选：先本地切换，点「确定」才提交
      const chosen = this.data.chosen.slice();
      const i = chosen.indexOf(key);
      if (i >= 0) chosen.splice(i, 1);
      else chosen.push(key);
      this.setData({ chosen });
      this._refreshOptions();
    },

    onConfirmMulti() {
      if (this.data.locked || this.properties.result) return;
      if (!this.data.chosen.length) {
        wx.showToast({ title: '请先选择答案', icon: 'none' });
        return;
      }
      this.triggerEvent('select', {
        qid: this.properties.q.qid,
        chosen: this.data.chosen
      });
    },

    toggleAnalysis() {
      this.setData({ showAnalysis: !this.data.showAnalysis });
    },

    onToggleFav() {
      this.triggerEvent('fav', {
        qid: this.properties.q.qid,
        index: this.properties.index
      });
    }
  }
});
