# 行测小助手 · 项目长期记忆（精简版 2026-09-07）

## 项目
微信小程序行测刷题工具（常识/言语/数量/判断/资料）。目录 `~/WorkBuddy/xingce-assistant`，
GitHub `licetus/xingce-assistant`（SSH，指纹 SHA256:beTGz...sc4Bg）。双分支 main（严格保护：PR+1 approval+checks）+ develop（宽松：仅禁 force push/delete）。hotfix 须同合 main+develop。当前开发在 develop。
统一标识 `xingce-assistant@licetus`（SSH 注释、仓库级 git author）。历史提交作者未改写。
副本 `xingce-assistant_副本` 仅备份，勿动。

## 选型（勿重复询问）
原生小程序 + 微信云开发（否掉 Taro/uni-app）；零 npm 运行时依赖，UI 手写；
基础库 ≥2.25.0；企业主体；自建题库；主色 #0066CC。
设计令牌唯一来源 `miniprogram/styles/tokens.wxss`（--brand/--text-1/--line），勿改成 --color-primary 命名法。
V1 范围锁定：专项刷题+解析、错题本+收藏、每日打卡+排行榜。模考不进 V1（pkg-exam 预留）。
不能打包字体文件，走系统字体栈；数字加 .tnum。

## 不可违背的架构约束
1. 判题全在云端，下发题目不含 answer 字段
2. 所有集合 ADMINONLY，客户端一律走云函数；所有云调用经 utils/cloud.js
3. 东八区算日期（打卡/榜单），禁 UTC
4. tabBar 页只能 switchTab 跳；practice 已移出 tabBar，用 navigateTo
5. 事务只支持单文档 doc()/add()；事务内 where 查询/批量 update 必抛错（先事务外预查 _id）
6. 聚合累加器在 db.command.aggregate 命名空间（$.sum）
7. 数据库导入 JSON 必须 JSON Lines 格式
8. 禁 .catch(()=>null) 静默吞掉云函数缺失（测试守：services 引用的函数名必须有目录）
9. 头像昵称用 chooseAvatar + input type=nickname，wx.getUserProfile 已废弃
10. 提交前必须 npm test（134+ 用例，mock-sdk.js 忠实还原平台约束，勿"修掉"）

## 云环境
EnvId `pro-d3g3e4uab0265b1c6`（上海标准版，资源点计费 199/月）。配置在 miniprogram/config.js + cloudbaserc.json。
11 函数 / 11 集合 / 19 索引 / 5 触发器（dailyTask 00:05、rebuildRank 每小时:10、archive 03:30、healthCheck 09:10、notify 09:00 打卡提醒）。
timeout：login10/question20/answer20/checkin15/wrongbook15/favorite10/rank20/share20/track10/timer20/user10。

## 部署铁律
- MCP 增量部署用 `updateFunctionCode force=true`（force=false 哈希相同会静默跳过；createFunction force=true 会清空触发器）
- **MCP createFunctionTrigger 是全量覆盖语义**：一次调用替换全部触发器，多次单独调用互相覆盖——必须一次传全量，改后必 listFunctionTriggers 核对
- **定时触发器 event 是 {Type:'Timer',TriggerName}**：云函数 main 必须做 TriggerName→action 映射，否则定时任务静默 404
- timer cron 必须 7 段（秒 分 时 日 月 星期 年）
- MCP `invokeFunction` 可直接调云函数调试（自动注入 OPENID）
- TCB 升级不换 EnvId
- 小程序代码包无热更新，能走 config/云函数的绝不写死；云函数接口只加字段不删字段
- 强更：config.min_version/latest_version + utils/update.js，仅 release 版校验

## CI
`.github/workflows/ci.yml`：test job（Node 18/20/22 × npm test）+ cloudbase-healthcheck（仅 develop push）。
healthcheck 用 2 个 Secrets：TENCENTCLOUD_SECRETID/KEY。⚠️ 旧密钥（AKID36xd...）2026-09-07 已被用户禁用，若 Secret 同对需用户换新，否则 CI healthcheck 401。
Branch protection 的 3 个 API 坑见 docs/branch-protection.md（Content-Type json / 个人仓库禁 dismissal_restrictions / restrictions 传 null）。

## 题库现状
- 官方不托管历年真题（scs.gov.cn 已下线，bm.scs.gov.cn 考后归档 404）
- 来源 gwy.gkzhenti.cn（只含题干+答案，无解析），`scripts/fetch-gkzhenti.js` 抓 9 套 1185 题
- **682 题已入库 questions 集合**（analysis=「待补」占位，source 全部 'real'），管道：fetch→merge→import(--allow-empty-analysis)→node-sdk 分批 add
- 题目来源标识：source 'real' 真题 | 'ai' AI生成(V1.1) | 'self' 自研；卡片挂标签，AI 不标识属审核红线（2026-09-08 d2c6dae）
- 解析需自购纸质真题集 + 自主编写（抄第三方解析侵权），见 docs/question-bank-sources.md

## 待办
- ~~rebuildRank E11000~~ ✅ 2026-09-07 修复：rank_cache 误建 _openid 唯一索引已删（writeNoSqlDatabaseStructure DropIndexes），
  rank.rebuild 验证通过。教训：**固定 _id 的缓存集合（week/total）不要建 _openid 唯一索引**，
  缺失字段都按 null 计入唯一索引必撞 E11000。已写入 schema.md + 环境迁移操作手册.md 防复踩
- 题库管线已入库（commit 1ee1d4d）：fetch-gkzhenti/merge-fetched/to-mcp-format 脚本 + 2 份文档；
  invalid.json/questions.mcp.json 移到 database/raw/（非 JSON Lines 工作产物，静态测试只扫 database/import/*.json）
- ~~首页 UI 重做~~ ✅ 2026-09-07 commit d029776：问候+头像 / 今日目标深色卡 / 专项 6 宫格（5 模块+随机练习），
  CI 4/4 全绿（healthcheck success = 新腾讯云密钥已生效）。缓存 key 已升 home-v2
- ~~其余页面套令牌~~ ✅ 2026-09-07 commit 157783a：全站 wxss 写死色值清零（新增 --disabled-bg 令牌），
  仅深色卡 rgba 白为透明度叠加。npm test 134/134，CI 见 origin/develop
- ~~打卡/排行榜/海报联调~~ ✅ 2026-09-07 commit f05d552：海报画布+小程序码旧主色残留已修（share 已重部署）。
  **MCP invokeFunction 的 OPENID 注入不稳定**（checkin 通/rank/user 401，线上代码 diff 验证守卫一致）——
  带守卫接口的云端冒烟不可信，以本地测试+真机预览为准；无守卫 action（timer/rebuild）可冒烟
- ~~隐私授权~~ ✅ 2026-09-07 commit 9fc963e：utils/privacy.js 三件套（getSetting/ensure/openContract，
  <2.32.3 降级放行），海报保存前 ensure()，144/144 测试。**用户手动：微信后台隐私指引须声明相册（仅写入）**
- ~~埋点/audit_mode/config 验证~~ ✅ 2026-09-08：track.batch 冒烟 ✅；config 空集合已补 6 条基线
  （audit_mode 端到端翻转验证 ✅）；checkin 页排行榜入口补 audit_mode 守卫（9393c45）
- ~~订阅消息链路~~ ✅ 2026-09-08 commit 8f45501：timer.notify 发送侧 + TriggerName 映射修复 +
  触发器全量重建 5 个 + grantSubscribe 封顶。模板 ID 已入 config（hVLbKY19...c），notify 冒烟通过，
  今日 dailyTask 已补跑。**真机需验证：提醒消息字段 thing1/thing2 与用户模板是否匹配**
  （不匹配报 47003 → 控制台改 config.checkin_tmpl_fields 即可，不用发版）
- 下一步：真机预览（海报颜色/小程序码/订阅提醒字段）→ 提审（audit_mode 置 true）
- Excel 填 682 题解析
- ICP 备案 2026-09-05 启动，12381 短信 24h 内须核验
- 类目先「工具>效率」，后加「教育>在线教育」；提审清单见 docs/上线提审清单.md
- 用户手动：控制台改 alias datizhushou→datizhushou-trial
- 用户手动：UV≥500 后开通流量主（2026 门槛已下调），广告位 ID 填 config（ad_banner_home/ad_video），见 docs/广告接入指南.md
- 榜单击败百分比本地估算，V1.1 换云端分位
- 详见 `.workbuddy/memory/2026-09-07.md` / `2026-09-08.md` 当日日志
