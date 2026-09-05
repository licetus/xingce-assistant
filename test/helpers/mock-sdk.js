'use strict';

/**
 * wx-server-sdk 内存模拟层
 *
 * 目标：在不依赖真实云环境的前提下，让云函数代码原样跑起来。
 * 关键的平台约束必须忠实还原（否则测试结果没有意义）：
 *
 * 1. 事务中只支持单记录操作（collection.doc / collection.add），
 *    where 查询与 where().update() 批量操作在事务内不可用
 *    （官方文档：开发者指引 → 数据库 → 事务 → 单记录操作）
 * 2. 事务采用快照隔离：提交前写入不可见，回滚即丢弃
 * 3. where().update() / where().remove() 是服务端批量操作，正常 collection 可用
 * 4. 单次 get 默认上限 20 条、云函数端 100 条（本模拟不强制 limit 默认值，
 *    只按显式 limit 生效，由用例自己控制数据量）
 * 5. doc.get() 找不到记录时抛错（throwOnNotFound 默认 true）
 */

// ---------------------------------------------------------------------------
// 全局模拟状态（同一进程内所有 require('wx-server-sdk') 共享同一实例）
// ---------------------------------------------------------------------------

const state = {
  /** { 集合名: [文档] } */
  collections: {},
  /** getWXContext 返回的上下文 */
  context: { OPENID: 'test-openid-001' },
  /** 云函数注册表（供 callFunction 派发）：{ 函数名: main } */
  registry: {},
  /** 错误注入队列：每次匹配的 db 操作抛出 err 后移除 */
  failOn: [],
  /** serverDate 固定返回值（默认 new Date()） */
  now: null,
  /** openapi 结果注入 */
  openapiResult: null,
  /** 已上传文件：{ cloudPath: fileID } */
  files: {},
  /** getTempFileURL 可见文件集合（Set of cloudPath） */
  tempVisible: new Set(),
  /** 自增 id */
  _idSeq: 1
};

function resetDb(seeds = {}) {
  state.collections = {};
  state.failOn = [];
  state.registry = {};
  state.files = {};
  state.tempVisible = new Set();
  state._idSeq = 1;
  for (const name of Object.keys(seeds)) {
    state.collections[name] = seeds[name].map((doc) => ({ ...doc }));
  }
}

function setContext(ctx) {
  Object.assign(state.context, ctx);
}

function setOpenid(openid) {
  state.context.OPENID = openid;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function clone(v) {
  if (v === undefined) return v;
  return JSON.parse(JSON.stringify(v, (k, val) => (val instanceof Date ? { __date: val.getTime() } : val)));
}

function revive(v) {
  if (v && v.__date !== undefined) return new Date(v.__date);
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = revive(v[k]);
    return out;
  }
  return v;
}

/** 比较任意两值（Date 按时间戳比较） */
function cmp(a, b) {
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
  const keys = String(path).split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof o[keys[i]] !== 'object' || o[keys[i]] === null) o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}

function coll(name) {
  if (!state.collections[name]) state.collections[name] = [];
  return state.collections[name];
}

/** 错误注入：命中即抛出并移除 */
function checkFail(collName, op) {
  const idx = state.failOn.findIndex((f) => f.collection === collName && f.op === op);
  if (idx >= 0) {
    const { err } = state.failOn[idx];
    state.failOn.splice(idx, 1);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// command 运算符
// ---------------------------------------------------------------------------

function cmd(type, args) {
  const c = { __cmd: type, ...args };
  c.and = (other) => ({ __cmd: 'and', list: [c, other] });
  return c;
}

function matchValue(actual, cond) {
  if (cond && typeof cond === 'object' && cond.__cmd) {
    switch (cond.__cmd) {
      case 'eq': return cmp(actual, cond.val) === 0;
      case 'neq': return cmp(actual, cond.val) !== 0;
      case 'gt': return cmp(actual, cond.val) > 0;
      case 'gte': return cmp(actual, cond.val) >= 0;
      case 'lt': return cmp(actual, cond.val) < 0;
      case 'lte': return cmp(actual, cond.val) <= 0;
      case 'in': return cond.val.some((v) => cmp(actual, v) === 0);
      case 'and': return cond.list.every((c) => matchValue(actual, c));
      default:
        throw new Error('mock-sdk: 不支持的查询运算符 ' + cond.__cmd);
    }
  }
  return cmp(actual, cond) === 0;
}

function matches(doc, where) {
  if (!where) return true;
  return Object.keys(where).every((key) => matchValue(getPath(doc, key), where[key]));
}

/** 应用 update 数据：支持 dotted path 与 _.inc */
function applyUpdate(doc, data) {
  for (const [path, val] of Object.entries(data)) {
    if (val && val.__cmd === 'inc') {
      const cur = getPath(doc, path);
      setPath(doc, path, (typeof cur === 'number' ? cur : 0) + val.val);
    } else if (val && val.__cmd) {
      throw new Error('mock-sdk: 不支持的更新运算符 ' + val.__cmd);
    } else {
      setPath(doc, path, clone(val));
    }
  }
}

function newId() {
  return 'mockid-' + String(state._idSeq++).padStart(6, '0');
}

function sortDocs(docs, orderByList) {
  const arr = docs.slice();
  for (const { field, dir } of orderByList) {
    arr.sort((a, b) => {
      const r = cmp(getPath(a, field), getPath(b, field));
      return dir === 'desc' ? -r : r;
    });
  }
  return arr;
}

// ---------------------------------------------------------------------------
// 查询构造器（collection 链式调用）
// ---------------------------------------------------------------------------

class Query {
  constructor(collName, { inTransaction = false } = {}) {
    this.collName = collName;
    this._where = null;
    this._orderBy = [];
    this._skip = 0;
    this._limit = null;
    this._field = null;
    this._inTransaction = inTransaction;
  }

  where(cond) {
    this._where = Object.assign(this._where || {}, cond);
    return this;
  }

  orderBy(field, dir) {
    this._orderBy.push({ field, dir });
    return this;
  }

  skip(n) {
    this._skip = n;
    return this;
  }

  limit(n) {
    this._limit = n;
    return this;
  }

  field(proj) {
    this._field = proj;
    return this;
  }

  _filtered() {
    return coll(this.collName).filter((d) => matches(d, this._where));
  }

  async get() {
    if (this._inTransaction) {
      throw new Error('mock-sdk [transaction]: 事务中不支持 where 条件查询，只支持 collection.doc / collection.add');
    }
    checkFail(this.collName, 'get');
    let arr = this._filtered();
    if (this._orderBy.length) arr = sortDocs(arr, this._orderBy);
    if (this._skip) arr = arr.slice(this._skip);
    if (this._limit != null) arr = arr.slice(0, this._limit);
    if (this._field) {
      const keep = Object.keys(this._field).filter((k) => this._field[k]);
      arr = arr.map((d) => {
        const out = { _id: d._id };
        for (const k of keep) {
          const v = getPath(d, k);
          if (v !== undefined) setPath(out, k, clone(v));
        }
        return out;
      });
    }
    return { data: arr.map((d) => revive(clone(d))) };
  }

  async count() {
    if (this._inTransaction) {
      throw new Error('mock-sdk [transaction]: 事务中不支持 where 条件查询');
    }
    checkFail(this.collName, 'count');
    return { total: this._filtered().length };
  }

  async update({ data }) {
    if (this._inTransaction) {
      throw new Error('mock-sdk [transaction]: 事务中不支持 where().update() 批量更新，只支持 collection.doc().update()');
    }
    checkFail(this.collName, 'update');
    let n = 0;
    for (const d of coll(this.collName)) {
      if (matches(d, this._where)) {
        applyUpdate(d, data);
        n += 1;
      }
    }
    return { stats: { updated: n } };
  }

  async remove() {
    if (this._inTransaction) {
      throw new Error('mock-sdk [transaction]: 事务中不支持 where().remove() 批量删除');
    }
    checkFail(this.collName, 'remove');
    const before = coll(this.collName).length;
    state.collections[this.collName] = coll(this.collName).filter((d) => !matches(d, this._where));
    return { stats: { removed: before - state.collections[this.collName].length } };
  }

  // 便捷：where().get() 的文档 _id 列表
  _ids() {
    return this._filtered().map((d) => d._id);
  }
}

// ---------------------------------------------------------------------------
// 文档引用（doc()）
// ---------------------------------------------------------------------------

class DocRef {
  constructor(collName, id, { inTransaction = false } = {}) {
    this.collName = collName;
    this.id = id;
    this._inTransaction = inTransaction;
  }

  async get() {
    checkFail(this.collName, 'get');
    const d = coll(this.collName).find((x) => x._id === this.id);
    if (!d) throw new Error('mock-sdk: document ' + this.id + ' not found');
    return { data: revive(clone(d)) };
  }

  async update({ data }) {
    checkFail(this.collName, 'update');
    const d = coll(this.collName).find((x) => x._id === this.id);
    if (!d) throw new Error('mock-sdk: document ' + this.id + ' not found');
    applyUpdate(d, data);
    return { stats: { updated: 1 } };
  }

  async set({ data }) {
    const d = coll(this.collName).find((x) => x._id === this.id);
    if (d) {
      const idx = coll(this.collName).indexOf(d);
      state.collections[this.collName][idx] = { ...clone(data), _id: this.id };
    } else {
      coll(this.collName).push({ ...clone(data), _id: this.id });
    }
    return { _id: this.id };
  }

  async remove() {
    state.collections[this.collName] = coll(this.collName).filter((x) => x._id !== this.id);
    return { stats: { removed: 1 } };
  }
}

// ---------------------------------------------------------------------------
// 聚合
// ---------------------------------------------------------------------------

class Aggregate {
  constructor(collName) {
    this.collName = collName;
    this._pipeline = [];
  }

  match(where) {
    this._pipeline.push({ $match: where });
    return this;
  }

  group(spec) {
    this._pipeline.push({ $group: spec });
    return this;
  }

  sort(spec) {
    this._pipeline.push({ $sort: spec });
    return this;
  }

  limit(n) {
    this._pipeline.push({ $limit: n });
    return this;
  }

  async end() {
    checkFail(this.collName, 'aggregate');
    let docs = coll(this.collName).filter((d) => matches(d, this._pipeline.find((p) => p.$match)?.$match));
    let spec = this._pipeline.find((p) => p.$group)?.$group;

    let rows;
    if (spec) {
      const groups = new Map();
      for (const d of docs) {
        const keyVal = spec._id.startsWith('$') ? getPath(d, spec._id.slice(1)) : spec._id;
        const key = JSON.stringify(keyVal);
        if (!groups.has(key)) {
          const g = { _id: keyVal };
          for (const k of Object.keys(spec)) {
            if (k === '_id') continue;
            const s = spec[k];
            g[k] = s.__cmd === 'sum' ? 0 : null;
          }
          groups.set(key, g);
        }
        const g = groups.get(key);
        for (const k of Object.keys(spec)) {
          if (k === '_id') continue;
          const s = spec[k];
          if (s.__cmd === 'sum') {
            g[k] += s.field !== undefined && s.field !== null && s.field !== ''
              ? (typeof s.field === 'number' ? s.field : (getPath(d, s.field.slice(1)) || 0))
              : 1;
          }
        }
      }
      rows = [...groups.values()];
    } else {
      rows = docs.map((d) => revive(clone(d)));
    }

    const sortSpec = this._pipeline.find((p) => p.$sort)?.$sort;
    if (sortSpec) {
      const entries = Object.entries(sortSpec);
      rows.sort((a, b) => {
        for (const [f, dir] of entries) {
          const r = cmp(getPath(a, f), getPath(b, f));
          if (r !== 0) return dir === -1 || dir === 'desc' ? -r : r;
        }
        return 0;
      });
    }

    const lim = this._pipeline.find((p) => p.$limit)?.$limit;
    if (lim != null) rows = rows.slice(0, lim);

    return { list: rows };
  }
}

// ---------------------------------------------------------------------------
// 事务（快照隔离语义：提交前写入不可见；仅 doc/add 可用）
// ---------------------------------------------------------------------------

class Transaction {
  constructor() {
    /** 缓冲的操作序列：{ type: 'add'|'update', collection, [id], data } */
    this._ops = [];
    this._done = false;
  }

  _assertOpen() {
    if (this._done) throw new Error('mock-sdk: transaction already finished');
  }

  /** 事务内的 doc 引用：update 缓冲到 commit，get 读当前快照 */
  _docRef(name, id) {
    const ref = new DocRef(name, id, { inTransaction: false });
    const self = this;
    ref.update = async ({ data }) => {
      self._assertOpen();
      self._ops.push({ type: 'update', collection: name, id, data: clone(data) });
      return { stats: { updated: 1 } };
    };
    return ref;
  }

  collection(name) {
    const self = this;
    return {
      doc: (id) => self._docRef(name, id),
      add: async ({ data }) => {
        self._assertOpen();
        self._ops.push({ type: 'add', collection: name, data: clone(data) });
        return { _id: 'txnid-' + self._ops.length };
      },
      // 平台限制：事务内 collection 上不存在 where / orderBy 等批量接口
      where() {
        throw new Error('mock-sdk [transaction]: 事务中不支持批量操作（where 语句），只支持单记录操作（collection.doc, collection.add）');
      }
    };
  }

  async commit() {
    this._assertOpen();
    for (const op of this._ops) {
      if (op.type === 'add') {
        checkFail(op.collection, 'add');
        coll(op.collection).push({ ...op.data, _id: newId() });
      } else if (op.type === 'update') {
        checkFail(op.collection, 'update');
        const d = coll(op.collection).find((x) => x._id === op.id);
        if (!d) throw new Error('mock-sdk: transaction update target not found: ' + op.collection + '/' + op.id);
        applyUpdate(d, op.data);
      }
    }
    this._done = true;
    return {};
  }

  async rollback() {
    this._done = true;
    return {};
  }
}

// ---------------------------------------------------------------------------
// Collection 入口
// ---------------------------------------------------------------------------

function collection(name) {
  return {
    where: (cond) => new Query(name).where(cond),
    orderBy: (field, dir) => new Query(name).orderBy(field, dir),
    limit: (n) => new Query(name).limit(n),
    doc: (id) => new DocRef(name, id),
    aggregate: () => new Aggregate(name),
    async add({ data }) {
      checkFail(name, 'add');
      const _id = newId();
      coll(name).push({ ...clone(data), _id });
      return { _id };
    }
  };
}

// ---------------------------------------------------------------------------
// cloud 对象（模块导出形态）
// ---------------------------------------------------------------------------

const DYNAMIC_CURRENT_ENV = Symbol('DYNAMIC_CURRENT_ENV');

const command = {
  eq: (v) => cmd('eq', { val: v }),
  neq: (v) => cmd('neq', { val: v }),
  gt: (v) => cmd('gt', { val: v }),
  gte: (v) => cmd('gte', { val: v }),
  lt: (v) => cmd('lt', { val: v }),
  lte: (v) => cmd('lte', { val: v }),
  in: (v) => cmd('in', { val: v }),
  inc: (n) => ({ __cmd: 'inc', val: n }),
  sum: (field) => ({ __cmd: 'sum', field: field !== undefined ? String(field) : '' })
};

const cloudExport = {
  DYNAMIC_CURRENT_ENV,
  init() { /* no-op */ },
  database() {
    return {
      command,
      collection,
      serverDate: () => (state.now ? new Date(state.now.getTime()) : new Date()),
      startTransaction: async () => new Transaction(),
      async runTransaction(fn) {
        const t = new Transaction();
        try {
          const result = await fn(t);
          await t.commit();
          return result;
        } catch (e) {
          await t.rollback();
          throw e;
        }
      }
    };
  },
  getWXContext() {
    return { ...state.context };
  },
  async callFunction({ name, data }) {
    const fn = state.registry[name];
    if (!fn) throw new Error('mock-sdk: cloud function not registered: ' + name);
    const result = await fn(data || {});
    return { result };
  },
  openapi: {
    wxacode: {
      async getUnlimited(opts) {
        if (state.openapiResult instanceof Error) throw state.openapiResult;
        return state.openapiResult || { buffer: Buffer.from('fake-qrcode') };
      }
    }
  },
  async uploadFile({ cloudPath }) {
    const fileID = 'cloud://mock-env.' + cloudPath;
    state.files[cloudPath] = fileID;
    return { fileID };
  },
  async getTempFileURL({ fileList }) {
    return {
      fileList: fileList.map((p) => ({
        fileID: state.files[p] || 'cloud://mock-env.' + p,
        status: state.tempVisible.has(p) ? 0 : -1
      }))
    };
  },
  // 测试专用句柄
  __mock: {
    state,
    resetDb,
    setContext,
    setOpenid,
    /** 注入下一次指定集合+操作抛错，如 failOn({collection:'checkins', op:'add', err:{errCode:-502005}}) */
    failOn(entry) {
      state.failOn.push(entry);
    },
    setNow(d) {
      state.now = d;
    },
    setOpenapiResult(r) {
      state.openapiResult = r;
    },
    markTempVisible(p) {
      state.tempVisible.add(p);
    },
    /** 直接读取集合（测试断言用） */
    raw(name) {
      return coll(name).map((d) => revive(clone(d)));
    }
  }
};

module.exports = cloudExport;
