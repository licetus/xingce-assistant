'use strict';

/**
 * 云函数加载器
 *
 * 1. 拦截 require('wx-server-sdk') → 指向 test/helpers/mock-sdk.js
 * 2. loadCf(name) 每次删除模块缓存后重新加载，
 *    保证云函数自身的模块级状态（如 question 的统计缓存）可控重置
 * 3. 加载后自动注册进 mock 的 registry，供 cloud.callFunction 派发
 */

const Module = require('module');
const path = require('path');

const mockSdkPath = require.resolve('./mock-sdk.js');
const CF_ROOT = path.resolve(__dirname, '../../cloudfunctions');
const loadedPaths = new Set();

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'wx-server-sdk') return mockSdkPath;
  return origResolve.call(this, request, parent, ...rest);
};

function loadCf(name) {
  const file = path.join(CF_ROOT, name, 'index.js');
  const sdk = require('./mock-sdk.js');

  // 清除该云函数及所有已加载云函数的缓存（云函数间无共享代码，互不影响）
  for (const p of loadedPaths) {
    delete require.cache[p];
    loadedPaths.delete(p);
  }
  // mock-sdk 本身绝不清除 —— 它承载全局唯一状态

  const mod = require(file);
  const fn = typeof mod.main === 'function' ? mod.main : mod;
  loadedPaths.add(file);
  sdk.__mock.state.registry[name] = fn;
  return { main: fn };
}

/** 预注册云函数但不调用（用于 callFunction 派发场景） */
function registerAll(names) {
  const sdk = require('./mock-sdk.js');
  names.forEach((name) => {
    const file = path.join(CF_ROOT, name, 'index.js');
    const mod = require(file);
    const fn = typeof mod.main === 'function' ? mod.main : mod;
    loadedPaths.add(file);
    sdk.__mock.state.registry[name] = fn;
  });
}

module.exports = { loadCf, registerAll };
