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
   */
  data: {
    chosen: [],
    showAnalysis: false
  },

  observers: {
    'result': function (result) {
      if (result) {
        this.setData({ showAnalysis: true });
      }
    }
  },

  methods: {
    onTapOption(e) {
      if (this.data.locked || this.properties.result) return;

      const key = e.currentTarget.dataset.key;
      const isMulti = this.properties.q.type === 'multi';

      if (!isMulti) {
        this.setData({ chosen: [key] });
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
