#!/usr/bin/env node
/**
 * 合并 database/raw/fetched-*.csv 为一个 mega CSV
 *
 * 用途：
 *   一键灌库 1185 题时，需要一个汇总文件喂给 import-questions.js
 *   比依次跑 9 次更高效、更易于追踪
 *
 * 用法：
 *   node scripts/merge-fetched.js
 *   node scripts/merge-fetched.js --json      # 同步输出 JSON（结构化）
 *
 * 去重规则：
 *   同一题干视为同一题（用 stem 哈希去重，跨卷撞题也只保留一道）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RAW_DIR = path.join(__dirname, '..', 'database', 'raw');
const OUT_DIR = path.join(__dirname, '..', 'database', 'import');
const HEADER = '模块,二级考点,类型,题干,选项A,选项B,选项C,选项D,答案,解析,难度,标签';

// 引号感知的 CSV 切行（与 fetch-gkzhenti.js 保持一致）
function splitLines(text) {
  const lines = [];
  let buf = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"' && text[i + 1] === '"') { buf += '""'; i++; }
      else if (c === '"') { buf += '"'; inQuote = false; }
      else { buf += c; }
    } else if (c === '"') { buf += '"'; inQuote = true; }
    else if (c === '\n') { lines.push(buf); buf = ''; }
    else if (c !== '\r') { buf += c; }
  }
  if (buf) lines.push(buf);
  return lines;
}

function main() {
  const wantJson = process.argv.includes('--json');
  const files = fs.readdirSync(RAW_DIR)
    .filter((f) => /^fetched-\d{4}-[a-z]+\.csv$/.test(f))
    .sort();
  if (!files.length) {
    console.error('database/raw/ 下没有 fetched-*.csv，先跑 fetch-gkzhenti.js --all');
    process.exit(1);
  }

  const seen = new Set();
  const rows = [];
  const meta = []; // 用于 JSON 输出

  for (const f of files) {
    const raw = fs.readFileSync(path.join(RAW_DIR, f), 'utf8').replace(/^\uFEFF/, '');
    const lines = splitLines(raw).slice(1).filter(Boolean);
    const csvRows = [];
    for (const line of lines) {
      const cells = parseRow(line);
      if (cells.length < 12) continue;
      // 用题干做哈希去重
      const stem = cells[3];
      const hash = crypto.createHash('md5').update(stem).digest('hex');
      if (seen.has(hash)) continue;
      seen.add(hash);
      // 重新 escape（parseRow 已剥引号，必须再包一次否则丢引号）
      csvRows.push(cells.map(escapeCell).join(','));
      meta.push({
        module: cells[0],
        subtype: cells[1],
        stem,
        options: { A: cells[4], B: cells[5], C: cells[6], D: cells[7] },
        answer: cells[8],
        analysis: cells[9],
        difficulty: Number(cells[10]) || 3,
        tags: cells[11],
        sourceFile: f
      });
    }
    rows.push(...csvRows);
    console.log(`  ${f}: ${csvRows.length} 题${lines.length - csvRows.length ? ` (去重 ${lines.length - csvRows.length})` : ''}`);
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const csvOut = path.join(OUT_DIR, 'fetched-all.csv');
  const jsonOut = path.join(OUT_DIR, 'fetched-all.json');
  fs.writeFileSync(csvOut, '\uFEFF' + HEADER + '\n' + rows.join('\n') + '\n', 'utf8');
  if (wantJson) {
    fs.writeFileSync(jsonOut, JSON.stringify({ total: rows.length, questions: meta }, null, 2), 'utf8');
    console.log(`  JSON: ${jsonOut}`);
  }

  console.log(`\n合并完成：${rows.length} 题（去重后）`);
  console.log(`CSV: ${csvOut}`);
  console.log('\n下一步：');
  console.log('  node scripts/import-questions.js database/import/fetched-all.csv --allow-empty-analysis');
}

function parseRow(line) {
  const cells = [];
  let field = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuote = false; }
      else { field += c; }
    } else if (c === '"') { inQuote = true; }
    else if (c === ',') { cells.push(field); field = ''; }
    else { field += c; }
  }
  cells.push(field);
  return cells;
}

function escapeCell(s) {
  if (s == null) return '';
  const v = String(s);
  if (v.indexOf(',') < 0 && v.indexOf('"') < 0 && v.indexOf('\n') < 0) return v;
  return '"' + v.replace(/"/g, '""') + '"';
}

main();