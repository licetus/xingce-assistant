/**
 * 本地环境配置模板
 *
 * 用法：复制此文件为 config.js，填入你们真实的配置值。
 *
 *     cp miniprogram/config.example.js miniprogram/config.js
 *
 * 为什么要分离：
 *   config.js 已在 .gitignore 中，不会进仓库。这样即使仓库是公开的，
 *   真实的云环境 ID 也不会泄露；同时团队里每个人可以指向不同的环境
 *   （开发 / 测试 / 生产互不干扰）。
 *
 * 未创建 config.js 时，app.js 会回退读取本模板的占位值并在控制台告警，
 * 保证克隆下来就能打开，不会白屏崩溃。
 */
module.exports = {
  /** 云开发环境 ID，微信云开发控制台 → 设置 → 环境 ID */
  cloudEnv: 'xingce-prod-0gXXXXXXXX'
};
