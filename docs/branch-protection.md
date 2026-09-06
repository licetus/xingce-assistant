# Branch Protection 配置指南

> 主分支保护规则，2026-09-07 建立。配套 `.github/workflows/ci.yml`（test job 三 Node 版本矩阵 + 可选 cloudbase-healthcheck）。

## 为什么需要

- 防止「代码没跑测试就合到 main」
- 防止「reviewer 没看过代码就 merge」
- 防止「commit 历史乱成 merge commit 套娃」
- 防止「强推覆盖别人代码」

## 入口

GitHub 仓库 → **Settings** → **Branches** → **Branch protection rules** → **Add rule** / 编辑现有 rule

直达链接：https://github.com/licetus/xingce-assistant/settings/branches

## 推荐配置（main 分支）

| 选项 | 值 | 原因 |
|---|---|---|
| **Branch name pattern** | `main` | 仅锁 main。develop 暂不锁（个人项目节奏快） |
| **Require a pull request before merging** | ✅ | 强制走 PR 流程 |
| └ Required approving reviews | **1** | 单人项目，1 个即可 |
| └ Dismiss stale pull request approvals when new commits are pushed | ✅ | 新 commit 进来老 approval 失效 |
| └ Require review from Code Owners | ❌ | 没设 CODEOWNERS |
| **Require status checks to pass before merging** | ✅ | test job 必须绿 |
| └ Require branches to be up to date before merging | ✅ | 分支不是 latest 就不让合 |
| └ **Required checks**（精确填这几个名） | 见下表 | 必须一字不差 |
| **Require conversation resolution before merging** | ✅ | 评论必须 resolved |
| **Require signed commits** | ❌ | 个人项目没必要，影响效率 |
| **Require linear history** | ✅ | 禁止 merge commit，强制 rebase / squash |
| **Allow force pushes** | ❌ | 永远禁止 |
| **Allow deletions** | ❌ | 永远禁止 |
| **Do not allow bypassing the above settings** | ✅ | 包括 admin |

### Required checks（精确名，复制粘贴）

```
npm test (Node 18)
npm test (Node 20)
npm test (Node 22)
```

> 这三个名字来自 `.github/workflows/ci.yml` 的 `test` job：
>
> ```yaml
> test:
>   name: npm test (Node ${{ matrix.node }})
> ```
>
> 三次矩阵展开后变成三个独立的 check。

**不要填**「云开发健康检查」——它是 `continue-on-error: true`，开发期空环境会 fail，不应挡 merge。

## develop 分支（可选）

本项目个人节奏快，**暂不锁**。等有协作者或对节奏满意后再补：

| 选项 | 值 |
|---|---|
| Branch name pattern | `develop` |
| Require a pull request | ❌（允许直 push，单人项目） |
| Require status checks | ✅ |
| └ Required checks | 同 main |
| Allow force pushes | ✅ maintainer only（实际就你自己） |

## 验证配置生效

配好后做一次端到端验证：

```bash
# 在 develop 上开 PR → main，故意改一个测试让它挂
git checkout -b feat/broken-test develop
# 在某个测试里加 .skip 或 throw
git commit -am "test: verify branch protection"
git push origin feat/broken-test
gh pr create --base main --title "verify branch protection"
# → PR 应显示「Merging is blocked」
# → CI 跑完，test job 红了
# → 试图 merge 应被拦
```

跑通后清掉这个分支。

## 备用：REST API 一键配

不想点 UI 时，把 PAT 给我，我用 `scripts/setup-branch-protection.sh` 一条 curl 配完。

PAT 需具备：
- **Fine-grained token**：`licetus/xingce-assistant` + `Administration` write
- **Classic token**：`repo` + `admin:org`（如果未来要管 org）

## 当前状态

- 仓库：https://github.com/licetus/xingce-assistant
- main 分支：未保护 ⚠️
- 最近 commit：8048ea2（fix(ci): 开发期空环境 healthcheck 自动豁免…）