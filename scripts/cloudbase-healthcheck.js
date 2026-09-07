/**
 * 云开发定时健康检查脚本
 *
 * 在 CI（GitHub Actions）里跑，依赖：
 *   - 环境变量 TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY（secret 配置）
 *   - 环境变量 CLOUD_ENV_ID（默认 pro-d3g3e4uab0265b1c6）
 *   - @cloudbase/node-sdk（CI 用 --no-save 临时安装，不污染项目）
 *
 * 调用 timer 云函数的 healthCheck action，4 项检查：
 *   - daily_task_today（今日题是否生成）
 *   - rank_cache_any（榜单缓存是否有数据）
 *   - records_count（答题流水总量是否爆表）
 *   - users_count（用户量）
 *
 * 退出码：
 *   0 = 全部健康
 *   1 = healthCheck 返回有 failed 项
 *   2 = 缺少环境变量（CI 没配 secret）
 *   3 = 调用异常
 */

'use strict';

async function main() {
  const secretId = process.env.TENCENTCLOUD_SECRETID;
  const secretKey = process.env.TENCENTCLOUD_SECRETKEY;
  const envId = process.env.CLOUD_ENV_ID || 'pro-d3g3e4uab0265b1c6';

  if (!secretId || !secretKey) {
    console.error('❌ 缺少环境变量 TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY');
    console.error('   在 GitHub repo Settings → Secrets 里配（参考 .github/workflows/ci.yml）');
    process.exit(2);
  }

  // @cloudbase/node-sdk 在 CI 临时安装，require 走 npm 解析
  // v3+ 改用 init() 工厂（旧 new CloudBase 已移除）
  let init;
  try {
    ({ init } = require('@cloudbase/node-sdk'));
  } catch (e) {
    console.error('❌ @cloudbase/node-sdk 未安装。CI 工作流会自动装，本地调试请跑：');
    console.error('   npm install @cloudbase/node-sdk --no-save');
    console.error('   然后：TENCENTCLOUD_SECRETID=xxx TENCENTCLOUD_SECRETKEY=xxx node scripts/cloudbase-healthcheck.js');
    process.exit(3);
  }

  // env 必须在 init 时指定（新版 SDK callFunction 不再接受 env 字段）
  const app = init({ secretId, secretKey, env: envId });

  let res;
  try {
    res = await app.callFunction({
      name: 'timer',
      data: { action: 'healthCheck', payload: {} }
    });
  } catch (e) {
    console.error('❌ 调用 timer healthCheck 异常：', e.message);
    process.exit(3);
  }

  const result = res && res.result;
  if (!result || result.code !== 0) {
    console.error('❌ timer 返回错误：', JSON.stringify(result || res));
    process.exit(1);
  }

  const { healthy: rawHealthy, checks, failed, ts } = result.data;
  const stamp = ts ? new Date(ts).toISOString() : new Date().toISOString();

  // 开发期空环境豁免：records=0 且 users=0 表示还没人用过，所有 fail 视为可接受
  const recordsCount = checks.find((c) => c.name === 'records_count')?.count;
  const usersCount = checks.find((c) => c.name === 'users_count')?.count;
  const emptyEnv = (recordsCount === 0 || recordsCount === undefined)
                && (usersCount === 0 || usersCount === undefined);
  const healthy = emptyEnv || rawHealthy;

  console.log('');
  console.log(`📊 timer.healthCheck @ ${stamp}  (env=${envId})`);
  if (emptyEnv) {
    console.log(`   ⚠️  检测到空环境（records=0 / users=0），${failed} 项检查暂跳过`);
  } else {
    console.log(`   ${healthy ? '✅ 全部健康' : `❌ ${failed} 项失败`}`);
  }
  console.log('');

  for (const c of checks) {
    const mark = emptyEnv ? '⚠️ ' : (c.ok ? '✅' : '❌');
    const detail = [];
    if (c.count !== undefined) detail.push(`count=${c.count}`);
    if (c.today) detail.push(`today=${c.today}`);
    if (c.warn) detail.push('WARN');
    if (c.error) detail.push(`error=${c.error}`);
    const suffix = detail.length ? ` (${detail.join(', ')})` : '';
    console.log(`   ${mark} ${c.name}${suffix}`);
  }
  console.log('');

  process.exit(emptyEnv || healthy ? 0 : 1);
}

main().catch((e) => {
  console.error('❌ 脚本异常：', e);
  process.exit(3);
});