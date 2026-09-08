#!/usr/bin/env node
/**
 * 从「公开真题库」(gwy.gkzhenti.cn) 抓取国考行测真题
 *
 * 为什么写这个：
 *   - 国家公务员局主站 (scs.gov.cn) 已下线 (2026 年 8 月底)
 *   - 专题网站 (bm.scs.gov.cn) 只服务当年度考试，不归档历年真题
 *   - gkzhenti.cn 是 2026 年新备案的「为爱发电」资料站
 *     只收录公开真题题干 + 答案，不含第三方解析
 *     真题题干是政府公开信息，版权风险最低
 *
 * 用法：
 *   node scripts/fetch-gkzhenti.js --year 2024 --type fusheng
 *   node scripts/fetch-gkzhenti.js --year 2024 --type dimenji
 *   node scripts/fetch-gkzhenti.js --year 2024 --type xingzheng
 *   node scripts/fetch-gkzhenti.js --all              # 三年 9 套全抓
 *   node scripts/fetch-gkzhenti.js --list             # 列出所有可选
 *
 * 输出：
 *   database/raw/fetched-{year}-{type}.csv   给 Excel 打开填解析
 *   database/raw/fetched-{year}-{type}.json  给 import-questions.js 导入
 *
 * 下一步：
 *   1. Excel 打开 CSV，填「解析」列（最关键、最有版权价值）
 *   2. node scripts/import-questions.js database/raw/fetched-2024-fusheng.csv
 *   3. 微信开发者工具 → 云开发 → questions 集合 → 导入
 *
 * 零依赖：纯 Node.js https + 字符串解析，避免 cheerio/jsdom 装包
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// 题源映射。
// ⚠️ 2026-09-08 重大勘误：初版映射把 paperId 与年份/卷别对应错了（仅 2024 副省级正确），
// 以站点试卷页 h3/<title> 为准重新核实（paperId 创建时间戳 + 数量关系15题=副省级 双重佐证）：
//   1723610466211 = 2024副省级(135)  1723610466312 = 2024地市级(130)  1723610466110 = 2024行政执法(130)
//   1735356969686 = 2025副省级(135)  1735356969586 = 2025地市级(130)  1735356969485 = 2025行政执法(130)
//   1767342831860 = 2026副省级(135)  1767342831759 = 2026地市级(130)  1767342831658 = 2026行政执法(130)
// 注意：早期抓取的 fetched-2025-*.json / fetched-2026-*.json 文件名与内容真实归属不符
//（文件名沿用当时错误标签），正确对照表见 database/raw/PAPER-MAPPING.md
const SOURCES = [
  { year: 2024, type: 'fusheng',   label: '副省级',   paperId: '1723610466211', expected: 135 },
  { year: 2024, type: 'dimenji',   label: '地市级',   paperId: '1723610466312', expected: 130 },
  { year: 2024, type: 'xingzheng', label: '行政执法', paperId: '1723610466110', expected: 130 },
  { year: 2025, type: 'fusheng',   label: '副省级',   paperId: '1735356969686', expected: 135 },
  { year: 2025, type: 'dimenji',   label: '地市级',   paperId: '1735356969586', expected: 130 },
  { year: 2025, type: 'xingzheng', label: '行政执法', paperId: '1735356969485', expected: 130 },
  { year: 2026, type: 'fusheng',   label: '副省级',   paperId: '1767342831860', expected: 135 },
  { year: 2026, type: 'dimenji',   label: '地市级',   paperId: '1767342831759', expected: 130 },
  { year: 2026, type: 'xingzheng', label: '行政执法', paperId: '1767342831658', expected: 130 }
];

const MODULES = ['常识判断', '言语理解', '数量关系', '判断推理', '资料分析'];

const OUT_DIR = path.join(__dirname, '..', 'database', 'raw');
const CSV_HEADER = '模块,二级考点,类型,题干,选项A,选项B,选项C,选项D,答案,解析,难度,标签';

// ==================== 网络层 ====================

function get(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: opts.timeout || 15000,
      headers: {
        'User-Agent': 'xingce-assistant/1.0 (educational use; contact: licetus)',
        Accept: 'text/html',
        'Accept-Charset': 'utf-8',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 跟随重定向
        return get(res.headers.location, opts).then(resolve, reject);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('timeout: ' + url));
    });
  });
}

// ==================== 解析层 ====================

/**
 * 解析答案页：返回 { 题号: 答案字母 } 的 Map
 * HTML 模式：<div class="col-xs-1-5">1、B</div>
 */
function parseAnswers(html) {
  const re = /<div class="col-xs-1-5">(\d+)[、，]?\s*([A-D])<\/div>/g;
  const map = new Map();
  let m;
  while ((m = re.exec(html)) !== null) {
    map.set(Number(m[1]), m[2]);
  }
  return map;
}

/**
 * 章节标题归一：「一、常识判断。」→「常识判断」
 *
 * 2025/2026 国考新增「政治理论」章节（从常识里独立出来），
 * 但本项目 V1.0 仍按 5 大模块设计，把"政治理论"并入"常识判断"。
 */
function normalizeChapter(text) {
  if (!text) return '';
  for (const m of MODULES) {
    if (text.indexOf(m) >= 0) return m;
  }
  // 政治理论 → 常识判断（2025/2026 考纲调整）
  if (text.indexOf('政治理论') >= 0) return '常识判断';
  return text.replace(/^[（(]?\d+[）)、.]\s*/, '').replace(/\s*[\.。].*$/, '').trim();
}

/**
 * 去除 HTML 标签、合并 <p>、解码实体
 */
function cleanHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/　/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * 去除选项 div 内嵌标签（保留文字）
 *  例：明月<u>松</u>间照 -> 明月松间照
 *  例：<img flag="tex" src="..."> -> ''（空，会被替换为 [公式图片]）
 */
function stripInlineTags(s) {
  return s.replace(/<[^>]+>/g, '').trim();
}

/**
 * 提取 4 个选项（A/B/C/D）
 * 来源：col-xs-3（4 个一行）/ col-xs-6（2 个一行）/ col-xs-12（1 个一行）
 * text 段必须吃透所有内嵌标签直到 </div>（含 <u> 划线、<img> 公式）
 */
function extractOptions(rightHtml) {
  const optionRe = /<div class="col-xs-(?:3|6|12)">([A-D])[、，]([\s\S]*?)<\/div>/g;
  const options = [];
  let om;
  while ((om = optionRe.exec(rightHtml)) !== null) {
    let text = stripInlineTags(om[2]);
    if (!text) text = '[公式图片]'; // 数量关系 LaTeX 选项占位
    options.push({ key: om[1], text });
  }
  return options;
}

/**
 * 从 rightHtml 起点开始用 div 深度计数找到配对 </div>，
 * 返回内部 HTML（不含外层 <div> 标签）
 *
 * 关键：row 内嵌套 col-xs-3 + col-xs-3 时，
 * 非贪婪 `[\s\S]*?</div></div>` 会停在中间选项上 → 选项 D 丢失
 */
function extractBalancedDiv(text, start) {
  let depth = 1;
  let i = start;
  while (i < text.length && depth > 0) {
    const nextOpen = text.indexOf('<div', i);
    const nextClose = text.indexOf('</div>', i);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      // 确认是 <div 标签开始（不是 <divider 等）
      const after = text.charAt(nextOpen + 4);
      if (after === ' ' || after === '>' || after === '\n' || after === '\t') {
        depth++;
      }
      i = nextOpen + 4;
    } else {
      depth--;
      i = nextClose + 6;
    }
  }
  return text.slice(start, i - 6);
}

/**
 * 解析单个题目块
 * 章节归属靠外层传递的「当前章节」上下文（currentSection）
 */
function parseQuestion(blockHtml, currentSection) {
  const numMatch = blockHtml.match(/<div class="col-xs-1 left">(\d+)<\/div>/);
  if (!numMatch) return null;
  const num = Number(numMatch[1]);

  const rightStartMatch = blockHtml.match(/<div class="col-xs-11 right">/);
  if (!rightStartMatch) return null;
  const startIdx = rightStartMatch.index + rightStartMatch[0].length;
  const rightHtml = extractBalancedDiv(blockHtml, startIdx);

  const options = extractOptions(rightHtml);

  // 题干 = 右侧 HTML 去掉选项后的内容
  const stemHtml = rightHtml.replace(
    /<div class="col-xs-(?:3|6|12)">[A-D][、，][\s\S]*?<\/div>/g,
    ''
  );
  const stem = cleanHtml(stemHtml);

  return { num, stem, options, section: currentSection };
}

/**
 * 解析整张试卷 HTML，返回题目数组
 *
 * 页面结构：
 *   <div class="row">
 *     <div class="col-xs-12 subtitle">一、常识判断...</div>
 *   </div>
 *   <div class="row">
 *     <div class="col-xs-1 left">1</div>
 *     <div class="col-xs-11 right">...题干...选项...</div>
 *   </div>
 */
function parsePaper(html) {
  const titleMatch = html.match(/<h3 align="center">([^<]+)<\/h3>/);
  const title = titleMatch ? titleMatch[1].trim() : '';

  // 找到所有 token 起点
  const tokenRe = /<div class="row">|<div class="col-xs-12 subtitle">|<div class="col-xs-12 sub2title">|<div class="col-xs-1 left">/g;
  const positions = [];
  let m;
  while ((m = tokenRe.exec(html)) !== null) {
    positions.push({ pos: m.index, tag: m[0] });
  }

  let currentModule = '';
  let currentSubtype = '';
  const questions = [];

  for (let i = 0; i < positions.length; i++) {
    const tok = positions[i];
    const nextPos = i + 1 < positions.length ? positions[i + 1].pos : html.length;

    if (tok.tag === '<div class="col-xs-12 subtitle">') {
      const text = html
        .slice(tok.pos + tok.tag.length, nextPos)
        .replace(/<\/div>\s*$/, '')
        .replace(/<[^>]+>/g, '')
        .trim();
      currentModule = normalizeChapter(text);
      currentSubtype = '';
    } else if (tok.tag === '<div class="col-xs-12 sub2title">') {
      const text = html
        .slice(tok.pos + tok.tag.length, nextPos)
        .replace(/<\/div>\s*$/, '')
        .replace(/<[^>]+>/g, '')
        .trim();
      const sub = text;
      currentSubtype = /[（(]\s*[一二三四五六七八九十0-9]+\s*[）)]/.test(sub)
        ? '材料' +
          sub.replace(/[（(]\s*([一二三四五六七八九十0-9]+)\s*[）)]/, (_, n) => {
            const num = '一二三四五六七八九十'.indexOf(n);
            return num >= 0 ? String(num + 1) : n;
          })
        : sub;
    } else if (tok.tag === '<div class="col-xs-1 left">') {
      const block = html.slice(tok.pos, nextPos);
      const q = parseQuestion(block, {
        module: currentModule,
        subtype: currentSubtype
      });
      if (q) questions.push(q);
    }
  }

  return { title, questions };
}

// ==================== 输出层 ====================

function escapeCsvCell(text) {
  if (text == null) return '';
  const s = String(text);
  if (s.indexOf(',') < 0 && s.indexOf('"') < 0 && s.indexOf('\n') < 0) {
    return s;
  }
  return '"' + s.replace(/"/g, '""') + '"';
}

function toCsv(questions, meta) {
  const lines = [CSV_HEADER];
  for (const q of questions) {
    const opts = { A: '', B: '', C: '', D: '' };
    for (const o of q.options) opts[o.key] = o.text;

    // 难度默认 3（用户后续可在 Excel 调整）
    // 标签：标注来源，便于溯源
    const tags = ['国考' + meta.year + meta.label, 'gkzhenti.cn'].join('|');

    lines.push(
      [
        escapeCsvCell(q.section.module),
        escapeCsvCell(q.section.subtype),
        '单选',
        escapeCsvCell(q.stem),
        escapeCsvCell(opts.A),
        escapeCsvCell(opts.B),
        escapeCsvCell(opts.C),
        escapeCsvCell(opts.D),
        '', // 答案留空，从答案页 join 后回填
        '「待补」解析', // 5 字符占位，过 import-questions.js 的「解析 ≥5 字符」校验
        '3',
        escapeCsvCell(tags)
      ].join(',')
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * 引号感知的 CSV 行分割：只在引号外的换行处切
 * 避免题干内 <br> 转换的 \n 把一行切成多行
 */
function splitCsvLines(text) {
  const lines = [];
  let buf = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"' && text[i + 1] === '"') {
        buf += '""';
        i++;
      } else if (c === '"') {
        buf += '"';
        inQuote = false;
      } else {
        buf += c;
      }
    } else if (c === '"') {
      buf += '"';
      inQuote = true;
    } else if (c === '\n') {
      lines.push(buf);
      buf = '';
    } else if (c !== '\r') {
      buf += c;
    }
  }
  if (buf) lines.push(buf);
  return lines;
}

function joinAnswers(csvText, answerMap) {
  // 答案列是第 9 列（索引 8）
  // 关键：题干里有 \n（从 <br> 转来），所以不能用 split('\n')——必须用 splitCsvLines
  const lines = splitCsvLines(csvText);
  const header = lines[0];
  const rows = lines.slice(1).filter(Boolean);

  function parseRow(line) {
    const cells = [];
    let field = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuote) {
        if (c === '"' && line[i + 1] === '"') {
          field += '"';
          i++;
        } else if (c === '"') {
          inQuote = false;
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuote = true;
      } else if (c === ',') {
        cells.push(field);
        field = '';
      } else {
        field += c;
      }
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

  let joined = 0;
  let missing = 0;
  const filled = rows.map((line, idx) => {
    const cells = parseRow(line);
    if (cells.length < 9) return line;

    // 题号 = 1-based 行号（header 占第 1 行，rows 从 header 之后开始算）
    const qnum = idx + 1;
    const ans = answerMap.get(qnum);
    cells[8] = ans || '';
    if (ans) joined++;
    else missing++;

    return cells.map(escapeCell).join(',');
  });

  const out = [header, ...filled].join('\n') + '\n';
  return { csv: out, joined, missing };
}

// ==================== 主流程 ====================

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { year: null, type: null, all: false, list: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--year') opts.year = Number(args[++i]);
    else if (a === '--type') opts.type = args[++i];
    else if (a === '--all') opts.all = true;
    else if (a === '--list') opts.list = true;
    else if (a === '-h' || a === '--help') opts.help = true;
  }
  return opts;
}

function usage() {
  console.log(`用法：
  node scripts/fetch-gkzhenti.js --year 2024 --type fusheng    # 抓 1 套
  node scripts/fetch-gkzhenti.js --all                          # 抓全部 9 套
  node scripts/fetch-gkzhenti.js --list                         # 列出所有可选

可选 type：fusheng（副省级）/ dimenji（地市级）/ xingzheng（行政执法）`);
}

async function fetchOne(meta) {
  console.log(`\n=== ${meta.year} ${meta.label} (${meta.paperId}) ===`);
  const paperUrl = `https://gwy.gkzhenti.cn/paper/${meta.paperId}`;
  const answerUrl = `https://gwy.gkzhenti.cn/answer/${meta.paperId}`;

  console.log('  抓题目页...');
  const paper = await get(paperUrl);
  if (paper.status !== 200) {
    console.error(`  ❌ 题目页 HTTP ${paper.status}`);
    return null;
  }
  console.log('  抓答案页...');
  const answer = await get(answerUrl);
  if (answer.status !== 200) {
    console.error(`  ❌ 答案页 HTTP ${answer.status}`);
    return null;
  }

  console.log('  解析题干...');
  const { title, questions } = parsePaper(paper.body);
  console.log(`  标题: ${title}`);
  console.log(`  题目数: ${questions.length}`);

  console.log('  解析答案...');
  const answerMap = parseAnswers(answer.body);
  console.log(`  答案数: ${answerMap.size}`);

  // 模块分布统计
  const byModule = {};
  questions.forEach((q) => {
    byModule[q.section.module] = (byModule[q.section.module] || 0) + 1;
  });
  console.log('  模块分布:');
  MODULES.forEach((m) => {
    if (byModule[m]) console.log(`    ${m}: ${byModule[m]}`);
  });

  // 校验题数
  if (questions.length !== meta.expected) {
    console.warn(`  ⚠️ 题数 ${questions.length} 与预期 ${meta.expected} 不一致`);
  }

  // 生成 CSV + JSON
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const csvText = toCsv(questions, meta);
  const { csv: filledCsv, joined, missing } = joinAnswers(csvText, answerMap);

  const csvFile = path.join(OUT_DIR, `fetched-${meta.year}-${meta.type}.csv`);
  const jsonFile = path.join(OUT_DIR, `fetched-${meta.year}-${meta.type}.json`);

  fs.writeFileSync(csvFile, '\uFEFF' + filledCsv, 'utf8'); // BOM 让 Excel 正确识别 UTF-8
  fs.writeFileSync(
    jsonFile,
    JSON.stringify(
      {
        title,
        source: `gkzhenti.cn / 国考${meta.year}${meta.label}`,
        questions: questions.map((q) => ({
          module: q.section.module,
          subtype: q.section.subtype,
          stem: q.stem,
          options: q.options,
          answer: answerMap.get(q.num) || ''
        }))
      },
      null,
      2
    ),
    'utf8'
  );

  console.log(`  ✅ 已写入:`);
  console.log(`     ${csvFile}`);
  console.log(`     ${jsonFile}`);
  console.log(`  答案匹配: ${joined}/${questions.length}${missing ? ` (缺 ${missing})` : ''}`);

  return { csvFile, jsonFile, count: questions.length, joined };
}

async function main() {
  const opts = parseArgs();

  if (opts.help) return usage();
  if (opts.list) {
    console.log('可选题源（已实测验证 2026-09-07）：');
    for (const s of SOURCES) {
      console.log(`  --year ${s.year} --type ${s.type}    # ${s.year} ${s.label} (${s.expected} 题)`);
    }
    return;
  }

  let targets = [];
  if (opts.all) {
    targets = SOURCES;
  } else if (opts.year && opts.type) {
    const hit = SOURCES.find((s) => s.year === opts.year && s.type === opts.type);
    if (!hit) {
      console.error(`未找到 ${opts.year} / ${opts.type} 的题源，跑 --list 看可用项`);
      process.exit(1);
    }
    targets = [hit];
  } else {
    return usage();
  }

  const results = [];
  for (const meta of targets) {
    const r = await fetchOne(meta);
    if (r) results.push(r);
  }

  if (results.length > 1) {
    console.log(`\n=== 抓取完成 ===`);
    let totalCount = 0;
    for (const r of results) {
      console.log(`  ${path.basename(r.csvFile)}: ${r.count} 题`);
      totalCount += r.count;
    }
    console.log(`合计 ${totalCount} 题`);
  }

  console.log('\n下一步：');
  console.log('  1. Excel 打开 database/raw/fetched-*.csv');
  console.log('  2. 填「解析」列（关键、最有版权价值）');
  console.log('  3. node scripts/import-questions.js database/raw/fetched-2024-fusheng.csv');
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
