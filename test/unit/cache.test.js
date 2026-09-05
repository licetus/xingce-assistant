'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createWxEnv, uninstall } = require('../helpers/mock-wx.js');

// cache 依赖全局 wx（调用时），先装好再 require
const env = createWxEnv();
env.install();
const cache = require('../../miniprogram/utils/cache.js');

beforeEach(() => {
  // 清空 storage
  for (const k of [...env.storage.keys()]) env.storage.delete(k);
});

test('set/get：基础读写', () => {
  cache.set('k1', { a: 1 });
  assert.deepEqual(cache.get('k1'), { a: 1 });
});

test('get：无值返回默认值', () => {
  assert.equal(cache.get('nope'), null);
  assert.equal(cache.get('nope', 'fallback'), 'fallback');
});

test('TTL：过期后返回默认值并清除存储', () => {
  cache.set('short', 'v', 60 * 1000); // 1 分钟
  // 手动把存储中的过期时间改到过去
  const raw = env.storage.get('xc_short');
  raw.expire = Date.now() - 1;
  env.storage.set('xc_short', raw);

  assert.equal(cache.get('short', 'expired'), 'expired');
  assert.equal(env.storage.has('xc_short'), false, '过期键应被清除');
});

test('TTL：未过期正常返回', () => {
  cache.set('live', 'v', 60 * 60 * 1000);
  assert.equal(cache.get('live'), 'v');
});

test('remove：删除', () => {
  cache.set('k', 1);
  cache.remove('k');
  assert.equal(cache.get('k'), null);
});

test('写入异常时清老缓存重试', () => {
  // 让 setStorageSync 第一次抛错
  const orig = env.wx.setStorageSync;
  let failed = false;
  env.wx.setStorageSync = (k, v) => {
    if (!failed && k === 'xc_new') {
      failed = true;
      throw new Error('exceed storage quota');
    }
    orig(k, v);
  };

  cache.set('new', 'data');
  env.wx.setStorageSync = orig;
  assert.equal(cache.get('new'), 'data');
});

// 测完清理全局
process.on('exit', () => uninstall());
