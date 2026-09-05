'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadCf } = require('../helpers/load-cf.js');
const mockSdk = require('../helpers/mock-sdk.js');

beforeEach(() => {
  mockSdk.__mock.resetDb({});
  mockSdk.__mock.setOpenid('u-track-001');
});

test('batch：埋点批量落库', async () => {
  const cf = loadCf('track');
  const res = await cf.main({
    action: 'batch',
    payload: {
      events: [
        { event: 'page_view', payload: { path: 'pages/index/index' }, ts: Date.now() },
        { event: 'practice_finish', payload: { total: 10, correct: 8 } }
      ]
    }
  });

  assert.equal(res.code, 0);
  assert.equal(res.data.count, 2);
  const events = mockSdk.__mock.raw('events');
  assert.equal(events.length, 2);
  assert.equal(events[0]._openid, 'u-track-001');
  assert.equal(events[1].event, 'practice_finish');
});

test('batch：超长 event 名截断到 64 字符', async () => {
  const cf = loadCf('track');
  const longName = 'x'.repeat(100);
  await cf.main({ action: 'batch', payload: { events: [{ event: longName }] } });

  assert.equal(mockSdk.__mock.raw('events')[0].event.length, 64);
});

test('batch：超过 50 条截断', async () => {
  const cf = loadCf('track');
  const events = Array.from({ length: 80 }, (_, i) => ({ event: 'e' + i }));
  const res = await cf.main({ action: 'batch', payload: { events } });

  assert.equal(res.data.count, 50);
  assert.equal(mockSdk.__mock.raw('events').length, 50);
});

test('batch：空事件列表直接返回 0', async () => {
  const cf = loadCf('track');
  const res = await cf.main({ action: 'batch', payload: { events: [] } });
  assert.equal(res.code, 0);
  assert.equal(res.data.count, 0);
});

test('batch：单条写失败不影响其他事件', async () => {
  const cf = loadCf('track');
  mockSdk.__mock.failOn({ collection: 'events', op: 'add', err: new Error('mock partial fail') });

  const res = await cf.main({
    action: 'batch',
    payload: { events: [{ event: 'a' }, { event: 'b' }] }
  });
  assert.equal(res.code, 0);
  assert.equal(res.data.count, 1, '第一条失败，第二条成功');
});

test('batch：未登录时 openid 空串仍可写入（埋点不拦业务）', async () => {
  mockSdk.__mock.setOpenid('');
  const cf = loadCf('track');
  const res = await cf.main({ action: 'batch', payload: { events: [{ event: 'anon' }] } });
  assert.equal(res.code, 0);
  assert.equal(mockSdk.__mock.raw('events')[0]._openid, '');
});
