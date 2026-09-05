const { moduleStats, subtypes } = require('../../services/question');
const cache = require('../../utils/cache');
const track = require('../../utils/track');
const fmt = require('../../utils/format');

const CACHE_KEY = 'library_stats';

Page({
  data: {
    loading: true,
    modules: [],        // [{ name, total, done, correct, progress, accuracy }]
    activeModule: '',   // 空串表示「全部」
    subtypes: [],       // 当前模块的二级考点（全量）
    keyword: '',
    filteredSubtypes: []
  },

  onLoad() {
    // 先用缓存渲染。题库题量变化很少，5 分钟陈旧窗口可接受
    const cached = cache.get(CACHE_KEY, null);
    if (cached) this.setData({ modules: cached, loading: false });

    this._load();
    track.page('library');
  },

  onShow() {
    // 从答题页返回时刷新进度，否则刚做完题进度条不变
    if (this._loaded) this._load();
  },

  async _load() {
    getApp().onAppReady(async () => {
      const stats = await moduleStats().catch(() => null);
      if (!stats) {
        this.setData({ loading: false });
        return;
      }

      const modules = (stats.modules || []).map((m) => ({
        ...m,
        accuracy: fmt.percent(m.correct, m.done)
      }));

      this.setData({ loading: false, modules });
      cache.set(CACHE_KEY, modules, 5 * cache.MINUTE);
      this._loaded = true;
    });
  },

  onTapModuleChip(e) {
    const { name } = e.currentTarget.dataset;
    if (name === this.data.activeModule) return;

    this.setData({
      activeModule: name,
      subtypes: [],
      filteredSubtypes: [],
      keyword: ''
    });

    if (name) this._loadSubtypes(name);
    track.push('library_filter_module', { module: name || '全部' });
  },

  async _loadSubtypes(module) {
    const res = await subtypes(module).catch(() => null);
    const list = (res && res.list) || [];
    this.setData({ subtypes: list, filteredSubtypes: list });
  },

  onSearch(e) {
    const keyword = (e.detail.value || '').trim();
    // 考点全量已在本地，搜索只做前端过滤，不再打云端
    const filteredSubtypes = keyword
      ? this.data.subtypes.filter((s) => s.indexOf(keyword) > -1)
      : this.data.subtypes;

    this.setData({ keyword, filteredSubtypes });
  },

  _startPractice(module, subtype) {
    const params = ['scene=practice'];
    if (module) params.push('module=' + encodeURIComponent(module));
    if (subtype) params.push('subtype=' + encodeURIComponent(subtype));
    wx.navigateTo({ url: '/pages/practice/practice?' + params.join('&') });
  },

  onTapModuleCard(e) {
    const { name } = e.currentTarget.dataset;
    if (!name) return;
    track.push('library_start_module', { module: name });
    this._startPractice(name, '');
  },

  onTapSubtype(e) {
    const { name } = e.currentTarget.dataset;
    track.push('library_start_subtype', { module: this.data.activeModule, subtype: name });
    this._startPractice(this.data.activeModule, name);
  },

  onShareAppMessage() {
    return {
      title: '行测五大模块题库，随时开练',
      path: '/pages/library/library'
    };
  }
});
