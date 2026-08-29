/**
 * 云调用统一出口
 *
 * 架构约定：全项目禁止在页面/组件里直接 wx.cloud.callFunction 或 wx.cloud.database，
 * 必须经由此文件。将来若迁自建后端，只改这一层（换成 wx.request 即可），业务代码零改动。
 *
 * 统一处理：loading 计数、业务错误码、网络重试、未登录重登、错误上报
 */

const MAX_RETRY = 2;
const RETRY_DELAY = 400;

/** 并发 loading 计数，避免多个请求互相 cancel 导致闪一下就没了 */
let loadingCount = 0;

function showLoading(text) {
  loadingCount += 1;
  if (loadingCount === 1) {
    wx.showLoading({ title: text, mask: true });
  }
}

function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (loadingCount === 0) {
    wx.hideLoading();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 业务错误：云函数主动返回的 { code, message } */
class BizError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.isBiz = true;
  }
}

/** 网络/系统错误：callFunction 自身失败 */
class NetError extends Error {
  constructor(message, detail) {
    super(message);
    this.code = -1;
    this.detail = detail;
    this.isNet = true;
  }
}

function shouldRetry(err) {
  if (err.isNet) return true;
  // 云函数冷启动偶发 -504003 网关超时，值得一试
  return err.code === -504003 || err.code === -504002;
}

async function invoke(name, action, payload, attempt) {
  try {
    const res = await wx.cloud.callFunction({
      name,
      data: { action, payload }
    });

    const body = res && res.result;

    // 云函数未按规定格式返回
    if (!body || typeof body !== 'object') {
      throw new BizError(-500, '服务返回格式异常');
    }

    if (body.code === 0) {
      return body.data;
    }

    // 登录态失效：重新登录后原样重试一次
    if (body.code === 401 && attempt === 0) {
      await require('./session').relogin();
      return invoke(name, action, payload, attempt + 1);
    }

    throw new BizError(body.code, body.message || '请求失败');
  } catch (err) {
    if (err.isBiz) throw err;
    throw new NetError(err.errMsg || '网络异常', err);
  }
}

/**
 * @param {string} name    云函数名
 * @param {string} action  动作，云函数内路由
 * @param {object} payload 业务参数
 * @param {object} options
 *   loading      {boolean} 是否显示 loading，默认 false
 *   loadingText  {string}
 *   silent       {boolean} 静默失败（不弹 toast），默认 false
 *   retry        {number}  额外重试次数，默认 2（仅对网络错误生效）
 * @returns {Promise<any>} 云函数 data 字段
 */
function call(name, action, payload = {}, options = {}) {
  const {
    loading = false,
    loadingText = '加载中',
    silent = false,
    retry = MAX_RETRY
  } = options;

  if (loading) showLoading(loadingText);

  const run = async (attempt) => {
    try {
      return await invoke(name, action, payload, attempt);
    } catch (err) {
      if (attempt < retry && shouldRetry(err)) {
        await sleep(RETRY_DELAY * (attempt + 1));
        return run(attempt + 1);
      }
      throw err;
    }
  };

  return run(0)
    .then((data) => {
      if (loading) hideLoading();
      return data;
    })
    .catch((err) => {
      if (loading) hideLoading();

      const msg = err.isBiz ? err.message : '网络不太给力，稍后再试';
      if (!silent) {
        wx.showToast({ title: msg, icon: 'none', duration: 2000 });
      }

      try {
        require('./track').error('cloud_call_fail', {
          fn: name,
          action,
          code: err.code,
          msg: err.message
        });
      } catch (e) {
        /* 埋点不能影响主流程 */
      }

      return Promise.reject(err);
    });
}

/** 并发发起多个云调用，任一失败不阻断其他（用于首页聚合数据） */
function all(tasks) {
  return Promise.all(tasks.map((t) => call(t.name, t.action, t.payload, t.options).catch(() => null)));
}

module.exports = { call, all, BizError, NetError };
