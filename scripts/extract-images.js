/**
 * 提取源站题目图片 + 材料正文，匹配 qid
 *
 * 背景：fetch-gkzhenti.js 初版把 <img> 全部剥掉（选项空文本记 [公式图片] 占位），
 * 且 55 题资料分析材料正文缺失。源站图片 URL（upload.gkzhenti.cn）仍在，
 * 本脚本重抓 9 套卷页面，输出：
 *   database/raw/site-questions-2026-09-08.json
 *   [{ paperId, paperTitle, num, stem, stemImgs, options:[{key,text,imgs}],
 *      materialText, materialImgs }]
 *
 * 用法：node scripts/extract-images.js
 * 只读源站 + 落盘本地，不动线上库。
 */
const https = require('https');

const PAPERS = [
  { paperId: '1723610466211', year: 2024, label: '副省级' },
  { paperId: '1723610466110', year: 2024, label: '地市级' },
  { paperId: '1723610466312', year: 2024, label: '行政执法' },
  { paperId: '1735356969485', year: 2025, label: '副省级' },
  { paperId: '1735356969586', year: 2025, label: '地市级' },
  { paperId: '1735356969686', year: 2025, label: '行政执法' },
  { paperId: '1767342831759', year: 2026, label: '副省级' },
  { paperId: '1767342831658', year: 2026, label: '地市级' },
  { paperId: '1767342831860', year: 2026, label: '行政执法' }
];

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'xingce-assistant/1.0 (educational use; contact: licetus)' } }, (res) => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ': ' + url));
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      })
      .on('error', reject);
  });
}

function cleanHtml(s) {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
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

function extractImgs(html) {
  const urls = [];
  const re = /<img[^>]*src="([^"]+)"[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let u = m[1];
    if (u.indexOf('//upload.gkzhenti.cn/') === 0) u = 'https:' + u;
    if (u.indexOf('http') === 0 && u.indexOf('upload.gkzhenti.cn') !== -1) urls.push(u);
    // icon 等站点装饰图跳过
  }
  return urls;
}

function extractBalancedDiv(text, start) {
  let depth = 1;
  let i = start;
  while (i < text.length && depth > 0) {
    const nextOpen = text.indexOf('<div', i);
    const nextClose = text.indexOf('</div>', i);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      const after = text.charAt(nextOpen + 4);
      if (after === ' ' || after === '>' || after === '\n' || after === '\t') depth++;
      i = nextOpen + 4;
    } else {
      depth--;
      i = nextClose + 6;
    }
  }
  return text.slice(start, i - 6);
}

function extractOptions(rightHtml) {
  const optionRe = /<div class="col-xs-(?:3|6|12)">([A-D])[、，]([\s\S]*?)<\/div>/g;
  const options = [];
  let om;
  while ((om = optionRe.exec(rightHtml)) !== null) {
    options.push({
      key: om[1],
      text: cleanHtml(om[2]),
      imgs: extractImgs(om[2])
    });
  }
  return options;
}

function parsePaper(html) {
  const titleMatch = html.match(/<h3 align="center">([^<]+)<\/h3>/);
  const title = titleMatch ? titleMatch[1].trim() : '';

  // 材料：sub2title（如「（一）」）后紧跟的 col-xs-12 正文块
  const materialBlocks = []; // { endPos, text, imgs }
  const matRe = /<div class="col-xs-12 sub2title">[\s\S]*?<\/div><div class="col-xs-12">([\s\S]*?)<\/div>/g;
  let mm;
  while ((mm = matRe.exec(html)) !== null) {
    materialBlocks.push({
      endPos: mm.index + mm[0].length,
      text: cleanHtml(mm[1]),
      imgs: extractImgs(mm[1])
    });
  }

  const tokenRe = /<div class="row">|<div class="col-xs-12 subtitle">|<div class="col-xs-1 left">/g;
  const positions = [];
  let m;
  while ((m = tokenRe.exec(html)) !== null) positions.push({ pos: m.index, tag: m[0] });

  const questions = [];
  for (let i = 0; i < positions.length; i++) {
    const tok = positions[i];
    if (tok.tag !== '<div class="col-xs-1 left">') continue;
    const nextPos = i + 1 < positions.length ? positions[i + 1].pos : html.length;
    const block = html.slice(tok.pos, nextPos);

    const numMatch = block.match(/<div class="col-xs-1 left">(\d+)<\/div>/);
    const rightStartMatch = block.match(/<div class="col-xs-11 right">/);
    if (!numMatch || !rightStartMatch) continue;
    const startIdx = rightStartMatch.index + rightStartMatch[0].length;
    const rightHtml = extractBalancedDiv(block, startIdx);

    const options = extractOptions(rightHtml);
    const stemHtml = rightHtml.replace(
      /<div class="col-xs-(?:3|6|12)">[A-D][、，][\s\S]*?<\/div>/g,
      ''
    );

    // 找题号位置之前最近的材料块（材料属于其后的题目）
    let mat = null;
    for (const mb of materialBlocks) {
      if (mb.endPos <= tok.pos) mat = mb;
      else break;
    }

    questions.push({
      num: Number(numMatch[1]),
      stem: cleanHtml(stemHtml),
      stemImgs: extractImgs(stemHtml),
      options,
      materialText: mat ? mat.text : '',
      materialImgs: mat ? mat.imgs : []
    });
  }
  return { title, questions };
}

(async () => {
  const out = [];
  for (const p of PAPERS) {
    const url = 'https://gwy.gkzhenti.cn/paper/' + p.paperId;
    process.stdout.write('fetch ' + p.year + p.label + ' ... ');
    const html = await get(url);
    const parsed = parsePaper(html);
    console.log(parsed.questions.length + ' 题');
    out.push({ paperId: p.paperId, year: p.year, label: p.label, title: parsed.title, questions: parsed.questions });
  }
  require('fs').writeFileSync(
    __dirname + '/../database/raw/site-questions-2026-09-08.json',
    JSON.stringify(out, null, 1)
  );
  const totalQ = out.reduce((s, p) => s + p.questions.length, 0);
  const withImgs = out.reduce((s, p) => s + p.questions.filter((q) => q.stemImgs.length || q.options.some((o) => o.imgs.length) || q.materialImgs.length).length, 0);
  const withMat = out.reduce((s, p) => s + p.questions.filter((q) => q.materialText).length, 0);
  console.log('总计 ' + totalQ + ' 题，含图 ' + withImgs + ' 题，含材料 ' + withMat + ' 题');
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
