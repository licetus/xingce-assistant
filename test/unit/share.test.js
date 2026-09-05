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

test('qrcode：重复生成命中缓存', async () => {
  const cf = loadCf('share');
  const r1 = await cf.main({ action: 'qrcode', payload: {} });
  // 标记该路径为「已存在于云存储」
  mockSdk.__mock.markTempVisible('qrcode/' + String(r1.data.fileID).split('qrcode/')[1]);

  const r2 = await cf.main({ action: 'qrcode', payload: {} });
  assert.equal(r2.code, 0);
  assert.equal(r2.data.cached, true);
});

test('qrcode：openapi 失败返回 500', async () => {
  const cf = loadCf('share');
  mockSdk.__mock.setOpenapiResult(new Error('openapi 47001'));
  const res = await cf.main({ action: 'qrcode', payload: {} });
  assert.equal(res.code, 500);
});

test('qrcode：未登录返回 401', async () => {
  mockSdk.__mock.setOpenid('');
  const cf = loadCf('share');
  const res = await cf.main({ action: 'qrcode', payload: {} });
  assert.equal(res.code, 401);
});
