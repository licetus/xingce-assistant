# 云数据库集合结构

> 建库前必读：所有集合的**安全规则一律设为「仅管理端可读写」**。
> 客户端不直连数据库，全部通过云函数访问。这样即使有人反编译小程序，也拿不到任何数据。

## 集合一览

| 集合 | 说明 | 读写方 | 增长性 |
|---|---|---|---|
| `users` | 用户主档 | 云函数 | 随用户数 |
| `questions` | 题库 | 云函数读，脚本导入 | 基本固定 |
| `qgroups` | 材料题共用材料 | 云函数 | 基本固定 |
| `records` | 答题流水 | 云函数写 | ⚠️ 最快 |
| `wrong_book` | 错题本 | 云函数 | 中 |
| `favorites` | 收藏 | 云函数 | 低 |
| `checkins` | 每日打卡 | 云函数 | 中 |
| `daily_task` | 每日任务题目 | timer 写，云函数读 | 每年 365 |
| `rank_cache` | 榜单缓存 | timer 写，rank 读 | 固定 2 条 |
| `config` | 运营配置 | 后台手改，login 读 | 约 20 条 |
| `events` | 埋点流水 | track 写 | ⚠️ 快 |

---

## users

```js
{
  _id:         'auto',
  _openid:     'oXXXX',              // 唯一索引
  profile:     { nickName: '', avatarUrl: '', grade: '' },
  inviteBy:    null,                 // 邀请人 _openid，扫码进入时写入
  checkin:     { streak: 0, maxStreak: 0, lastDate: '', totalDays: 0 },
  stats: {
    totalDone: 0, totalCorrect: 0,
    byModule: {
      '常识判断': { done: 0, correct: 0 },
      '言语理解': { done: 0, correct: 0 },
      '数量关系': { done: 0, correct: 0 },
      '判断推理': { done: 0, correct: 0 },
      '资料分析': { done: 0, correct: 0 }
    }
  },
  subMsg:      { checkin: 0 },       // 订阅消息剩余可推送次数
  createdAt:   Date,
  lastActiveAt: Date                 // 5 分钟节流更新，避免高频写
}
```

**`byModule` 为什么定长 5 键**：前端可以直接遍历渲染，不用处理"某个模块还没数据"的分支，也不用额外的 `$exists` 判断。行测就是这五个模块，不会变。

---

## questions

```js
{
  _id:      'auto',
  qid:      10001,                   // 业务主键，Number，唯一索引
  module:   '资料分析',               // 五大模块之一
  subtype:  '增长率计算',             // 二级考点
  type:     'single',                // single | multi | material
  stem:     '题干文本',
  options:  [{ key: 'A', text: '' }],
  answer:   ['B'],                   // 数组，兼容多选
  analysis: '解析文本',
  difficulty: 3,                     // 1-5
  tags:     ['增长率', '基期量'],
  materialId: null,                  // type=material 时指向 qgroups.gid
  images:   [],                      // 云存储 fileID
  source:   'real',                  // 来源标识：'real' 历年真题 | 'ai' AI生成(V1.1) | 'self' 自研改编。
                                     // 客户端题目卡片按此展示来源标签，必须如实标注
  status:   1,                       // 1 上架 / 0 下架
  stat:     { done: 0, correct: 0 }, // 全局作答统计，用于难度校准
  createdAt: Date
}
```

**版权红线**：`source` 字段必须如实标注。直接搬运历年真题原文和官方解析，是教育类小程序被投诉下架的头号原因。自研或深度改编。
**来源标识合规**：题目必须向用户明示来源（真题 / AI 生成）。V1.1 引入 AI 生成功能后，AI 题一律 `source:'ai'`，前端自动挂「AI 生成」标签——AI 生成内容不标识属于平台审核红线。

---

## qgroups

材料题（资料分析、言语理解套题）的共用材料，多道题共享一份。

```js
{ _id: 'auto', gid: 2001, material: '材料正文', images: [], createdAt: Date }
```

---

## records

答题流水，只写不改，是离线分析和难度校准的数据源。

```js
{
  _id: 'auto',
  _openid: 'oXXXX',
  qid: 10001,
  module: '资料分析',      // 冗余，避免按模块分析时再关联 questions
  chosen: ['B'],
  correct: true,
  costMs: 12000,
  scene: 'practice',       // practice | review | checkin | exam
  date: '2026-08-29',      // 冗余东八区日期，便于按天聚合与归档
  createdAt: Date
}
```

**容量规划**：日活 1 万、人均日答 15 题 → 月增约 450 万条。
`timer` 每天 03:30 自动清理 90 天前的数据（见 `cloudfunctions/timer`）。

---

## wrong_book

```js
{
  _id: 'auto',
  _openid: 'oXXXX',
  qid: 10001,
  wrongCount: 2,        // 累计答错次数
  rightStreak: 0,       // 当前连续答对次数
  mastered: false,      // 连续答对 2 次自动置 true
  lastWrongAt: Date,
  createdAt: Date
}
```

**移除规则**：`rightStreak >= 2` → `mastered: true`。这是艾宾浩斯遗忘曲线的最简实现——
错一次不够，要连续两次答对才算真会了。用户也可以在错题本手动标记「已掌握」。

---

## favorites

```js
{ _id: 'auto', _openid: 'oXXXX', qid: 10001, createdAt: Date }
```

唯一索引 `(_openid + qid)` 防重复收藏。

---

## checkins

```js
{
  _id: 'auto',
  _openid: 'oXXXX',
  date: '2026-08-29',     // 东八区日期，唯一索引 _openid + date
  doneCount: 10,
  correctCount: 7,
  durationSec: 320,
  createdAt: Date
}
```

---

## daily_task

预生成的每日打卡题目。所有人同一套题——保证排行榜公平，也让这张表一年只需 365 条。

```js
{ _id: 'auto', date: '2026-08-29', qids: [10001, ...], createdAt: Date }
```

由 `timer` 每天 00:05 生成，五大模块各 2 题，难度限定 2~4（避开偏题怪题，打卡是培养习惯不是劝退）。

---

## rank_cache

只有两条固定 `_id` 的文档：`week` 和 `total`。
`timer` 每小时重算前 200 名写进来，`rank` 云函数只读这里，绝不实时聚合 500 万级 `checkins`。

⚠️ 本集合**不要建 `_openid` 唯一索引**：两条缓存文档都不含 `_openid`，
唯一索引会把缺失值都算作 null 触发 E11000（2026-09-07 实际踩坑并已删除误建索引）。

```js
{
  _id: 'week',
  list: [{ _openid: '', nickName: '', avatarUrl: '', totalCorrect: 0, totalDone: 0, days: 0 }],
  updatedAt: Date
}
```

---

## config

运营配置，改了即时生效，不需要发版。

| key | 类型 | 说明 |
|---|---|---|
| `audit_mode` | boolean | **审核模式**。置 true 时隐藏排行榜、邀请、奖励入口和**全部广告**。提审前打开，通过后关掉 |
| `checkin_tmpl_id` | string | 打卡订阅消息模板 ID |
| `checkin_tmpl_fields` | object | 打卡提醒模板字段映射 {date,streak}，默认 thing1/thing2 |
| `share_text` | string | 分享文案，可随时换 |
| `min_version` | string | **强制更新线**。低于此版本弹不可取消的弹窗阻断使用，用于严重 Bug 或不兼容变更 |
| `latest_version` | string | 柔性更新提示。低于此版本弹一次性提示，用户可忽略，每天最多打扰一次 |
| `update_note` | string | 更新说明文案，配合上面两个字段展示 |
| `home_banner` | object | 首页 banner 配置（运营位图片卡片，非流量主广告） |
| `ad_banner_home` | string | 流量主 Banner 广告位 ID（adunit- 前缀）。**空 = 未启用**，前端不渲染。开通流量主后填入即生效 |
| `ad_video` | string | 激励视频广告位 ID（adunit- 前缀）。空 = 未启用。utils/ad.js 封装 showVideoAd()，供 V1.1「看广告解锁 AI 出题」等场景使用 |
| `ad_interstitial` | string | 插屏广告位 ID（adunit- 前缀）。空 = 未启用。开启时（onShow）自动触发，3 小时全局冷却 + 上午（04:00–12:00）/下午（12:00–18:00）/晚上（18:00–次日04:00）各最多 1 次，全天 ≤3 次，频控记在用户本地 |
| `debug_mode` | boolean | **调试面板开关**。true 时「我的」页底部显示调试面板（模拟强更/弹插屏/播激励视频/拉订阅授权等）。仅开发期使用，**提审前必须置 false**；双保险：audit_mode=true 时面板也会被 canShow 强制隐藏 |

> `audit_mode` 是提审救命开关，V1 一定要做进去。没有它，每次提审都要改代码重新发版。
>
> 三个版本字段是**唯一能绕过审核的热更手段**。代码包改一个字都要重新提审（1~7 个工作日），
> 而这几个字段改完即时生效。能用配置解决的问题，绝不要写死在代码里。

---

## events

埋点流水。

```js
{ _id: 'auto', _openid: 'oXXXX', event: 'practice_finish', payload: {}, ts: Date, createdAt: Date }
```

量大但价值低，建议保留 30 天即可，可复用 `timer` 的归档逻辑。
