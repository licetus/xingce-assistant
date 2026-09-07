#!/usr/bin/env node
/**
 * 题库导入脚本
 *
 * 用法：
 *   node scripts/import-questions.js ./题库.xlsx转成的.csv
 *   node scripts/import-questions.js ./questions.json
 *
 * 做什么：
 *   1. 读取 JSON / CSV 题库
 *   2. 字段归一化（列名容错，支持中英文表头）
 *   3. 校验：模块名、选项、答案、解析是否合规
 *   4. 按 stem 去重，自动补 qid
 *   5. 切片输出成云开发控制台可直接导入的 JSON 文件
 *
 * 为什么输出文件而不是直连数据库：
 *   云开发的 wx-server-sdk 只能在云函数内运行，本地脚本无法直连。
 *   走「脚本清洗 → 控制台导入」这条路零依赖、零鉴权配置，第一天就能用。
 *   等后续接入 CI，再换成云开发 HTTP API 自动导入。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODULES = ['常识判断', '言语理解', '数量关系', '判断推理', '资料分析'];
const CHUNK_SIZE = 1000; // 云开发控制台单文件建议不超过 1 万条，这里保守取 1000
const OUT_DIR = path.join(__dirname, '..', 'database', 'import');

// --allow-empty-analysis：跳过「解析缺失」校验
// 用途：批量灌入来源题库（gkzhenti.cn 等只含答案不含解析的），
//       让题目先上线待审，解析字段填「待补」标识，后续人工补
let ALLOW_EMPTY_ANALYSIS = false;

/** 表头容错：一个字段可能有多种写法 */
const FIELD_ALIAS = {
  module: ['module', '模块', '题型', '专项', 'category'],
  subtype: ['subtype', '二级考点', '考点', '知识点', 'tag'],
  type: ['type', '类型', '单选多选', '题型类别'],
  stem: ['stem', '题干', '题目', 'question', 'title'],
  optA: ['A', 'a', '选项A', 'optionA', 'option_a'],
  optB: ['B', 'b', '选项B', 'optionB', 'option_b'],
  optC: ['C', 'c', '选项C', 'optionC', 'option_c'],
  optD: ['D', 'd', '选项D', 'optionD', 'option_d'],
  answer: ['answer', '答案', '正确答案', 'correct'],
  analysis: ['analysis', '解析', 'explanation', 'explain'],
  difficulty: ['difficulty', '难度', 'level'],
  tags: ['tags', '标签', 'labels']
};

function pick(row, key) {
  const aliases = FIELD_ALIAS[key] || [key];
  for (const a of aliases) {
    if (row[a] !== undefined && row[a] !== null && String(row[a]).trim() !== '') {
      return String(row[a]).trim();
    }
  }
  return '';
}

/** 极简 CSV 解析：支持引号包裹与转义，够用且不引依赖 */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuote = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuote = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function readInput(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (file.toLowerCase().endsWith('.json')) {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : data.questions || [];
  }

  const rows = parseCSV(raw).filter((r) => r.length > 1);
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const obj = {};
    header.forEach((h, i) => (obj[h] = cells[i]));
    return obj;
  });
}

function normalizeModule(raw) {
  const s = (raw || '').replace(/\s/g, '');
  const hit = MODULES.find((m) => s.indexOf(m) >= 0 || m.indexOf(s) >= 0);
  return hit || '';
}

function normalizeAnswer(raw) {
  const s = (raw || '')
    .toUpperCase()
    .replace(/[^A-D]/g, '');
  return s.split('');
}

function buildQuestion(row, index, startQid) {
  const stem = pick(row, 'stem');
  const answer = normalizeAnswer(pick(row, 'answer'));
  const analysis = pick(row, 'analysis');
  const options = ['A', 'B', 'C', 'D']
    .map((k) => ({ key: k, text: pick(row, 'opt' + k) }))
    .filter((o) => o.text);

  const rawType = pick(row, 'type');
  const type = rawType.indexOf('多') >= 0 || answer.length > 1 ? 'multi' : 'single';

  const difficultyRaw = Number(pick(row, 'difficulty'));
  const difficulty = difficultyRaw >= 1 && difficultyRaw <= 5 ? Math.round(difficultyRaw) : 3;

  const tagsRaw = pick(row, 'tags');
  const tags = tagsRaw
    ? tagsRaw.split(/[,，、|]/).map((t) => t.trim()).filter(Boolean).slice(0, 5)
    : [];

  return {
    qid: startQid + index,
    module: normalizeModule(pick(row, 'module')),
    subtype: pick(row, 'subtype'),
    type,
    stem: stem.trim(),
    options,
    answer,
    analysis: analysis.trim(),
    difficulty,
    tags,
    materialId: null,
    images: [],
    source: 'self',
    status: 1,
    stat: { done: 0, correct: 0 },
    createdAt: { $date: new Date().toISOString() }
  };
}

function validate(q) {
  const errors = [];
  if (!q.module) errors.push('模块无法识别');
  if (!q.stem) errors.push('题干为空');
  if (q.options.length < 2) errors.push('选项少于 2 个');
  if (!q.answer.length) errors.push('答案为空');
  if (q.answer.some((a) => !q.options.find((o) => o.key === a))) {
    errors.push('答案不在选项内');
  }
  // 解析非空校验：默认严格，--allow-empty-analysis 跳过
  if (!ALLOW_EMPTY_ANALYSIS) {
    if (!q.analysis || q.analysis.length < 5) errors.push('解析缺失或过短');
  }
  return errors;
}

function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('用法: node scripts/import-questions.js <题库.json 或 题库.csv>');
    process.exit(1);
  }

  // 解析剩余参数
  for (let i = 3; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--allow-empty-analysis' || a === '--no-analysis') {
      ALLOW_EMPTY_ANALYSIS = true;
      console.log('⚠️  跳过解析非空校验（题目带「待补」占位入库）');
    }
  }

  const rows = readInput(input);
  console.log(`读取到 ${rows.length} 行原始数据`);

  const startQid = Number(process.argv[3]) || 10001;
  const valid = [];
  const invalid = [];
  const seen = new Set();

  rows.forEach((row, i) => {
    const q = buildQuestion(row, i, startQid);
    const errors = validate(q);

    // 题干去重：防止同一道题在表里出现多次
    const hash = crypto.createHash('md5').update(q.stem).digest('hex');
    if (seen.has(hash)) {
      invalid.push({ row: i + 2, qid: q.qid, errors: ['题干重复'] });
      return;
    }

    if (errors.length) {
      invalid.push({ row: i + 2, qid: q.qid, errors });
      return;
    }

    seen.add(hash);
    valid.push(q);
  });

  console.log(`\n校验通过 ${valid.length} 题，失败 ${invalid.length} 题`);

  if (invalid.length) {
    console.log('\n失败明细（前 30 条）：');
    invalid.slice(0, 30).forEach((it) => {
      console.log(`  第 ${it.row} 行 [${it.errors.join(' / ')}]`);
    });
    fs.writeFileSync(
      path.join(__dirname, '..', 'database', 'raw', 'invalid.json'),
      JSON.stringify(invalid, null, 2),
      'utf8'
    );
    console.log(`\n完整失败清单已写入 database/raw/invalid.json`);
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // 切片输出，避免单文件过大导致控制台导入失败
  //
  // 注意：云开发控制台导入的 JSON 必须是 JSON Lines 格式——
  // 每行一个完整对象，用 \n 分隔，而不是标准 JSON 数组。
  // 写成 JSON.stringify(chunk, null, 2) 会在控制台报「格式错误」直接导入失败。
  const files = [];
  for (let i = 0; i < valid.length; i += CHUNK_SIZE) {
    const chunk = valid.slice(i, i + CHUNK_SIZE);
    const name = `questions_${String(files.length + 1).padStart(3, '0')}.json`;
    const file = path.join(OUT_DIR, name);
    const lines = chunk.map((q) => JSON.stringify(q)).join('\n') + '\n';
    fs.writeFileSync(file, lines, 'utf8');
    files.push(name);
  }

  // 顺便输出一份统计，方便确认各模块题量是否均衡
  const byModule = {};
  valid.forEach((q) => {
    byModule[q.module] = (byModule[q.module] || 0) + 1;
  });

  console.log('\n各模块题量：');
  MODULES.forEach((m) => {
    console.log(`  ${m}: ${byModule[m] || 0}`);
  });

  console.log(`\n已生成 ${files.length} 个导入文件到 database/import/`);
  console.log('下一步：微信开发者工具 → 云开发 → 数据库 → questions 集合 → 导入');
}

main();
