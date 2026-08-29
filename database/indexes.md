# 数据库索引清单

> 建库后照着这张表在云开发控制台配置。
> 没有索引时数据量小感觉不到差异，等 `records` 涨到百万级，缺一个索引就是全表扫描，
> 云函数直接超时。这一步不能省。

## 必建索引

| 集合 | 字段 | 类型 | 是否唯一 | 为什么 |
|---|---|---|---|---|
| `users` | `_openid` | 升序 | ✅ 唯一 | 每次登录都按它查 |
| `questions` | `qid` | 升序 | ✅ 唯一 | 业务主键，抽题/详情/批量查 |
| `questions` | `module` + `status` + `difficulty` | 联合，升序 | 否 | 抽题主查询，配合难度分桶 |
| `questions` | `subtype` + `status` | 联合，升序 | 否 | 二级考点专项练习 |
| `records` | `_openid` + `createdAt` | 联合，`createdAt` 降序 | 否 | 查近期作答、分页遍历 |
| `records` | `_openid` + `qid` | 联合，升序 | 否 | 判断某题是否答过 |
| `records` | `date` | 升序 | 否 | 定时归档按日期删除 |
| `wrong_book` | `_openid` + `mastered` + `lastWrongAt` | 联合，`lastWrongAt` 降序 | 否 | 错题本分页，最高频查询 |
| `wrong_book` | `_openid` + `qid` | 联合，升序 | ✅ 唯一 | 判题更新已有错题 |
| `favorites` | `_openid` + `qid` | 联合，升序 | ✅ 唯一 | **防重复收藏**，靠数据库兜底 |
| `favorites` | `_openid` + `createdAt` | 联合，`createdAt` 降序 | 否 | 收藏列表分页 |
| `checkins` | `_openid` + `date` | 联合，升序 | ✅ 唯一 | **防重复打卡**，并发提交时靠它兜底 |
| `checkins` | `date` + `correctCount` | 联合，`correctCount` 降序 | 否 | 榜单聚合 |
| `daily_task` | `date` | 升序 | ✅ 唯一 | 每天一条 |
| `config` | `key` | 升序 | ✅ 唯一 | 配置查取 |
| `events` | `event` + `createdAt` | 联合，`createdAt` 降序 | 否 | 埋点查询与清理 |

## 两条唯一索引是业务逻辑的一部分

`favorites` 和 `checkins` 的唯一索引不只是性能优化，**它们承担了业务约束**：

- 用户狂点收藏按钮 → 第二次插入直接失败，`answer` 云函数捕获 `errCode === -502005` 按成功处理
- 两个请求并发打卡 → 其中一个撞唯一索引回滚，`checkin` 云函数捕获后返回"今天已经打过卡啦"

代码里都有对应的兜底分支，索引不建就会出现重复数据。

## 配置路径

微信开发者工具 → 云开发 → 数据库 → 选中集合 → 索引管理 → 添加索引

## 验证方法

数据量上来后，在云开发控制台的慢查询日志里看是否有超过 500ms 的查询。
出现全表扫描（`COLLSCAN`）就说明索引没生效，常见原因是**字段顺序错了**——
联合索引遵循最左前缀原则，`_openid + mastered + lastWrongAt` 对「只按 `mastered` 查」无效。

## 容量提醒

| 集合 | 月增量（1 万 DAU） | 处理策略 |
|---|---|---|
| `records` | ~450 万条 | 90 天自动归档 |
| `events` | ~200 万条 | 30 天自动清理 |
| `wrong_book` | ~50 万条 | 长期保留 |
| `checkins` | ~30 万条 | 长期保留 |

云开发数据库按容量和读写次数计费。`records` 是主要成本来源，归档逻辑不能省。
