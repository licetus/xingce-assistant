# 行测小助手 · 项目长期记忆

## 项目定位

微信小程序，行测（行政职业能力测验）刷题工具。目标：快速上线 + 获取用户。
行测五大模块：常识判断、言语理解、数量关系、判断推理、资料分析。

**本地目录**：`~/WorkBuddy/xingce-assistant`（2026-08-31 由「行测小助手」改名，与 GitHub 仓库名对齐）
**代码基线**：2026-09-05 已从 `~/WorkBuddy/xingce-assistant_副本` **复制**回工作区
（10 提交、develop+main 双分支、103 跟踪文件、`git fsck` 无错误）。
副本**保留未删**仅作备份。**后续一律在工作区开发，不要再动副本。**

**测试体系**（2026-09-06 建立）：`npm test` 跑 `test/` 下 134 用例（零依赖 node:test），
覆盖 11 个云函数 + 前端 utils/services + 集成旅程 + 静态检查。
关键资产：`test/helpers/mock-sdk.js`（wx-server-sdk 内存模拟层，**忠实还原平台约束**：
事务仅支持 collection.doc/add，事务内 where 必抛错——这是平台真实行为，勿「修掉」）。
**提交前必须跑 `npm test`。** 云函数数量现在是 **11 个**（新增 user），建库集合 **11 个**（含 rank_cache）。

**GitHub**：`git@github.com:licetus/xingce-assistant.git`（**2026-09-06 20:35 推送成功**，4 commit 上 develop，
20:55 main 同步到 develop 同 commit `6bc6b63`；SSH 公钥指纹 `SHA256:beTGzPDSTO6XGnsilrr63ouV2FU2KpsHwftvU5sc4Bg`）
> 复制 `.git` 目录后若报「Another git process seems to be running」，
> 是副本里陈旧的 `.git/index.lock` 被一并复制过来了。查时间戳确认是旧锁后 `rm -f` 即可。

## 项目统一标识：`xingce-assistant@licetus`（用户明确要求）

**本项目内所有需要标识的地方统一用 `xingce-assistant@licetus`**，
不要用 `dev@example.com` 之类的通用占位符。

已应用：

| 位置 | 值 |
|---|---|
| SSH 密钥注释 | `xingce-assistant@licetus` |
| Git 作者（仓库级 config） | `xingce-assistant <xingce-assistant@licetus>` |

注意：Git 身份只改了**仓库级** config（`git config` 不带 `--global`），不影响其他项目。
历史 10 个提交的作者仍是 `xingce-dev <dev@example.com>`，未改写（需要用户确认，见下）。

## 已确认的技术选型（不要重复询问）

- **原生小程序 + 微信云开发**（用户明确否掉了 Taro/uni-app）
- **零 npm 运行时依赖**进主包 —— 主包体积全部留给业务代码，UI 组件全部手写
- 基础库最低 2.25.0，目标主包 < 1.2MB（当前实测 288KB）
- 主体：企业/个体工商户（可开微信支付）
- 题库：自有自研，用户提供数据
- **云开发必须标准版**（架构要求）：个人版云函数超时锁死 3s、内存锁死 256MB，
  判题事务必然超时。**2026-09-06 实际切换到个人版**（用户接受限制并要"仅切代码"），
  answer 单次提交要限制到 10 题内，1 个月内（2026-10-06 之前）升标准版
- **设计令牌用现有变量名**（`--brand` / `--text-1` / `--line` 等），唯一取值来源是
  `miniprogram/styles/tokens.wxss`。**不要改用设计稿的 `--color-primary` 命名法**——
  全量改名要动每个页面却零收益。主色 `#0066CC`。

## V1.0 范围（已锁定）

专项刷题+即时解析、错题本+收藏、每日打卡+排行榜。
**限时模考明确不进 V1**，分包位 `pkg-exam` 已预留。

## 不可违背的架构约束

1. **判题全在云端**，下发的题目不含 `answer` 字段
2. **所有数据库集合安全规则 = 仅管理端可读写**，客户端一律走云函数
3. **所有云调用必须经 `utils/cloud.js`**，禁止页面/组件直接 callFunction 或 database
4. 东八区计算日期（打卡、榜单），不能用 UTC
5. 头像昵称用 `open-type="chooseAvatar"` + `input type="nickname"`，`wx.getUserProfile` 已废弃
6. **tabBar 页面只能用 `switchTab` 跳转**，`navigateTo` 跳 tabBar 页会直接失败。
   2026-09-05 就栽在这里：practice 原是 tabBar 页却被 navigateTo 跳，
   导致首页刷题/打卡/错题重做/单题练习四条主链路全断。
   **现在 practice 已移出 tabBar，跳转方式一律用 navigateTo**
7. **云开发数据库导入的 JSON 必须是 JSON Lines**（每行一个对象、换行分隔），
   **不是**标准数组、不能缩进美化，否则控制台报「格式错误」。
   `scripts/import-questions.js` 已按此输出，`database/import/config.json` 同理
8. 小程序**不能打包字体文件**（中文字体 1~3MB 吃光主包），走系统字体栈；
   数字加 `.tnum`（`font-variant-numeric: tabular-nums`）防计时器抖动
9. **云开发事务只支持单文档操作**（collection.doc / collection.add），
   事务内 where 查询与 where().update() 批量更新都会抛错（官方文档明确）。
   2026-09-06 的 answer 云函数就栽在这里：事务内 where().update() 更新用户统计，
   线上每次提交必报「成绩保存失败」。正确姿势：事务外预查档案拿 _id，事务内 doc().update()
10. `.catch(() => null)` 静默失败会让「整个云函数缺失」级别的大洞存活（user 云函数
    曾整体缺失但三处页面静默调用）——services 引用的云函数名必须有对应目录，靠测试守住
11. **聚合累加器在 `db.command.aggregate` 命名空间**（`$.sum`），不在 `db.command`。
    2026-09-06 部署冒烟时 rank 栽在这里（`_.sum is not a function`，榜单全挂）；
    mock 层同步改为真实结构后本地可暴露此类误用

## 云环境与部署状态（2026-09-06 标准版·资源点计费）

- **当前 EnvId**：`pro-d3g3e4uab0265b1c6`（上海，**标准版 `baas_pf_standard`**，
  资源点付费模式，199 元/月，月赠 330,000 点 ≈ 330 元）
- 别名 `datizhushou`（与旧环境同名，控制台请改为 `datizhushou-trial` 区分）
- 升级轨迹：14:50 个人版 → 15:24 标准版（**EnvId 不变**，TCB 升级不换 ID）
- 已就位：11 函数 / 11 集合 / 11 ADMINONLY / **4 个 timer 触发器**（升级后配额恢复）
  - dailyTask `0 5 0 * * * *` 每日 00:05
  - rebuildRank `0 10 * * * * *` 每小时 10 分
  - archive `0 30 3 * * * *` 每日 03:30
  - healthCheck `0 10 9 * * * *` 每日 09:10（写 events 集合告警）
- 已就位：**19 条业务复合索引**（drop 默认 `_openid_1` 后建 `openid_unique`，含 qgroups/users/rank_cache
  的 5 条单字段唯一索引 + 14 条复合键）— 经 MCP 直传数组 OK
- 标准版配额解封：timeout **900s**（个人版 3s 锁死）/ 内存可调 / 调用 800 万次/月 / 容量 100GB / CLS 3 天
- 11 函数当前 Timeout 配置：login 10s / question 20s / answer 20s / checkin 15s / wrongbook 15s /
  favorite 10s / rank 20s / share 20s / track 10s / timer 20s / user 10s
- 资源点扣费顺序：套餐配额 > 资源包 > 按量使用；超出 330,000 点/月开启超限不停服
- 历史环境：`datizhushou-d7gmes5l22e316f09`（体验版）2026-09-06 15:19 自动停服 ISOLATE，资源保留
- **关键发现**：MCP `manageFunctions createFunctionTrigger` 用**7 段 cron**（秒 分 时 日 月 星期 年），
  5 段会报"必须使用 7 段格式"；`0 10 * * * * *` = 每小时 10 分 ✅，`0 10 * * *` ❌
- `miniprogram/config.js`、`cloudbaserc.json` EnvId 已对齐
- 详见 `docs/云开发运维手册.md` §1.2（标准版配额速查）
- 详见 `docs/环境迁移操作手册.md`（升级历史）

## 版本管理体系（已建立，勿重复搭建）

**分支**：`main`（线上，受保护）+ `develop`（体验版）+ `feature/*` + `hotfix/*`。
hotfix 必须**同时合回 main 和 develop**。当前在 `develop`。

**三套版本体系，务必分清**：

| 体系 | 载体 | 生效 | 需审核 |
|---|---|---|---|
| 代码版本 | Git / tag | 即时 | 否 |
| 平台版本 | 微信后台 | 1~7 工作日 | **是** |
| 业务版本 | config 集合 + 云函数 | **即时** | **否** |

**小程序代码包没有热更新** —— 改一个字都要重新提审。
凡是能用 config 或云函数解决的，绝不写死在小程序代码里。

**云函数是变相热更**：改完重新部署，几分钟生效，不用提审。
代价是必须向前兼容：接口**只加字段不删字段**，废弃字段保留 2 个版本周期。

**强制更新**通过 `config.min_version` / `latest_version` 控制，见 `utils/update.js`。
注意：只在 `envVersion === 'release'` 校验，否则开发版会被自己的弹窗挡死。

## 部署与监控机制（关键经验）

- **MCP 部署云函数必须用 `updateFunctionCode` 不是 `createFunction force=true`**：
  - 后者会**清空所有已有触发器**（2026-09-06 升级部署验证过，会让 dailyTask/rebuildRank/archive 全丢）
  - 增量更新必须传 `functionRootPath` 指向 cloudfunctions/ 目录
- **`updateFunctionCode force=false` 会静默跳过**：如果代码哈希没变就不真部署（2026-09-06 healthCheck
  测试时第一次部署失败就是这个原因）。**永远用 force=true**
- **MCP `invokeFunction` 是 AI 调试神器**：能直接调云函数，传 `{action, payload}`，
  系统会自动注入 OPENID。timer.healthCheck 验证就是用这个
- **timer cron 必须 7 段**（秒 分 时 日 月 星期 年）：5 段报"必须使用 7 段格式"
- **TCB 升级不换 EnvId**：个人版→标准版升级后 EnvId 不变，本地配置零改动
- **CLS 主动开**：个人版/标准版新环境自动开通 CLS（logset+topic 都有），无需手动
- **GitHub Actions 已建立**（`.github/workflows/ci.yml`，2026-09-06 离线校验通过）：
  - `test` job：Node 18/20/22 矩阵跑 `npm test`（134 用例全绿），push + PR 触发
  - `cloudbase-healthcheck` job：仅 develop push 触发，调用 `scripts/cloudbase-healthcheck.js`
  - **离线校验清单**：✓ JS 语法 / ✓ YAML 解析 / ✓ npm test / ✓ exit code 分支
  - 启用 healthcheck 需配 2 个 GitHub Secret：`TENCENTCLOUD_SECRETID` / `TENCENTCLOUD_SECRETKEY`
- **timer 健康监控（healthCheck）**：
  - `cloudfunctions/timer/index.js` 加了 `healthCheck` action
  - 触发器 cron `0 10 9 * * * *`（每天 09:10，晚于 dailyTask 00:05 留 9 小时容错窗口）
  - 检查 4 项：daily_task_today / rank_cache_any / records_count / users_count
  - 异常时自动写 `events` 集合（type=health_alert），可在 CloudBase 控制台或 CLS 日志查看

## 待办

**用户待办**
- ~~填云环境 ID~~ ✅ 2026-09-06 完成（config.js + cloudbaserc.json）
- ~~建库：11 集合 + 权限 + 19 索引 + 导入数据~~ ✅ 2026-09-06 经 MCP 完成
- ~~云开发环境切换：体验版 → 个人版 → 标准版~~ ✅ 2026-09-06 全程完成（3 个版本）
- ~~注册 GitHub SSH 公钥并推送 main/develop~~ ✅ 2026-09-06 20:35 完成
- ⚠️ **旧体验版 alias 改名**：控制在台手动 `datizhushou` → `datizhushou-trial`
  （MCP `manageEnv` 不支持改 alias，必须走控制台）
- ⚠️ **配置 GitHub Secret**：TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY（让 healthcheck job 工作）
- ⚠️ **配置 branch protection**：test job 通过才能 merge 到 main（推荐）
- 导入正式题库（当前云端仅 6 道样例题，正式题库用
  `scripts/import-questions.js` 产出 JSON Lines 后控制台或 MCP 导入）

**开发待办**
- 首页按新 UI 稿重做（今日目标深色卡、专项 6 宫格）
- 其余页面套用设计令牌
- 打卡 / 排行榜 / 战报海报联调
- 隐私授权 `wx.getPrivacySetting`（需基础库 2.32.3+，低版本做能力检测降级）
- 埋点校验、`audit_mode` 验证、提审

**其他**
- ICP 备案：**2026-09-05 已启动**。注意平台初审后工信部 12381 短信核验须 **24 小时内**完成，
  超时自动驳回落得重来。安排专人盯短信
- 类目：先「工具 > 效率」，稳定后加「教育 > 在线教育」
- ~~注册 GitHub SSH 公钥并推送 main/develop~~ ✅ 2026-09-06
- 榜单「击败百分比」当前本地估算，V1.1 换云端真实分位

## 已落地资产

- `docs/上线提审清单.md`：备案、类目、隐私指引、后台配置、审核截图、时间线
- `docs/架构设计.md`：v2.0，唯一权威架构文档（v1.0 已存档为 `架构设计-v1.0-存档.md`）
- `database/import/导入说明.md`：建库四步 + JSON Lines 格式要求
- `database/import/config.json`：config 集合 5 条初始配置（audit_mode / min_version /
  latest_version / checkin_tmpl_id / share_text）
- `scripts/gen-tabbar-icons.py`：一键生成 8 张 81×81 tabBar 图标，主色 `#0066CC`
- `miniprogram/assets/tabbar/`：首页/题库/错题本/我的 × 未选中/选中
- `miniprogram/styles/tokens.wxss`：设计令牌唯一取值来源
- `miniprogram/pages/library/`：题库页（模块进度卡 + 考点 chips + 搜索）
- **`scripts/cloudbase-healthcheck.js`**：CI 用 CloudBase 环境健康检查（依赖 2 个 GitHub Secret）
