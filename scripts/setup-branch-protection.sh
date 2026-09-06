#!/usr/bin/env bash
# 一键配 licetus/xingce-assistant 的 branch protection
# 用法：GITHUB_TOKEN=ghp_xxx ./scripts/setup-branch-protection.sh [main|develop|both]
#
# Token 要求：
#   - Fine-grained: licetus/xingce-assistant 仓库 + Administration: write
#   - Classic: repo + admin:org（如果要管 org）
#
# 不带参数 = both（同时配 main 和 develop）

set -euo pipefail

REPO="licetus/xingce-assistant"
BRANCH="${1:-both}"

# main 必填的 3 个 check 名（来自 .github/workflows/ci.yml 的 test job 矩阵展开）
MAIN_CHECKS=(
  "npm test (Node 18)"
  "npm test (Node 20)"
  "npm test (Node 22)"
)

# develop 额外触发 healthcheck，但 healthcheck 是 continue-on-error，
# 不应作为 merge 硬性条件，所以跟 main 用同一组
DEVELOP_CHECKS=("${MAIN_CHECKS[@]}")

# ---------- Payload 工厂 ----------
build_payload() {
  local checks_json="$1"
  cat <<EOF
{
  "required_status_checks": {
    "strict": true,
    "contexts": ${checks_json}
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 1
  },
  "required_conversation_resolution": true,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "restrictions": null,
  "block_creations": false,
  "lock_branch": false,
  "allow_fork_syncing": false
}
EOF
}

# ---------- 校验 ----------
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "❌ GITHUB_TOKEN 未设置" >&2
  echo "   export GITHUB_TOKEN=ghp_xxx" >&2
  echo "   或 Fine-grained PAT (licetus/xingce-assistant, Administration: write)" >&2
  exit 1
fi

# GitHub Actions 的 GITHUB_TOKEN 是临时 token，不能调 /protection
# 必须是用户 PAT（ghp_* 或 github_pat_*）
if [[ "${GITHUB_TOKEN}" =~ ^ghs_ ]]; then
  echo "❌ 检测到 GITHUB_SERVER_TOKEN (ghs_)，不是用户 PAT" >&2
  echo "   GitHub Actions 临时 token 没有 /protection 权限" >&2
  echo "   请用 Personal Access Token" >&2
  exit 1
fi

# ---------- 执行 ----------
apply_to_branch() {
  local branch="$1"
  local checks_json="$2"
  local payload
  payload="$(build_payload "$checks_json")"

  echo "⏳ 配 ${branch} ..."
  http_code=$(curl -sS -o /tmp/branch-prot-resp.json -w "%{http_code}" \
    -X PUT \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -H "Content-Type: application/json" \
    "https://api.github.com/repos/${REPO}/branches/${branch}/protection" \
    -d "$payload")

  if [[ "$http_code" == "200" ]]; then
    echo "✅ ${branch} 配成功"
  else
    echo "❌ ${branch} 失败 (HTTP ${http_code})" >&2
    cat /tmp/branch-prot-resp.json >&2
    echo >&2
    exit 1
  fi
}

# 数组 → JSON 字符串
to_json_array() {
  local first=1
  printf '['
  for c in "$@"; do
    if [[ $first -eq 0 ]]; then printf ','; fi
    printf '"%s"' "$c"
    first=0
  done
  printf ']'
}

main_checks_json="$(to_json_array "${MAIN_CHECKS[@]}")"
develop_checks_json="$(to_json_array "${DEVELOP_CHECKS[@]}")"

case "$BRANCH" in
  main)     apply_to_branch main     "$main_checks_json" ;;
  develop)  apply_to_branch develop  "$develop_checks_json" ;;
  both)
    apply_to_branch main    "$main_checks_json"
    apply_to_branch develop "$develop_checks_json"
    ;;
  *)
    echo "❌ 用法: $0 [main|develop|both]" >&2
    exit 1
    ;;
esac

echo ""
echo "🎉 全部完成。验证入口："
echo "   https://github.com/${REPO}/settings/branches"