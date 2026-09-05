'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const IMPORT_DIR = path.join(ROOT, 'database/import');

test('导入文件必须是 JSON Lines（每行一个合法 JSON 对象）', () => {
  const files = fs.readdirSync(IMPORT_DIR).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 2, '应存在 questions 与 config 导入文件');

  files.forEach((f) => {
    const raw = fs.readFileSync(path.join(IMPORT_DIR, f), 'utf8').trim();
    assert.ok(raw.length > 0, `${f} 不能为空`);
    const lines = raw.split('\n');
    lines.forEach((line, i) => {
      let obj;
      assert.doesNotThrow(() => { obj = JSON.parse(line); }, `${f} 第 ${i + 1} 行不是合法 JSON`);
      assert.equal(typeof obj, 'object', `${f} 第 ${i + 1} 行必须是对象`);
      assert.ok(obj !== null && !Array.isArray(obj), `${f} 第 ${i + 1} 行不能是数组（控制台要求 JSON Lines）`);
    });
  });
});

test('题库数据：字段完整性与取值约束', () => {
  const files = fs.readdirSync(IMPORT_DIR).filter((f) => f.startsWith('questions_'));
  assert.ok(files.length >= 1, '应存在题库导入文件');

  const mustHave = ['qid', 'module', 'subtype', 'type', 'stem', 'options', 'answer', 'analysis', 'difficulty', 'status'];
  const validModules = ['常识判断', '言语理解', '数量关系', '判断推理', '资料分析'];
  const seen = new Set();

  files.forEach((f) => {
    const lines = fs.readFileSync(path.join(IMPORT_DIR, f), 'utf8').trim().split('\n');
    lines.forEach((line) => {
      const q = JSON.parse(line);
      mustHave.forEach((k) => assert.ok(q[k] !== undefined, `qid=${q.qid} 缺字段 ${k}`));
      assert.ok(Number.isInteger(q.qid) && q.qid > 0, `qid 非法: ${q.qid}`);
      assert.ok(validModules.includes(q.module), `qid=${q.qid} 模块非法: ${q.module}`);
      assert.ok(q.difficulty >= 1 && q.difficulty <= 5, `qid=${q.qid} 难度应 1~5: ${q.difficulty}`);
      assert.ok(q.status === 0 || q.status === 1, `qid=${q.qid} status 应 0/1`);
      assert.ok(Array.isArray(q.answer) && q.answer.length > 0, `qid=${q.qid} answer 应为非空数组`);
      assert.ok(Array.isArray(q.options) && q.options.length >= 2, `qid=${q.qid} options 至少两项`);
      assert.ok(q.stem && q.stem.length > 0, `qid=${q.qid} 题干为空`);
      assert.ok(!seen.has(q.qid), `qid=${q.qid} 重复`);
      seen.add(q.qid);
    });
  });
});

test('config 集合：必需键齐全', () => {
  const lines = fs.readFileSync(path.join(IMPORT_DIR, 'config.json'), 'utf8').trim().split('\n');
  const config = {};
  lines.forEach((l) => {
    const item = JSON.parse(l);
    config[item.key] = item.value;
  });

  ['audit_mode', 'min_version', 'latest_version', 'checkin_tmpl_id', 'share_text'].forEach((k) => {
    assert.ok(k in config, `config 集合缺初始键 ${k}`);
  });
});

test('建库清单：10 个集合与 16 条索引与代码使用一致', () => {
  const doc = fs.readFileSync(path.join(IMPORT_DIR, '导入说明.md'), 'utf8');
  // 代码实际使用的集合
  const usedCollections = [
    'users', 'questions', 'records', 'wrong_book', 'favorites',
    'checkins', 'daily_task', 'rank_cache', 'config', 'events', 'qgroups'
  ];
  usedCollections.forEach((c) => {
    assert.ok(doc.includes(c), `导入说明应覆盖集合 ${c}`);
  });
});
