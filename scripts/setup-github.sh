#!/bin/bash
#
# GitHub 接入脚本 · 行测小助手
#
# 用法：
#   ./scripts/setup-github.sh https://github.com/<用户名>/<仓库名>.git
#   ./scripts/setup-github.sh git@github.com:<用户名>/<仓库名>.git
#
# 前置条件：
#   1. 已在 GitHub 网页创建**空**仓库（不要勾 README / .gitignore / LICENSE，
#      否则会和本地仓库历史冲突，推送会被拒）
#   2. 已配置好 GitHub 认证
#
# 关于认证（重要）：
#   GitHub 从 2021-08 起**停用账号密码认证**，用 HTTPS 地址 push 会报：
#     remote: Invalid username or token.
#     Password authentication is not supported for Git operations.
#
#   因此本脚本会把传入的 HTTPS 地址自动转成 SSH（git@github.com:...）。
#   如果本地还没有 SSH 密钥，脚本会提示生成方法并退出，不会让你白跑一趟。
#
# 这个脚本只做四件事：转 SSH 地址 → 检查认证 → 推 main → 推 develop。
# 不会删东西、不会强推、不会改历史，可以放心执行。

set -e

REPO_URL="$1"

# ---------- 参数校验 ----------
if [ -z "$REPO_URL" ]; then
  echo "❌ 缺少仓库地址"
  echo ""
  echo "用法：./scripts/setup-github.sh https://github.com/<用户名>/<仓库名>.git"
  echo ""
  echo "先在 GitHub 网页创建空仓库，然后把地址传进来。"
  exit 1
fi

# ---------- HTTPS 自动转 SSH ----------
# GitHub 已停用密码认证，HTTPS 地址会直接认证失败，统一转成 SSH
if [[ "$REPO_URL" == https://github.com/* ]]; then
  # 纯字符串处理，不用 sed：BSD sed 不支持 +? 这类惰性匹配，macOS 上会报 RE error
  REPO_PATH="${REPO_URL#https://github.com/}"
  REPO_PATH="${REPO_PATH%/}"
  [[ "$REPO_PATH" == *.git ]] || REPO_PATH="$REPO_PATH.git"
  SSH_URL="git@github.com:$REPO_PATH"

  if [[ "$SSH_URL" == git@github.com:*.git ]]; then
    echo "ℹ️  HTTPS 地址已自动转为 SSH（GitHub 不支持密码认证）"
    echo "   $REPO_URL"
    echo "   → $SSH_URL"
    echo ""
    REPO_URL="$SSH_URL"
  fi
fi

# ---------- 认证前置检查 ----------
# 用 SSH 地址却没配密钥，会在 push 时才报错，白等一轮；提前卡住更省时间
if [[ "$REPO_URL" == git@* ]]; then
  if ! ls ~/.ssh/*.pub >/dev/null 2>&1; then
    echo "❌ 未找到 SSH 公钥，无法使用 SSH 推送"
    echo ""
    echo "生成密钥：ssh-keygen -t ed25519 -C \"你的邮箱\" -f ~/.ssh/id_ed25519"
    echo "然后把公钥内容加到 GitHub：https://github.com/settings/keys"
    echo "  查看公钥：cat ~/.ssh/id_ed25519.pub"
    echo ""
    echo "或者改用 HTTPS + Personal Access Token："
    echo "  https://github.com/settings/tokens"
    exit 1
  fi

  # 连通性检查：能拿到 GitHub 的响应就说明网络和密钥通道正常
  SSH_TEST=$(ssh -T -o BatchMode=yes -o ConnectTimeout=10 git@github.com 2>&1 || true)
  if echo "$SSH_TEST" | grep -q "Permission denied (publickey)"; then
    echo "❌ SSH 密钥未注册到 GitHub（或没有权限访问该仓库）"
    echo ""
    echo "请确认已把下面这个公钥加到 GitHub → Settings → SSH and GPG keys："
    echo ""
    for k in ~/.ssh/*.pub; do
      echo "  $k"
      echo "  $(cat "$k")"
    done
    echo ""
    echo "加完再执行一次本脚本。"
    exit 1
  fi
fi

echo "=========================================="
echo " 行测小助手 · GitHub 接入"
echo "=========================================="
echo ""
echo "目标仓库：$REPO_URL"
echo ""

# ---------- 工作区检查 ----------
if [ -n "$(git status --porcelain)" ]; then
  echo "⚠️  工作区有未提交的改动："
  git status --short
  echo ""
  read -p "是否要先提交这些改动？(y/N) " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    read -p "请输入提交信息: " COMMIT_MSG
    git add -A
    git commit -m "${COMMIT_MSG:-chore: 提交未保存的改动}"
    echo "✅ 已提交"
  else
    echo "❌ 请先处理未提交的改动再执行本脚本"
    exit 1
  fi
fi

# ---------- 配置远端 ----------
if git remote get-url origin >/dev/null 2>&1; then
  CURRENT=$(git remote get-url origin)
  echo "⚠️  已存在远端 origin：$CURRENT"
  read -p "是否替换为新地址？(y/N) " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    git remote set-url origin "$REPO_URL"
    echo "✅ 远端已更新"
  else
    echo "保持原远端不动，直接推送"
  fi
else
  git remote add origin "$REPO_URL"
  echo "✅ 远端已添加"
fi

# ---------- 推送 main ----------
echo ""
echo "→ 推送 main 分支..."
git push -u origin main

# ---------- 推送 develop ----------
echo ""
echo "→ 推送 develop 分支..."
git push -u origin develop

# ---------- 确保留在 develop ----------
git checkout develop >/dev/null 2>&1

echo ""
echo "=========================================="
echo " ✅ 推送完成"
echo "=========================================="
echo ""
echo "当前分支：$(git rev-parse --abbrev-ref HEAD)"
echo "远端地址：$(git remote get-url origin)"
echo ""
echo "------------------------------------------"
echo " 接下来在 GitHub 网页做两件事（脚本做不了）："
echo "------------------------------------------"
echo ""
echo " 1. 设置默认分支为 develop"
echo "    Settings → General → Default branch → 切到 develop"
echo "    （日常开发在 develop，main 只放线上版本）"
echo ""
echo " 2. 保护 main 分支"
echo "    Settings → Branches → Add branch ruleset"
echo "    - Branch name pattern: main"
echo "    - 勾选 Require a pull request before merging"
echo "    - 勾选 Require status checks to pass（配 CI 后再开）"
echo "    - 取消 Include administrators 的绕过（避免误操作直推）"
echo ""
echo " 3. 邀请协作者"
echo "    Settings → Collaborators → Add people"
echo ""
echo "------------------------------------------"
echo " 提醒："
echo "------------------------------------------"
echo ""
echo " 本仓库是 Public，请确认："
echo "  - 未提交真实 AppID / 云环境 ID（应放在 miniprogram/config.js，已 gitignore）"
echo "  - 未提交题库正文（题库通过 scripts/import-questions.js 导入，不入库）"
echo "  - sample-questions.csv 里是示例题，非真实真题"
echo ""
