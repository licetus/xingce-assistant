'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fmt = require('../../miniprogram/utils/format.js');

test('today：东八区日期（UTC 00:30 = 东八 08:30）', () => {
  assert.equal(fmt.today(new Date('2026-09-06T00:30:00Z')), '2026-09-06');
});

test('today：UTC 16:00 = 次日 00:00，跨日翻转', () => {
  assert.equal(fmt.today(new Date('2026-09-06T16:00:00Z')), '2026-09-07');
});

test('offsetDay：正负偏移', () => {
  const base = new Date('2026-09-06T10:00:00+08:00');
  assert.equal(fmt.offsetDay(-1, base), '2026-09-05');
  assert.equal(fmt.offsetDay(1, base), '2026-09-07');
  assert.equal(fmt.offsetDay(-30, base), '2026-08-07');
});

test('offsetDay：月末跨月', () => {
  const base = new Date('2026-09-01T00:00:00+08:00');
  assert.equal(fmt.offsetDay(-1, base), '2026-08-31');
});

test('duration：毫秒转 mm:ss', () => {
  assert.equal(fmt.duration(0), '00:00');
  assert.equal(fmt.duration(65000), '01:05');
  assert.equal(fmt.duration(3599000), '59:59');
});

test('durationText：中文时长', () => {
  assert.equal(fmt.durationText(45000), '45秒');
  assert.equal(fmt.durationText(80000), '1分20秒');
});

test('percent：正确率', () => {
  assert.equal(fmt.percent(8, 10), 80);
  assert.equal(fmt.percent(0, 0), 0);
  assert.equal(fmt.percent(1, 3), 33);
});

test('relativeTime：相对时间文案', () => {
  const now = Date.now();
  assert.equal(fmt.relativeTime(now - 30000), '刚刚');
  assert.equal(fmt.relativeTime(now - 5 * 60000), '5分钟前');
  assert.equal(fmt.relativeTime(now - 3 * 3600000), '3小时前');
  assert.equal(fmt.relativeTime(now - 2 * 86400000), '2天前');
  assert.equal(fmt.relativeTime(now - 30 * 86400000), new Date(now - 30 * 86400000).getMonth() + 1 + '月' + new Date(now - 30 * 86400000).getDate() + '日');
});

test('MODULES：五大模块齐全有序', () => {
  assert.deepEqual(fmt.MODULES, ['常识判断', '言语理解', '数量关系', '判断推理', '资料分析']);
});
