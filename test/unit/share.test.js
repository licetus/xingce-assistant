'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadCf } = require('../helpers/load-cf.js');
const mockSdk = require('../helpers/mock-sdk.js');

beforeEach(() => {
  mockSdk.__mock.resetDb({});
  mockSdk.__mock.setOpenid('u-share-001');
  mockSdk.__mock.setNow(new Date('2026-09-06T10:00:00+08:00'));
});

test('qrcode：首次生成并上传', async () => {
  const cf = loadCf('share');
  const res = await cf.main({ action: 'qrcode', payload: { page: 'pages/index/index' } });

  assert.equal(res.code, 0);
  assert.equal(res.data.cached, false);
  assert.ok(res.data.fileID.includes('qrcode/'));
});

test('qrcode：重复生成返回完整 cloud:// fileID（不能是相对路径）', async () => {
  const cf = loadCf('share');
  await cf.main({ action: 'qrcode', payload: {} });
  const r2 = await cf.main({ action: 'qrcode', payload: {} });
  assert.equal(r2.code, 0);
  // 客户端 wx.cloud.getTempFileURL 只认完整 cloud:// 文件 ID，
  // 相对路径会导致海报图片加载失败（2026-09-08 修复缓存分支时踩过）
  assert.ok(r2.data.fileID.startsWith('cloud://'));
  assert.ok(r2.data.fileID.includes('qrcode/'));
});

test('qrcode：openapi 失败返回 500', async () => {
  const cf = loadCf('share');
  mockSdk.__mock.setOpenapiResult(new Error('openapi 47001'));
  const res = await cf.main({ action: 'qrcode', payload: {} });
  assert.equal(res.code, 500);
});

test('qrcode：未发布版 41030 回退空 page 重试成功', async () => {
  const cf = loadCf('share');
  const err41030 = new Error('openapi.wxacode.getUnlimited:fail invalid page');
  err41030.errCode = 41030;
  mockSdk.__mock.setOpenapiResult([err41030, { buffer: Buffer.from('fake-qrcode') }]);

  const res = await cf.main({ action: 'qrcode', payload: { page: 'pages/index/index' } });
  assert.equal(res.code, 0);
  assert.ok(res.data.fileID.startsWith('cloud://'));
});

test('qrcode：非 41030 的 openapi 失败不重试直接 500', async () => {
  const cf = loadCf('share');
  mockSdk.__mock.setOpenapiResult([new Error('openapi 45009'), new Error('should not be consumed')]);
  const res = await cf.main({ action: 'qrcode', payload: {} });
  assert.equal(res.code, 500);
});

test('qrcode：未登录返回 401', async () => {
  mockSdk.__mock.setOpenid('');
  const cf = loadCf('share');
  const res = await cf.main({ action: 'qrcode', payload: {} });
  assert.equal(res.code, 401);
});
