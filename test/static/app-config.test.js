'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const MP = path.join(ROOT, 'miniprogram');

test('app.json：所有注册页面四件套齐全', () => {
  const app = JSON.parse(fs.readFileSync(path.join(MP, 'app.json'), 'utf8'));

  assert.ok(app.pages.length >= 5, '主包页面应不少于 5 个');
  app.pages.forEach((p) => {
    ['js', 'json', 'wxml', 'wxss'].forEach((ext) => {
      assert.ok(
        fs.existsSync(path.join(MP, p + '.' + ext)),
        `页面 ${p} 缺少 ${ext} 文件`
      );
    });
  });
});

test('app.json：tabBar 页面已注册且图标存在，选中色为 #0066CC', () => {
  const app = JSON.parse(fs.readFileSync(path.join(MP, 'app.json'), 'utf8'));
  const tabs = app.tabBar.list;

  assert.equal(tabs.length, 4);
  assert.equal(app.tabBar.selectedColor, '#0066CC', '主色应符合设计稿 #0066CC');

  tabs.forEach((t) => {
    assert.ok(app.pages.includes(t.pagePath), `tab 页 ${t.pagePath} 必须在 pages 注册`);
    ['iconPath', 'selectedIconPath'].forEach((k) => {
      assert.ok(fs.existsSync(path.join(MP, t[k])), `图标缺失: ${t[k]}`);
    });
  });
});

test('架构不变量：practice 不在 tabBar（navigateTo 跳转约束）', () => {
  const app = JSON.parse(fs.readFileSync(path.join(MP, 'app.json'), 'utf8'));
  const tabPages = app.tabBar.list.map((t) => t.pagePath);
  assert.ok(!tabPages.includes('pages/practice/practice'),
    'practice 一旦回到 tabBar，所有 navigateTo 跳转会静默失败');
});

test('架构不变量：tabBar 页面跳转只能用 switchTab', () => {
  const app = JSON.parse(fs.readFileSync(path.join(MP, 'app.json'), 'utf8'));
  const tabPages = app.tabBar.list.map((t) => t.pagePath);

  const files = walk(path.join(MP, 'pages'), '.js')
    .concat(walk(path.join(MP, 'pkg-rank'), '.js'));

  files.forEach((file) => {
    const src = fs.readFileSync(file, 'utf8');
    // 粗匹配 navigateTo/redirectTo 目标字符串
    const re = /(?:navigateTo|redirectTo)\s*\(\s*\{\s*url:\s*[`'"]([^`'"]+)/g;
    let m;
    while ((m = re.exec(src))) {
      const url = m[1].replace(/^\//, '');
      const target = url.split('?')[0];
      assert.ok(!tabPages.includes(target),
        `${file} 用 navigateTo/redirectTo 跳转 tabBar 页 ${target}，运行时会失败`);
    }
  });
});

test('分包：pkg-rank 注册与磁盘一致，独立分包配置正确', () => {
  const app = JSON.parse(fs.readFileSync(path.join(MP, 'app.json'), 'utf8'));
  const sub = (app.subpackages || app.subPackages || [])[0];
  assert.ok(sub, '应至少配置 pkg-rank 分包');
  assert.equal(sub.root, 'pkg-rank');
  sub.pages.forEach((p) => {
    ['js', 'json', 'wxml', 'wxss'].forEach((ext) => {
      assert.ok(fs.existsSync(path.join(MP, sub.root, p + '.' + ext)), `分包页面 ${p} 缺 ${ext}`);
    });
  });
});

test('全部 JS 语法可解析', () => {
  const { execSync } = require('node:child_process');
  const dirs = ['miniprogram', 'cloudfunctions', 'scripts', 'test'].join(' ');
  execSync(`find ${dirs} -name "*.js" -not -path "*/node_modules/*" -exec node --check {} +`, {
    cwd: ROOT,
    stdio: 'pipe'
  });
});

test('全部 JSON 可解析（database/import 除外——那是 JSON Lines，有专项测试）', () => {
  const files = walk(ROOT, '.json').filter(
    (f) => !f.includes('node_modules') && !f.startsWith(path.join(ROOT, 'database/import'))
  );
  assert.ok(files.length > 5, '应扫描到足够多的 JSON 文件');
  files.forEach((f) => {
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(f, 'utf8')), `JSON 解析失败: ${f}`);
  });
});

test('云函数 package.json：名称与 wx-server-sdk 依赖齐备', () => {
  const cfRoot = path.join(ROOT, 'cloudfunctions');
  fs.readdirSync(cfRoot).forEach((name) => {
    const pkgPath = path.join(cfRoot, name, 'package.json');
    assert.ok(fs.existsSync(pkgPath), `云函数 ${name} 缺 package.json`);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    assert.ok(pkg.dependencies && pkg.dependencies['wx-server-sdk'], `云函数 ${name} 缺 wx-server-sdk 依赖`);
  });
});

test('设计令牌：tokens.wxss 是唯一定义 --brand 的位置且主色正确', () => {
  const tokens = fs.readFileSync(path.join(MP, 'styles/tokens.wxss'), 'utf8');
  assert.ok(tokens.includes('--brand: #0066CC'), 'tokens.wxss 主色应为 #0066CC');

  // app.wxss 应 @import tokens 而不是自己定义取值
  const appWxss = fs.readFileSync(path.join(MP, 'app.wxss'), 'utf8');
  assert.ok(appWxss.includes("styles/tokens.wxss"), 'app.wxss 应 @import tokens.wxss');
  assert.ok(!/--brand:\s*#/.test(appWxss), 'app.wxss 不应重复定义 --brand 取值');
});

function walk(dir, ext, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, ext, acc);
    else if (p.endsWith(ext)) acc.push(p);
  }
  return acc;
}
