#!/bin/bash
#
# 部署云函数到微信云开发
#
# 用法：
#   export CLOUD_ENV_ID=你的环境ID
#   ./scripts/deploy-functions.sh              # 部署全部云函数
#   ./scripts/deploy-functions.sh answer       # 只部署 answer
#   ./scripts/deploy-functions.sh --dry-run    # 预览变更不实际部署
#
# 首次使用需要安装 CLI 并登录：
#   npm i -g @cloudbase/cli
#   tcb login
#
# 为什么用环境变量传环境 ID：
#   cloudbaserc.json 会进 Git，真实环境 ID 不该写进去。
#   用 --env-id 参数在命令行覆盖，配置和敏感值就分离了。

set -e

cd "$(dirname "$0")/.."

# ---------- 环境 ID ----------
if [ -z "$CLOUD_ENV_ID" ]; then
  echo "❌ 未设置 CLOUD_ENV_ID"
  echo ""
  echo "用法："
  echo "  export CLOUD_ENV_ID=你的环境ID"
  echo "  ./scripts/deploy-functions.sh"
  echo ""
  echo "环境 ID 在云开发控制台 → 设置 → 环境 ID 查看"
  echo "（也可以从 miniprogram/config.js 里复制）"
  exit 1
fi

# ---------- CLI 检查 ----------
if ! command -v tcb >/dev/null 2>&1; then
  echo "❌ 未安装 CloudBase CLI"
  echo ""
  echo "安装：npm i -g @cloudbase/cli"
  echo "登录：tcb login"
  exit 1
fi

# ---------- 前置检查 ----------
echo "=========================================="
echo " 部署云函数 → $CLOUD_ENV_ID"
echo "=========================================="
echo ""

# 语法检查：避免把有语法错误的函数传上去，浪费一次部署
echo "→ 检查云函数语法..."
for f in cloudfunctions/*/index.js; do
  node --check "$f" || { echo "❌ 语法错误：$f"; exit 1; }
done
echo "✅ 语法检查通过（$(ls -1 cloudfunctions/*/index.js | wc -l | tr -d ' ') 个函数）"
echo ""

# ---------- 部署 ----------
if [ "$1" = "--dry-run" ]; then
  echo "→ 预览变更（不实际部署）..."
  tcb fn deploy --all --env-id "$CLOUD_ENV_ID" --dry-run
else
  if [ -n "$1" ]; then
    echo "→ 部署单个函数：$1"
    tcb fn deploy "$1" --env-id "$CLOUD_ENV_ID"
  else
    echo "→ 部署全部云函数..."
    tcb fn deploy --all --env-id "$CLOUD_ENV_ID"
  fi
fi

echo ""
echo "=========================================="
echo " ✅ 完成"
echo "=========================================="
echo ""
echo "查看已部署的函数："
echo "  tcb fn list --env-id $CLOUD_ENV_ID"
echo ""
echo "查看日志："
echo "  tcb fn log <函数名> --env-id $CLOUD_ENV_ID"
echo ""
echo "------------------------------------------"
echo " 灰度发布（改核心逻辑如判题时建议走这一步）："
echo "------------------------------------------"
echo ""
echo " 1. 控制台 → 云函数 → 选中函数 → 灰度配置 → 发布新版本"
echo " 2. 把新版本流量设为 100%，\$LATEST 设为 0%"
echo " 3. 部署新代码（改动的是 \$LATEST）"
echo " 4. \$LATEST 设 10%，观察日志；没问题再逐步加到 100%"
echo ""
echo " 注意：流量只能在两个版本之间分配，总和必须 100%"
echo "       带 openid 的请求会固定路由到同一版本，体验一致"
echo ""
