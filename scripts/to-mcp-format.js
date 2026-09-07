#!/usr/bin/env node
/**
 * 把 import-questions.js 产出的 questions_NNN.json（JSON Lines，控制台导入格式）
 * 转成 CloudBase MCP / HTTP API 可直接 insert 的格式
 *
 * 为什么要转：
 *   控制台格式为了满足「导入时能保留 Date 类型」，用 {"$date": "..."} 扩展 JSON。
 *   但 MCP writeNoSqlDatabaseContent 的 insert 不接受这种扩展结构，
 *   且不接受显式 null 字段（实测报 [PutItem] Check request parameter fail）。
 *   所以这里做两件事：
 *     1. {"$date": "..."} -> ISO 字符串（或直接删掉，让服务端生成）
 *     2. 删除所有值为 null 的字段
 *
 * 用法：
 *   node scripts/to-mcp-format.js                    # 转 questions_001.json
 *   node scripts/to-mcp-format.js --batch 40         # 同时切成 40 条一批
 */

const fs = require('fs');
const path = require('path');

const IMPORT_DIR = path.join(__dirname, '..', 'database', 'import');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { batch: 0, input: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--batch') opts.batch = Number(args[++i]);
    else if (args[i] === '--input') opts.input = args[++i];
  }
  return opts;
}

/** 递归清理：删 null、把 {$date} 摊平成 ISO 字符串 */
function clean(obj) {
  if (Array.isArray(obj)) return obj.map(clean);
  if (obj && typeof obj === 'object') {
    // {$date: ...} 特殊处理
    if (obj.$date) return new Date(obj.$date).toISOString();
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) continue; // 删 null
      out[k] = clean(v);
    }
    return out;
  }
  return obj;
}

function main() {
  const opts = parseArgs();
  const input = opts.input || path.join(IMPORT_DIR, 'questions_001.json');
  if (!fs.existsSync(input)) {
    console.error('找不到输入文件:', input);
    process.exit(1);
  }

  const lines = fs
    .readFileSync(input, 'utf8')
    .split('\n')
    .filter((l) => l.trim());

  const docs = lines.map((l) => clean(JSON.parse(l)));
  console.log(`读取 ${docs.length} 条，清理 null / \$date 完成`);

  const outFile = path.join(IMPORT_DIR, 'questions.mcp.json');
  fs.writeFileSync(outFile, JSON.stringify(docs), 'utf8');
  const kb = (fs.statSync(outFile).size / 1024).toFixed(1);
  console.log(`已写入 ${outFile} (${kb} KB)`);

  if (opts.batch > 0) {
    const batchDir = path.join(IMPORT_DIR, 'batches');
    if (!fs.existsSync(batchDir)) fs.mkdirSync(batchDir, { recursive: true });
    let n = 0;
    for (let i = 0; i < docs.length; i += opts.batch) {
      const chunk = docs.slice(i, i + opts.batch);
      const f = path.join(batchDir, `batch_${String(++n).padStart(3, '0')}.json`);
      fs.writeFileSync(f, JSON.stringify(chunk), 'utf8');
    }
    console.log(`已切成 ${n} 批（每批 ${opts.batch} 条）到 ${batchDir}/`);
  }

  console.log('\n下一步：');
  console.log('  微信开发者工具 → 云开发 → 数据库 → questions → 导入 questions_001.json');
  console.log('  或：用 CloudBase MCP writeNoSqlDatabaseContent insert 分批导入 questions.mcp.json');
}

main();
