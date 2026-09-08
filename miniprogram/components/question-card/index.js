Component({
  options: {
    addGlobalClass: true
  },

  properties: {
    q: { type: Object, value: null },
    index: { type: Number, value: 0 },
    total: { type: Number, value: 0 },
    locked: { type: Boolean, value: false },
    result: { type: Object, value: null }
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
    answerText: ''
  },

  observers: {
    // 新题进入：清空上一题的作答痕迹（错题重做复用组件实例时防御）
    q: function () {
      this.setData({ chosen: [], showAnalysis: false, answerText: '' });
      this._refreshOptions();
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
      this.triggerEvent('fav', { qid: this.properties.q.qid });
    }
  }
});
