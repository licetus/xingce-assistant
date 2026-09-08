# 行测小助手 · 项目长期记忆（精简版 2026-09-08）

## 项目
微信小程序行测刷题工具（常识/言语/数量/判断/资料）。目录 `~/WorkBuddy/xingce-assistant`，
GitHub `licetus/xingce-assistant`（SSH）。双分支 main（严格保护：PR+1 approval+checks）+ develop（宽松）。当前开发在 develop。
选型：原生小程序 + 微信云开发；零 npm 运行时依赖；基础库 ≥2.25.0；企业主体；自建题库；主色 #0066CC。
设计令牌唯一来源 `miniprogram/styles/tokens.wxss`（--brand/--text-1/--line；圆角只有 --radius/-sm/-capsule，无 -lg/-md）。
V1 范围：专项刷题+解析、错题本+收藏、每日打卡+排行榜。模考不进 V1（pkg-exam 预留）。
不能打包字体，走系统字体栈；数字加 .tnum。

## 不可违背的架构约束
1. 判题全在云端，下发题目不含 answer 字段
2. 所有集合 ADMINONLY，客户端一律走云函数；所有云调用经 utils/cloud.js
3. 东八区算日期（打卡/榜单/广告频控），禁 UTC
4. tabBar 页只能 switchTab 跳；practice 用 navigateTo
5. 事务只支持单文档；事务内 where/批量 update 必抛错（先事务外预查 _id）
6. 聚合累加器在 db.command.aggregate 命名空间
7. 数据库导入 JSON 必须 JSON Lines 格式
8. 禁 .catch(()=>null) 吞掉云函数缺失（测试守）
9. 头像昵称用 chooseAvatar + input type=nickname
10. 提交前必须 npm test（当前 179 用例，mock-sdk.js 忠实还原平台约束，勿"修掉"）
11. **WXML 绑定禁方法调用**（indexOf/join/slice 等求值为空、静默失败，测试测不到）：
    状态标记/拼接一律在 JS 侧算好进 data，WXML 只做属性访问。09-08 选项无高亮 bug 即此因

## 云环境
EnvId `pro-d3g3e4uab0265b1c6`。11 函数 / 11 集合 / 5 触发器（dailyTask 00:05、rebuildRank 每小时:10、archive 03:30、healthCheck 09:10、notify 09:00）。

## 部署铁律
- MCP 增量部署用 `updateFunctionCode force=true`（否则哈希相同静默跳过）
- **MCP createFunctionTrigger 全量覆盖**：必须一次传全部触发器，改后 listFunctionTriggers 核对
- **定时触发器 event 是 {Type:'Timer',TriggerName}**：main 必须做 TriggerName→action 映射
- cron 7 段；MCP invokeFunction 可冒烟但 **OPENID 注入不稳定**（带守卫接口 401 不可信，以本地测试+真机为准）
- MCP writeNoSqlDatabaseContent 的 update 默认单文档，批量必须 isMulti:true
- config 集合是运营总开关（audit_mode/min_version/模板 ID/广告位/debug_mode），全走热下发不写死
- 强更：min_version/latest_version + utils/update.js，仅 release 校验

## CI
test（Node 18/20/22）+ cloudbase-healthcheck（develop push，2 Secrets）。新腾讯云密钥已生效（09-07 起 CI 全绿）。

## 题库
- 682 题已入库（analysis=「待补」，source 全部 'real'），来源 gwy.gkzhenti.cn（无解析）
- source 语义：'real' 真题 | 'ai' AI生成(V1.1，必须标识，审核红线) | 'self'；卡片挂来源标签
- **09-08 重大勘误**：gkzhenti paperId 映射 9 套错 8 套（fetched-2025-* 实为 2026 卷…），
  对照表 database/raw/PAPER-MAPPING.md，fetch 脚本已更正
- questions.exams 数组已全量回填 682/682（真题出处，一题多卷多项）；
  tags 用「国考YYYY」年份标签，卷别细节以 exams 为准；卡片真题标签显示具体出处
- 2026-09-08 起 627 题解析已全部回填为 AI 辅助原创解析，记 analysisSource='ai'
  （与 source 独立：题目来源看 source，解析来源看 analysisSource，见 schema.md）
- **subtype 只存短考点标签，材料必须并入 stem**（材料+空行+题干）——09-08 修复过导入污染：
  93 题已合并；55 题资料分析材料正文源站缺失已下架（status=0 + tags「缺材料待补」，
  清单 database/raw/offline-missing-material-2026-09-08.json），纸质真题集补回后恢复 status=1
- 纸质真题集仅用于人工复核 AI 解析（尤其缺图题），无需再抄写
- MCP 不支持管道更新（$concat），逐题变换走一次性云函数（跑完即删）

## 功能就绪状态（V1 全部完成，2026-09-08）
- 核心：刷题/解析/错题/收藏/打卡/排行榜/海报（全站令牌化，CI 绿）
- 广告基建（utils/ad.js，均走 config 热下发，空=未启用，audit_mode 一键关停）：
  Banner（首页底）/ 激励视频（showVideoAd 单例）/ 插屏（开启时触发：
  3h 全局冷却 + 上午04-12/下午12-18/晚上18-次日04 各 1 次，业务日以 04:00 翻新）
- 订阅消息完整链路：授权→配额（封顶3）→timer.notify 发送→成功扣减；字段映射 config.checkin_tmpl_fields 可热更
- 隐私：utils/privacy.js 三件套，<2.32.3 降级；海报保存前 ensure()
- 调试面板：mine 页底部，config.debug_mode 控制（当前 true），audit_mode 强制隐藏（双保险）；
  六动作：模拟强更/柔性提示/插屏 force/激励视频/订阅授权/隐私协议
- 埋点 track 完整；audit_mode 端到端验证过（热翻转即时生效）

## 提审前待办（用户手动为主）
1. 真机预览：海报颜色/小程序码/隐私弹窗/订阅提醒字段 thing1/thing2（不匹配报 47003 改 config 即可）；
   **海报已修 41030（未发布版 getUnlimited 空 page 回退，share 已重部署），需真机复验**
2. ~~627 题原创解析~~ ✅ 2026-09-08 已回填线上（develop 544e4fc，analysisSource='ai'）；
   图形/材料依赖题解析带缺图提示，补材料图后可人工复核；55 题缺材料资料分析（已下架）补材料后恢复 status=1
3. ICP 备案 12381 短信核验；类目「工具>效率」；控制台 alias datizhushou→datizhushou-trial
4. 提审时：云控制台 audit_mode=true + debug_mode=false（清单 11a），见 docs/上线提审清单.md
5. UV≥500 后开通流量主（2026 门槛已下调），广告位 ID 填 config，见 docs/广告接入指南.md
6. V1.1 候选：AI 出题（source:'ai' + showVideoAd 解锁，链路已就绪）；榜单击败百分比换云端分位
7. 详见 `.workbuddy/memory/2026-09-07.md` / `2026-09-08.md` 当日日志
