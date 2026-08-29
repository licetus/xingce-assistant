/**
 * 带 TTL 的 storage 封装
 *
 * 用途：首页首屏先渲染缓存再静默刷新；云存储临时链接缓存（临时链接有效期 2 小时，这里设 90 分钟）
 */

const PREFIX = 'xc_';

function get(key, defaultValue = null) {
  try {
    const raw = wx.getStorageSync(PREFIX + key);
    if (!raw) return defaultValue;
    const { value, expire } = raw;
    if (expire && Date.now() > expire) {
      wx.removeStorageSync(PREFIX + key);
      return defaultValue;
    }
    return value;
  } catch (err) {
    return defaultValue;
  }
}

function set(key, value, ttlMs = 0) {
  try {
    wx.setStorageSync(PREFIX + key, {
      value,
      expire: ttlMs > 0 ? Date.now() + ttlMs : 0
    });
    return true;
  } catch (err) {
    // 超配额时清掉最老的缓存重试一次
    console.warn('[cache] set failed, clearing old cache', err);
    try {
      const info = wx.getStorageInfoSync();
      (info.keys || [])
        .filter((k) => k.indexOf(PREFIX) === 0)
        .slice(0, 20)
        .forEach((k) => wx.removeStorageSync(k));
      wx.setStorageSync(PREFIX + key, {
        value,
        expire: ttlMs > 0 ? Date.now() + ttlMs : 0
      });
      return true;
    } catch (e) {
      return false;
    }
  }
}

function remove(key) {
  try {
    wx.removeStorageSync(PREFIX + key);
  } catch (err) {
    /* ignore */
  }
}

module.exports = { get, set, remove, MINUTE: 60 * 1000, HOUR: 60 * 60 * 1000, DAY: 24 * 60 * 60 * 1000 };
