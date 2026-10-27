# O07 SQL 事件统计本地验收（2026-10-23）

新增 analytics_events 保存受控统计元数据；SQLite 与 MySQL 均提供 appendAnalyticsEvents、queryAnalyticsEvents、queryAnalyticsRetention、pruneAnalyticsEvents。只保存事件类型、发生时间、智能体/当时机构、匿名哈希及已知 usage/延迟/结果字段，不保存问答、报告正文或供应商凭据。

- 保留最近90天，不设3000条环形容量上限。启动、写入时和每小时清理过期行；查询也限定保留窗口。
- 旧 platform.analytics.v1 仅按真实事件 ID 幂等迁入一次。旧事件没有机构归属时不会按今天的归属编造历史，机构视图排除这类旧事件；平台视图可见。旧缓存已丢失的历史不可恢复，coverage 保留说明。
- 机构 SQL 查询同时约束 tenant_id 与授权 agent_slug，智能体转移后不会把原机构历史交给新机构。
- 查询超过250000事件返回413 ANALYTICS_QUERY_TOO_LARGE，要求缩日期或选择智能体，不截断后输出不完整总数。
- 留存先在完整保留窗口找首个可观察活动，再按查询日期筛 cohort；第1/7/30日目标须到达查询截止日。窗口前活动未知，因此不声称真实首次注册或自然人数。
- usage 未提供、价格未配置时仍为 null；费用是按配置价格估算，真实账单须另行对账。

## 兼容性

SQLite additive CREATE TABLE/INDEX，meta.schema_version 升到3，不删除原表。MySQL migration3 只新增统计表，原 migration1/2 checksum 保持不变。升级继续受既有平台文件租约和 MySQL 单写入者锁保护；没有关闭锁或启动多写入者。

schema-only 操作 scripts/upgrade-consumer-schema.mjs 支持显式 --apply-schema（兼容原 --apply-consumer-v2 入口），支持已知 schema1/2/3，不启动业务、消费者账号初始化、任务恢复或模型请求。备份表白名单及历史1/2恢复增量兼容由 mysql-ops-common 覆盖。

## 实际证据

- 定向 SQL统计/审计/迁移/备份/升级回归50项通过；新增实际250001行 SQLite 查询保护测试。
- output/builder-p1p2-mysql-20261023/mysql-analytics-sql-receipt.json：真实 MySQL Community8.4.10，v2→v3增量迁移、旧checksum不变、3205本机构及3206外机构事件隔离、重复写入、留存cohort CTE、90日边界、事务回滚、重开持久化和旧meta一次迁入全部通过。测试后临时schema及账号删除，实例停止。
- 仅本地QA；没有连接生产或调用供应商服务，没有新增真实业务事件或补造旧历史。
