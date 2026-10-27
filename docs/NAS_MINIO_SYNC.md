# NAS 到 MinIO 知识库同步 Worker

此 Worker 将绿联 NAS 的只读目录按“一级目录 = 一个智能体对象前缀”增量写入专用 MinIO bucket。它与平台 API 分进程运行，不修改 NAS 文件，也不复用媒体 bucket。

```text
/srv/agent-knowledge/<一级目录>/<相对文件>
                         ↓
s3://agent-knowledge/knowledge/<一级目录或映射前缀>/<相对文件>
                         ↓
后台为智能体绑定同名 S3 source.path，审核后进入 RAG
```

默认行为是单向上传或覆盖，绝不因本地文件消失而删除远端对象。源目录在容器内以只读方式挂载。

## 准备目录与映射

在自己管理的 NAS 上准备知识目录，例如 `/srv/agent-knowledge`。每个一级子目录只存放一个智能体的授权资料；实际路径、目录数量和 slug 由部署者自行配置，不依赖任何既有 NAS。

`nas-sync-worker/agent-map.example.json` 是映射格式示例。首次运行前，将其替换为本部署的“源目录名 → 已创建智能体 slug”映射，或指定自己的映射文件。保持 `NAS_TO_S3_REQUIRE_AGENT_MAP=true` 时，未映射目录只计入状态，不会上传。先在后台创建相应智能体，再核对目录与对象前缀。

映射文件的源目录键不能在 NFC 规范化后重名；不同智能体的目标前缀也不能只以 Unicode 规范化或大小写区分。扫描时还会对“显式映射 + 默认前缀”的组合做同样的保守检查，与平台 S3 source scope 的 NFC+大小写无关比较保持一致。

## 安全与一致性规则

- 只同步平台 RAG 当前可解析的 `.pdf`、`.docx`、`.txt`、`.md`、`.markdown`、`.csv`、`.html`、`.htm`、`.json`。旧 `.doc`、PPT、Excel、压缩包和音视频默认跳过，应先转换为受支持格式。
- 从文件系统根到 NAS 源根、每个一级智能体目录和嵌套目录都记录 `realpath` 及设备/节点身份，在遍历前后复核。任一祖先为符号链接/junction、目录被替换或解析出已锚定的智能体根时均 fail-closed。发现符号链接或无法确认的分支后，整轮标记为不完整并禁止删除。
- 进入每层目录前会先对所有同层名称分组；如 `é.txt` 与 `é.txt` 在 NFC 规范化后相同，整组文件/目录都不会进入状态清单或对象 key，本轮同时标记为不完整且禁止删除。一级智能体目录也执行同一检查，不会先处理其中一项再发现碰撞。
- 文件须达到最小静置时间。读取使用 `O_NOFOLLOW` 文件句柄，在打开、读取前后复核文件身份、大小、mtime 及目录锚点；Linux 上还通过 `/proc/self/fd` 确认已打开句柄仍在智能体根内。单文件上限固定不超过 50 MiB，与平台导入边界一致。
- 使用 SHA-256 写入对象 metadata；上传后执行 HEAD，只有长度与 SHA-256 都一致才记为成功。
- `NAS_S3_PREFIX` 必须是非空对象前缀。状态清单原子写入 `/state/manifest.json`，权限为 `0600`。清单只含对象键、摘要、大小、时间、脱敏错误和不可逆的存储命名空间摘要，不含 S3 凭据。摘要绑定 canonical endpoint、region、bucket、对象前缀与命名空间标识；切换后端、全局前缀或租户时旧清单会 fail-closed。清单中的每个文件键、待迁移键和孤儿键还必须严格位于 `${NAS_S3_PREFIX}/` 下；文件记录的 key 必须能由 sourceRelative、agentDirectory 和 agentPrefix 重新派生，重复或冲突记录同样拒绝。全部检查在创建 S3 客户端及任何 HEAD/PUT/DELETE 前完成。应显式设置稳定、非秘密的 `NAS_TO_S3_STORE_ID`，这样同一命名空间内可安全轮换 Access Key；未设置时会退化为 Access Key 的不可逆摘要，换 Key 也会触发 fail-closed。
- 相同 size+mtime 只能短期快速跳过；`NAS_TO_S3_REHASH_AFTER_SECONDS` 默认每小时强制重算 SHA-256（设为 `0` 则每轮重算），因而不会永久漏掉伪装成相同 size+mtime 的内容变更。mtime 变化但摘要相同时不重复上传。
- AWS Node HTTP handler 同时设置连接、请求和 socket 超时，外层 `NAS_TO_S3_OPERATION_TIMEOUT_MS` 是每次 S3 调用的硬 deadline。失败按指数退避重试；`SIGTERM`/`SIGINT` 会中止当前调用并等待句柄与健康服务关闭。
- 平台读取器优先使用 `If-Match` 和 `If-Unmodified-Since` 条件 GET。针对部分 MinIO 兼容网关把条件 GET 错误返回为 HTTP 400 `AccessDenied` 的情况，只对该精确响应在同一总超时预算内重试一次无条件 GET，并继续严格比对响应 ETag、修改时间和大小；真正的 401/403 权限错误不会回退。
- 扫描超限、目录读取失败、源挂载身份变化或源根为空时，自动禁止删除。
- 删除只针对清单中由本 Worker 管理、且确认已从源端消失的对象。必须同时设置稳定且非秘密的 `NAS_TO_S3_STORE_ID`、`NAS_TO_S3_DELETE_REMOTE=true` 和 `NAS_TO_S3_DELETE_CONFIRM=DELETE_MISSING_MANAGED_OBJECTS`；一般保持关闭。旧版未绑定命名空间且已有受管对象的状态清单不会自动认领，须人工核验迁移或改用新状态卷。
- 智能体目录映射迁移会先验证新 key；迁移失败时清单仍保留旧 key 并记录待处理新 key，成功后旧 key 转入受管孤儿列表。默认不删除孤儿对象；只有上述双开关开启且本轮锚点/扫描完整时才会删除。全局 `NAS_S3_PREFIX` 不做自动迁移；修改它必须人工核验并迁移清单，或改用新的状态卷。

Node 没有为该遍历链提供可移植的 `openat(2)` 式目录句柄 API，所以目录锚定是可验证的 fail-closed 防线，不是对恶意高频竞态的唯一边界。上线前必须将知识源目录设置为仅受信上传账号可写、Worker 账号只读，并限制所有祖先目录的改名/替换权限。

## 首次 dry-run

准备专用 bucket `agent-knowledge`，为 Worker 创建仅拥有该 bucket 指定前缀 `s3:ListBucket`、`s3:GetObject`、`s3:PutObject` 权限的独立服务账号。默认不需要 `s3:DeleteObject`；只有启用安全删除时才授予。

凭据只放在进程环境或权限受控的专用 env 文件，不能写进映射 JSON、Compose、源码或日志。不要复用平台管理员、AI 模型或 MinIO root 凭据。

先在仓库根目录执行 `npm ci`。原生 Node 运行还须把 `NAS_TO_S3_SOURCE_ROOT`、`NAS_TO_S3_STATE_DIR` 和 `NAS_TO_S3_AGENT_MAP_FILE` 改为本机可读取的实际路径；不要照用容器中的 `/nas/knowledge`、`/state` 或 `/app/...`。

原生 Node：

```sh
cp nas-sync-worker/env.example nas-sync-worker/.env.nas-sync
# 编辑源目录、状态目录、映射、S3 端点和独立凭据；env 文件仅运行账号可读
node --env-file=nas-sync-worker/.env.nas-sync nas-sync-worker/index.mjs --once --dry-run
```

确认 JSON 摘要中的 `plannedUploads`、`ignored`、`scanErrors` 与目录预期一致后，再移除 `--dry-run`。`--once` 只扫描一轮；常驻模式按 `NAS_TO_S3_SCAN_INTERVAL_SECONDS` 周期串行运行，不会重叠扫描。

## Docker Compose

Worker 使用项目根依赖中的 AWS S3 SDK。构建上下文必须是项目根目录：

```sh
cp nas-sync-worker/env.example nas-sync-worker/.env.nas-sync
chmod 600 nas-sync-worker/.env.nas-sync
docker compose --env-file nas-sync-worker/.env.nas-sync -f nas-sync-worker/compose.yml build

# 先做一次性 dry-run，不启动常驻服务
docker compose --env-file nas-sync-worker/.env.nas-sync -f nas-sync-worker/compose.yml run --rm nas-minio-sync node nas-sync-worker/index.mjs --once --dry-run

# 核对结果后启动
docker compose --env-file nas-sync-worker/.env.nas-sync -f nas-sync-worker/compose.yml up -d
docker compose --env-file nas-sync-worker/.env.nas-sync -f nas-sync-worker/compose.yml ps
```

此 Compose 面向 Linux NAS，使用 `network_mode: host`。在专用 env 文件中，把 `NAS_TO_S3_HOST_SOURCE` 改为自己的宿主机知识目录，并配置自己的 `NAS_S3_ENDPOINT`。若 MinIO 与 Worker 在同一宿主机，可使用该主机实际的回环监听地址；跨主机连接使用受保护的 HTTPS 端点，例如 `https://minio.example.com`。bridge 模式下容器自己的 `127.0.0.1` 并不是宿主机，切换网络模式时必须同步调整端点。

Compose 使用 `create_host_path: false`，源路径写错时会失败，不会静默创建空目录；容器根文件系统只读、capabilities 全部移除，NAS bind mount 为只读。状态保存在独立命名卷 `nas-minio-sync-state`，升级镜像时不能删除该卷。

`/healthz` 是进程存活检查：普通扫描失败、扫描不完整或正在运行时仍返回 HTTP 200，但脱敏响应中的 `status` 为 `degraded`。`/readyz` 只在最后一轮 `scanComplete=true`、`failed=0` 且当前没有运行中任务/错误时返回 200；否则返回 503 + `degraded`，后续成功轮次会恢复。运行循环超过 `NAS_TO_S3_HEALTH_STALL_SECONDS` 无任何进展、本轮出现 S3 硬 deadline，或进程正在退出时，两个端点都返回 503。`NAS_TO_S3_HEALTH_STALL_SECONDS` 必须大于单次 S3 deadline。即使采用 host 网络，健康服务仍只监听宿主回环 `127.0.0.1:8790`，不会对局域网或公网开放；健康响应只有固定字段汇总、错误数量和通用错误码，不返回源文件路径或错误正文。

常驻进程的 stdout/stderr JSON 是运维审计日志，其完整 `scanErrors` 或文件系统错误正文可能含 NAS 本地的绝对或相对文件路径。这些日志只能保存在 NAS 本机的受限日志驱动/运维系统，不得公开转发；如需对外监控，只采集已脱敏的健康接口指标。S3 凭据不会进入状态清单、健康响应或日志。

## 可选：Linux 原生 Node 定时运行

不使用 Docker 时，可在受控 Linux 账号下部署 Node 24 Worker。仓库的 `run-scheduled.sh` 需要按实际目录和 Node 可执行文件调整，并依赖 `atd`、`atq` 与 `flock`；安装并启用这些工具后，可用专用 `n` 队列自重排。脚本先在短时 `schedule.lock` 内确认专用队列没有待执行任务，再提交 5 分钟后的下一轮；随后在独立 `run.lock` 下执行一次 `--once`。即使单轮超过 5 分钟，下一次作业也会继续续排，但会因 `flock -n` 跳过重叠执行。

该方式不依赖 SSH 会话；重启后的队列恢复取决于本机 `atd` 的持久化和启动配置，需要部署者验证。也可使用系统定时服务运行一次性 `--once` 任务，并保证不与已有常驻 Worker 重叠。凭据仍只从 `0600` 的 `.env.nas-sync` 读取。

## 与后台绑定

全局 `NAS_S3_PREFIX` 设为 `knowledge`。每个后台 S3 数据源仍由管理员明确绑定到智能体：

- 未使用映射：`source.path` 填 NAS 一级目录原名，例如 `数字(智)唐劲松医生`。
- 使用映射：`source.path` 填映射后的前缀，例如 `tang-jinsong`。

Worker 不根据姓名猜 slug，也不自动发布或审核知识。MinIO 同步成功后，后台扫描器只读取该数据源的对象，进入待审核区；这样目录映射错误不会把资料静默发布给错误智能体。

首次上线至少验证：中文多层路径、小文件更新、上传中断重试、同内容不重复上传、未映射目录隔离、源挂载临时不可用不删除、后台 source.path 只能看到对应智能体前缀。

## 独立部署验收记录

每次新部署应记录自己的扫描时间、映射范围、计划上传数、实际上传数、失败/跳过原因和审核状态。成功上传对象只证明同步完成；仍需在平台确认解析、审核、智能体隔离和问答引用。运行主平台的要求见 [DEPLOYMENT.md](DEPLOYMENT.md)。
