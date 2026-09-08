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

/**
 * cloud:// fileID → https 临时链接（wx.cloud.getTempFileURL）
 *
 * 背景：<image src> 直填 cloud:// fileID 在渲染层（尤其开发者工具 webview）转换
 * 不稳定，失败时 fileID 会被当相对路径拼到页面路径上，报
 * 「Failed to load image .../__pageframe__/pages/index/cloud://...」。
 * 统一在展示前换成 https 临时链接。
 *
 * - 临时链接约 2 小时有效，Map 内存缓存：小程序冷启动后重复换链无额外请求
 * - 转换失败返回空串（页面用默认头像兜底）：回退原 fileID 只会让渲染层继续报
 *   「Failed to load image .../cloud://...」，等于没修，所以绝不回退 fileID
 */
const tempUrlCache = new Map();

function resolveFileUrls(fileList) {
  const ids = Array.from(
    new Set((fileList || []).filter((u) => typeof u === 'string' && u.indexOf('cloud://') === 0))
  );

  const result = new Map();
  const miss = [];
  ids.forEach((id) => {
    if (tempUrlCache.has(id)) result.set(id, tempUrlCache.get(id));
    else miss.push(id);
  });

  if (!miss.length) return Promise.resolve(result);

  const fallbackAll = (reason) => {
    console.warn('[cloud] getTempFileURL 失败，头像等云图走默认占位：', reason);
    miss.forEach((id) => result.set(id, ''));
    return resolve(result);
  };

  return new Promise((resolve) => {
    if (!wx.cloud || !wx.cloud.getTempFileURL) {
      return fallbackAll('基础库不支持 wx.cloud.getTempFileURL');
    }

    wx.cloud.getTempFileURL({
      fileList: miss,
      success: (res) => {
        (res.fileList || []).forEach((f) => {
          if (f && f.fileID && f.tempFileURL) {
            tempUrlCache.set(f.fileID, f.tempFileURL);
            result.set(f.fileID, f.tempFileURL);
          }
        });
        // 没换到链接的（权限/不存在等）返回空串，页面用默认图兜底
        miss.forEach((id) => {
          if (!result.has(id)) result.set(id, '');
        });
        resolve(result);
      },
      fail: (err) => fallbackAll(err && err.errMsg)
    });
  });
}

/** 单个 fileID 转换便捷方法；非 cloud:// 开头原样返回，失败返回空串 */
async function resolveFileUrl(fileID) {
  if (typeof fileID !== 'string' || fileID.indexOf('cloud://') !== 0) return fileID;
  const m = await resolveFileUrls([fileID]);
  return m.get(fileID) || '';
}

module.exports = { call, all, resolveFileUrls, resolveFileUrl, BizError, NetError };
