# W09 分布式适配：本地候选与接入前置条件

截至 2026-10-23，代码提供 Redis Streams 分发、共享限流和 Qdrant 向量适配。默认关闭；现有数据库队列和单平台写入者继续工作。**本项为部分完成，未证明多平台横向扩容、未部署、未接通真实 Redis/Qdrant。**

## 已实现

- Redis 使用 AUTH/SELECT 后发送受控 RESP2 命令，支持分段 UTF-8 响应、连接超时和错误脱敏，不新增包依赖。
- Streams 使用 XGROUP/XADD/XREADGROUP/XACK；未确认消息保留 pending，Redis 6.2+ 的 XAUTOCLAIM 按闲置时间接管并保留扫描游标。确认后 XDEL 清理该专用组的历史条目。
- Redis 仅承载持久分发提示，jobId 为提示；数据库 jobs 与现有 claimJob 是任务状态的唯一权威。MySQL 已有 FOR UPDATE SKIP LOCKED；未修改其 GET_LOCK 单实例锁或文件 lease。
- 限流通过固定 Lua 脚本原子 INCR + PEXPIRE + PTTL，在相同租户/范围的不同运行实例之间共享计数；Redis key 哈希化用户范围，不存明文身份。
- Qdrant upsert/search/delete 都要求 tenantId、agentSlug、documentId、revision 四项。搜索还复查本地当前 ready/approved/有效资料及 documentAllowed 回调，拒绝跨租户、过期版本与不存在片段。外部 payload 只保存 scope + chunkIndex，原文从当前本地审核资料读取。
- 管理后台 GET /api/admin/runtime 返回安全配置状态；POST /api/admin/runtime/test 仅发 PING 与集合 GET，不写队列或向量，不接收任意目标地址或命令。
- 独立分发 worker 不打开平台数据库，只向持锁平台固定内部执行接口发送经过 Bearer 认证的提示。显式数据库接受后才 ACK。故障时保留 pending 等待接管。

## 环境变量（均由服务端配置，禁止放进前端）

| 变量 | 含义 |
| --- | --- |
| DISTRIBUTED_RUNTIME_ENABLED | 必须显式 true，否则完全沿用旧模式 |
| DISTRIBUTED_TENANT_ID | 必填受信任租户 ID，不可取自访客输入 |
| REDIS_URL | redis:// 或 rediss:// 地址，支持 ACL 用户与数据库 0—15 |
| REDIS_NAMESPACE | 默认 medtalent；使用专用命名空间 |
| REDIS_STREAM_GROUP | 默认 knowledge；专用流只配置此一个消费组 |
| REDIS_CLAIM_IDLE_MS | 60000—86400000，默认 60000 |
| QDRANT_ENABLED | 必须显式 true |
| QDRANT_URL | 本机 HTTP 或明确受控的 HTTPS 服务 |
| QDRANT_ALLOWED_HOSTS | 非本机 HTTPS 主机的显式允许列表，逗号分隔 |
| QDRANT_COLLECTION | 已预建集合；不自动创建或修改距离/维度 |
| QDRANT_API_KEY | 仅服务端使用，不出现在状态与错误中 |
| DISTRIBUTED_EXECUTOR_URL | 固定 /api/internal/runtime/dispatch 执行端点 |
| DISTRIBUTED_EXECUTOR_ALLOWED_HOSTS | 非本机执行端 HTTPS 主机允许列表 |
| DISTRIBUTED_WORKER_TOKEN | 执行端与分发 worker 共享的 32—512 字符认证密钥 |
| DISTRIBUTED_CONSUMER_ID | 每个分发进程的唯一 ID |

Redis 本身必须配置 AOF/RDB、备份与恢复、专用 ACL 和监控；本代码的 PING 不验证持久化是否启用，status 明确 persistenceVerified:false。禁止向生产 Redis 执行清库或重置现有消费组。Redis 中断不能成为丢失 SQL 排队任务的理由，平台原有轮询必须保留。

## 根服务接线

~~~js
const runtime = createDistributedRuntime({
  database,
  env,
  documentAllowed: doc => knowledge.documentProvenanceAllowsPublishing(doc),
});
registerDistributedRoutes(app, { admin, viewer, runtime, audit });
~~~

- 数据库创建 job 成功后再调用 runtime.enqueue(job)，不要在 SQL 提交前发布。Redis 失败需审计并继续 SQL 轮询。
- sharedLimit 返回 enabled:false、allowed:null 时用原有限流；Redis 已启用而故障时应按业务明确执行失败关闭，不能伪造 allowed:true。
- 向量索引只由受信任写入者调用；root 应在现有审批/发布/修订/删除流程 hook upsert/delete，并提供 documentAllowed。查询按当前已审核资料逐文档调用 search，再合并分数；不允许去掉 documentId/revision 过滤来提速。没有真实索引的资料继续使用旧检索。
- 多机构部署须从受信任机构上下文选择固定 tenantId 的 runtime/adapter，不能允许客户端覆盖配置租户。

可选内部执行 handler：

~~~js
app.post('/api/internal/runtime/dispatch', express.json(),
  createDistributedDispatchHandler({
    runtime,
    token: env.DISTRIBUTED_WORKER_TOKEN,
    executeDispatch: async () => {
      // 仅当前持锁实例。runOne 自带 busy/stopped 和 SQL claim 保护。
      // 接受的是唤醒信号，不是指定任务的越权直接执行。
      void knowledge.runOne().catch(recordWorkerError);
    },
  }));
~~~

执行端还应由反向代理/网络 ACL 限制 worker 来源；不要暴露为消费者接口。

## 独立 worker 命令

~~~text
node --env-file=.env.distributed.local scripts/distributed-worker.mjs --test
node --env-file=.env.distributed.local scripts/distributed-worker.mjs --once
node --env-file=.env.distributed.local scripts/distributed-worker.mjs
node --test server/distributed-runtime.test.mjs
~~~

--test 只检查 Redis 与 Qdrant 连通。未配置时不会假称接通。SIGINT/SIGTERM 结束循环；当前请求有有界超时。不能用该脚本启动第二个 PlatformDatabase/MySQLDatabase 或绕开文件锁。

## 本地证据与未验收项

只读检查过 D:/项目/讲座小程序、健康科普专委会小程序、减重管理平台重建：没有可复用的 Redis 队列业务实现；专委会 package.json 声明 ioredis 5.6。当前项目未新增依赖或改动这些项目。用户 .local/tools 无 Redis 二进制。Docker daemon 不可用，WSL inventory 为 E_ACCESSDENIED；没有下载、启动、停止任何现有服务。

本地 9 项协议/接口测试通过：RESP 分包与认证、默认关闭、跨实例共享限流、pending 超时接管、Qdrant 四项范围与本地白名单、只读连通检查脱敏、worker 确认协议、内部认证与管理路由权限。这些测试使用协议仿真，**不能等同真实 Redis/Qdrant、实际多进程故障恢复或压力验收**。

仍需在隔离环境真实验证：Redis 持久化重启与超时接管、共享限流并发精度、Qdrant 集合维度及写入/删除/查询、故障回退、索引生命周期 hooks、外部 worker 网络认证。真正多执行者需要先重构并审计锁/文件/blob/任务租约设计，本次没有关闭安全锁，因此 status 保持 multiWorkerReady:false。

## 协议参考

- Redis XREADGROUP: https://redis.io/docs/latest/commands/xreadgroup/
- Redis XAUTOCLAIM: https://redis.io/docs/latest/commands/xautoclaim/
- Qdrant Query API: https://api.qdrant.tech/v-1-10-x/api-reference/search/query-points
- Qdrant filtering: https://qdrant.tech/documentation/search/filtering/


## SQL 提交后分发桥和实际限流接线

server/distributed-broker.mjs 提供 createSqlQueueBroker 与 createOptionalDistributedLimiter，也由 distributed-runtime.mjs re-export。

~~~js
const localLimit = createLimiter({disabled: disableRateLimits});
const limit = disableRateLimits ? localLimit :
  createOptionalDistributedLimiter({runtime, fallback: localLimit});
const broker = createSqlQueueBroker({
  runtime, database: rawDatabase, access,
  assertOwned: () => instanceLease.assertOwned(),
});
broker.start();
// 关闭平台数据库前：
await broker.close();
~~~

broker 仅在 runtime 和 Redis 都明确启用时工作。它 countActiveJobs 后用 listActiveJobs(total+1) 读取全部已提交活动任务，不使用最近100条窗口；过滤 due queued、有效重试次数与受支持任务类型，并从原始文档/来源/显式 payload 解析同一 agent，再按原始机构 owners 与配置 tenantId 过滤。成功唤醒会在本进程短时去重，Redis失败不会改动SQL任务，重启可重复发布提示，SQL claim仍防止同一任务重复执行。原SQL轮询必须保留。close 停止定时器并等待当前分发返回。

无Redis时限流中间件直接返回现有local limiter；启用Redis后共享计数，故障返回503，不降级绕过限流。超限返回429及Retry-After。根服务需将实际 limit 工厂替换为此包装器；仅创建 runtime/status 路由不能视为已接入共享限流。

新增5项仿真集成通过：132个已提交SQL任务完整扫描和跨机构过滤、Redis失败后SQL不丢且可重发、重启重复提示但权威任务只执行一次、close等待与锁门禁、真实中间件跨实例限流及Redis失败503。加上原9项协议测试共14项。本节仍是本地SQL+Redis协议仿真，不等同外部Redis实联，multiWorkerReady保持false。
