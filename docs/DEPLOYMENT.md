# 部署与运维

## 全新服务器快速开始（推荐 Docker，SQLite）

本文面向全新服务器独立部署。公开仓库只包含源码与示例配置；首次启动会在新数据卷初始化后台账号与默认医生资料。

准备一台可持久化磁盘的 Linux 服务器、Git、Docker Engine 与 Compose v2，以及自己的域名和 HTTPS 证书。平台只运行一个实例。构建需要从 npm 获取依赖、从镜像仓库获取 Node 镜像；模型和 NAS 都可稍后接入，不是启动必需项。公开仓库可直接克隆：

```sh
git clone https://github.com/KexianC/medtalent-agent-platform.git
cd medtalent-agent-platform
cp .env.example .env.local
chmod 600 .env.local
```

用编辑器修改 `.env.local`，至少设置以下值。密码用密码管理器生成，至少 12 个字符，不能沿用文档中的示例值；若密码含 `$` 或 `#` 等字符，按 Compose 环境文件规则使用单引号包裹。首次保持 `DATABASE_URL` 为空，使用随 Node 提供的 SQLite，无需另建数据库。

```dotenv
NODE_ENV=production
ADMIN_USERNAME=admin
ADMIN_PASSWORD='在此填写自己的随机强密码'
PUBLIC_URL=https://agents.example.com
TRUST_PROXY=true
DATABASE_URL=
```

`PUBLIC_URL` 填自己的 HTTPS Origin，不带子路径。以上 `TRUST_PROXY=true` 只适用于本机一层可信反向代理；其它网络拓扑需要单独配置。`.env.example` 中其它供应商密钥保持空白也能启动；未配模型时 AI 问答会明确报未配置，知识管理与关键词检索仍可用。不要将 `.env.local` 上传 GitHub。

```sh
docker compose --env-file .env.local up -d --build
docker compose --env-file .env.local ps
curl --fail http://127.0.0.1:8788/api/health
```

Compose 将服务绑定到服务器回环地址 `127.0.0.1:8788`。将自己的域名解析到服务器，在宿主机安装 Nginx 并参考 [nginx.conf.example](../nginx.conf.example) 配置 HTTPS，替换域名与证书路径后执行 `nginx -t`，通过后重载 Nginx。对外开放 HTTP/HTTPS；API 和前端由同一 Node 服务提供。若更改 `PLATFORM_PORT`，同步修改 Nginx 的上游端口。

完成后访问 `https://自己的域名/` 和 `https://自己的域名/admin`，用自己配置的管理员账号登录。管理员密码只在首次初始化时使用，之后修改环境文件不会改动已有账号密码。

新部署验收：

1. `curl --fail https://自己的域名/api/health` 成功，Compose 显示服务健康。
2. 浏览器能打开目录、医生空间和后台；退出登录后管理操作被拒绝。
3. 新建一个自己的测试智能体，保存、审核发布并确认前台可见；上传一份无敏感信息的测试文档，等待解析，人工审核后验证检索与引用。
4. 重启 `docker compose --env-file .env.local restart platform` 后，刚创建的智能体和文档仍存在。
5. 配置模型后验证真实问答；按下文执行停机备份，并在独立空目录完成一次恢复演练，再接入正式资料。

### 小程序连接到自己的服务

Web 平台可独立运行；微信小程序需要自己的小程序账号、AppID 和平台配置，仓库现有 AppID、运营主体、隐私邮箱与域名是原项目的公开配置，必须按实际运营方替换。

- 原生版：修改 `wechat-native/project.config.json` 的 `appid` 和 `wechat-native/config.js` 的 `apiOrigin`、主体及隐私信息；将 `wechat-native` 导入微信开发者工具，后端选“不使用云服务”。微信后台配置自有 API 的 request/downloadFile 合法域名；量表 PDF 的其它下载域名见 [原生导入说明](NATIVE_IMPORT_GUIDE.md)。
- WebView 版：修改 `wechat-miniprogram/project.config.json` 的 `appid` 和 `wechat-miniprogram/config.js` 的 `h5Origin`、主体及隐私信息；按 [WebView 工程说明](../wechat-miniprogram/README.md) 完成业务域名校验。
- 使用微信账户登录时，服务端配置同一个小程序的 `WECHAT_APP_ID` 与 `WECHAT_APP_SECRET`；AppSecret 只放服务端 `.env.local`。暂未开通登录时可将 `WECHAT_LOGIN_ENABLED=false`。修改环境后重新执行 Compose `up -d` 使配置生效。
- 已包含原生工程的本地资源，直接导入无需构建 npm。重新生成资源先在项目目录执行 `npm ci`、`npm run build:native`；官方模板检查需要安装微信开发者工具，并设置 `WECHAT_COMPILER_DIR` 指向其中含 `wcc.exe` / `wcsc.exe` 的目录。详见原生导入说明。

在自己账号中完成隐私指引、合法域名、真机录音/登录/下载验收后，才上传、提审和发布。GitHub 上传与本机构建不会自动发布小程序。

## 最小运行条件

- Node.js 24.4+；支持本地持久化磁盘的单进程Node服务。
- 平台HTTPS域名及反向代理；`PUBLIC_URL`与浏览器地址一致。
- 一套独立管理员强密码；真实模型、Embedding、语音按需配置。
- 可选 NAS 接入时，需来源可达：WebDAV只读账号、只读挂载，或私有 MinIO/S3 bucket 与只读服务身份。不能把NAS管理网页当文件接口。

此版本不是无状态边缘函数应用，也不能在只读/临时文件系统里持久化数据库。不要复用原demo的部署脚本、线上目录或域名配置。

`AI_API_KEY` / `DEEPSEEK_API_KEY`、`EMBEDDING_API_KEY` 与 `DASHSCOPE_API_KEY` 必须是 8—8192 位、无空白的可打印 ASCII 值。异常密钥会在启动时拒绝，不会尝试上游请求；真实值只放权限受控的环境文件或密钥管理系统。

向量模型按自己的供应商配置，示例采用 DashScope 原生协议。服务端仅在显式配置的环境变量中读取对应密钥；默认每批 8 条，并对网络异常、HTTP 408/425/429/5xx 做有界重试。模型名称、地域和维度必须按供应商实际支持的参数填写。发送前仅对 Embedding 输入执行 NFKC 与空白折叠，再按 Unicode code point 拆为不超过 225 字符的子段；子段向量按字符数加权平均并 L2 归一，数据库中仍保持一个知识片段对应一个向量：

```dotenv
EMBEDDING_API_URL=https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding
EMBEDDING_API_KEY=<自己的向量服务密钥>
EMBEDDING_MODEL=<自己的向量模型>
EMBEDDING_API_PROTOCOL=dashscope
EMBEDDING_DIMENSIONS=256
EMBEDDING_SEGMENT_CHARACTERS=225
EMBEDDING_BATCH_SIZE=8
EMBEDDING_MAX_RETRIES=2
```

`EMBEDDING_API_PROTOCOL` 只允许 `openai`（默认）或 `dashscope`。原生协议只发送 `model`、`input.texts`、`parameters.dimension` 和 `parameters.output_type=dense`，响应必须为 `output.embeddings`；每项必须带唯一的 `index` 或 `text_index`，两个字段同时出现时必须一致，平台绝不会按响应数组顺序猜测。协议与端点不匹配会安全降级为词法检索。

配置只影响后续索引。`EMBEDDING_SEGMENT_CHARACTERS` 允许 64—16,000；留空时仍会规范化 Embedding 输入但不拆段，不会改变原文、知识片段、引用正文或审核状态。已有词法文档及更改模型、协议或分段策略前生成的向量必须逐批执行重建，并以文档 `embeddingMode=hybrid`、向量模型和维度一致为成功条件；任务状态 `completed` 本身不能代替向量结果验收。批量重建应限制每波文档数与片段数，任何文档降级为词法模式时立即停止后续波次。

## 原生Node部署

1. 将本项目放入独立目录，准备单独数据目录和备份目录。
2. `npm ci`、`npm test`、`npm run build`。
3. 配置`.env.local`（文件权限限制为运行用户可读）：

```dotenv
NODE_ENV=production
PORT=8788
HOST=127.0.0.1
DATA_DIR=/srv/medtalent-data
PUBLIC_URL=https://agents.example.com
TRUST_PROXY=true
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-your-strong-password
```

4. 使用进程管理器启动`npm start`，只运行**一个实例**。不要使用cluster模式或两个副本共享DATA_DIR；平台会在打开SQLite前取得带UUID所有者、心跳和超时的 `.platform-instance.lock` 租约，第二个活动实例会明确拒绝启动。进程崩溃遗留的租约超过安全窗口后会自动恢复，而不是永久阻塞。
5. 参考根目录`nginx.conf.example`配置TLS和流式代理，保留Host并关闭响应缓冲。不要把`/api/admin/*`暴露为无鉴权静态文件。

`ADMIN_PASSWORD`只用于首次建库。已有账号改密用后台账号管理或`reset-admin`脚本，不会因环境变量改变静默覆盖密码。生产启动会拒绝已知开发/示例凭据。

## Docker Compose

根目录已提供多阶段构建、非root用户、只读根文件系统、仅本机监听端口、健康检查和持久化卷。

```sh
docker compose --env-file .env.local up -d --build
docker compose --env-file .env.local ps
docker compose --env-file .env.local logs --tail=100 platform
```

`platform-data`存 SQLite（启用时）与私有文档，`platform-backups`存备份。替换镜像不会丢数据，但不要执行删除数据卷的命令。容器始终用`/app/data`，宿主机`.env.local`里的`DATA_DIR`不会替换命名卷；需要独立宿主机数据目录时用`compose.data-bind.yml`与绝对路径`PLATFORM_DATA_PATH`。

使用 MySQL 时叠加 `compose.mysql.yml`，`MYSQL_SSL_MODE` 默认或留空均为 `required`；远程 TLS 连接再叠加 `compose.mysql-tls.yml`，把受控 CA 文件只读挂载。已确认可信内网且明确选择不加密时，设置 `MYSQL_SSL_MODE=disabled`，无需 CA，也不叠加 TLS 覆盖文件。启动、停止、日志、备份和更新命令必须保持同一覆盖文件组合。复用共享数据库账号时，迁移和运行只操作 URL 指定的 `agent` 数据库，不改账号密码、权限或其它数据库。完整的 SQLite → MySQL 停机迁移、零差异校验和回滚边界见 [MYSQL_MIGRATION.md](MYSQL_MIGRATION.md)。MySQL 只替换结构化数据库，`platform-data` 中的文档 blob、租约和单工作器仍不可多副本共享。

NAS本地模式额外使用`compose.nas-local.yml`，且先由管理员完成宿主机挂载；容器不自动获取SMB密码或系统挂载权限。使用任何覆盖文件后，后续启动、停止、备份、日志和恢复命令都必须带上同一组`-f`文件，避免切回默认数据卷。

MinIO/S3 模式无需给平台容器挂载 NAS 目录；在`.env.local`配置 `NAS_S3_ENDPOINT`、`NAS_S3_REGION`、`NAS_S3_BUCKET`、`NAS_S3_PREFIX`、`NAS_S3_FORCE_PATH_STYLE` 和平台专用只读凭据。若源文件仍是 NAS 普通目录，另在 NAS 按 [NAS 到 MinIO Worker](NAS_MINIO_SYNC.md) 部署独立同步容器。Worker 与平台必须使用不同服务身份，且不能复用 MinIO root 凭据。

Docker方案仍需外层TLS。生产Secure Cookie不会在普通HTTP浏览器会话下生效；无法登录时先检查HTTPS、PUBLIC_URL和反向代理Host。

## 更新流程

1. 完整备份并确认manifest完成标记。
2. 在独立测试数据目录运行测试与新构建，不直接使用业务数据试验。
3. 停止旧进程，部署新代码/镜像，启动单实例。
4. 检查健康、登录、已发布目录、任务恢复和一次检索。
5. 需要回退代码时，注意数据库版本兼容；若恢复数据，使用备份写入新数据目录再切换。

## 备份与恢复

备份前停止服务。当前完整备份包含 `private-config` 等私有文件，需要独占平台实例租约；默认运行会创建本地供应商加密密钥，不能对运行中的容器直接 `exec npm run backup`。

原生 Node：停止使用目标数据目录的服务后执行 `npm run backup`。Docker 使用挂载同一数据卷的一次性容器：

```sh
docker compose --env-file .env.local stop platform
docker compose --env-file .env.local run --rm --no-deps platform npm run backup
# 确认上一步退出成功并生成 completed=true 的 manifest，再重新启动
docker compose --env-file .env.local up -d platform
```

备份位于备份卷的 `/app/backups`，以命令返回的目录为准。服务恢复后可用 `docker compose --env-file .env.local cp platform:/app/backups/<已完成备份目录> ./backup-export` 导出到此前不存在的本地目录；加密转存到独立存储。叠加 MySQL、NAS 或数据目录覆盖文件的部署，每个命令均须使用原来的同一组 `-f` 文件。

命令会根据非空 `DATABASE_URL` 严格分派到 SQLite 或 MySQL；连接配置畸形时不会静默回落 SQLite。MySQL 也可显式执行 `npm run backup:mysql`，恢复与只读复核分别使用 `npm run restore:mysql` 和 `npm run verify:restore:mysql`。

SQLite 备份脚本利用 Node SQLite backup API 创建一致性快照，在私有快照上执行 `wal_checkpoint(TRUNCATE)`、切换为 `journal_mode=DELETE` 并通过 `integrity_check`，随后复制快照引用的不可变原文件。成功目录包含 `platform.sqlite`、`uploads/`、`manifest.json`，以及 manifest 中记录的私有文件目录（如 `private-config/`）；不依赖 `platform.sqlite-wal` 或 `platform.sqlite-shm`；发现非零 WAL 或无法收口的 sidecar 会失败关闭。MySQL 备份则在一致性只读事务中导出业务表，并同时验证运行时 schema、规范行摘要、序列、JSON、外键、业务不变量、向量及 blob；成功目录包含 `mysql/`、`uploads/`、私有文件目录和最后发布的 `manifest.json`。两种备份都通过 `DATA_DIR/.blob-maintenance.lock` 与无引用 blob 回收互斥，任何租约失权、摘要或文件不一致都不会发布完成标记。 [Node SQLite backup 文档](https://nodejs.org/docs/latest-v24.x/api/sqlite.html#sqlitebackupsource-db-path-options)

平台实例若检测到自身租约或 MySQL 单实例锁被替换、过期或无法续租，会停止知识工作器、拒绝 API 并关闭当前数据库连接；健康接口返回 503。旧实例释放时会同时复核 owner token 与锁目录身份，不能删除新实例的租约。进程管理器可在旧进程退出后重启，但不应绕过租约并行运行。`DATA_DIR` 所在文件系统必须支持原子创建目录、可靠 mtime 与重命名；不要把 SQLite 数据或文档 blob 放在不满足这些语义的对象存储或不可靠网络共享中。

备份包含知识正文、NAS相对路径、用户密码哈希、会话哈希以及私有配置。后台保存的供应商凭据及其本地加密密钥也可能包含在备份中，须作为密钥材料加密异地保存。环境变量中的 NAS/模型密码不由备份脚本归档；`.env.local` 与外部注入的 `PROVIDER_ENCRYPTION_KEY` 需要通过密码管理器或单独受控方式备份，不能公开放进源码包。

恢复不提供“一键覆盖正在运行数据库”按钮。SQLite 原生 Node：停止服务，将 `SQLITE_RESTORE_SOURCE_DIR` 指向完整备份，把 `DATA_DIR` 指向**新的空目录**，执行 `node --env-file-if-exists=.env.local scripts/restore-backup.mjs`。脚本检查 manifest、数据库、原件和私有文件摘要后才恢复，输出 `SQLITE_RESTORE_ZERO_DIFF` 表示通过；随后切换服务的 `DATA_DIR`。需要撤销旧会话时，通过账号管理重新设置密码或使用 `reset-admin`。

Docker 默认使用命名卷，不能只修改 `DATA_DIR` 完成恢复。SQLite 恢复流程如下；MySQL 使用 [专用恢复流程](MYSQL_MIGRATION.md)。保留旧卷，恢复到单独的新目录：

1. 从备份卷导出一份已完成的完整备份到全新的宿主机目录，例如 `docker compose --env-file .env.local cp platform:/app/backups/<已完成备份目录> ./backup-export`。保留其中所有文件和私有目录，不仅是数据库与 uploads。
2. 准备一个新的空宿主机目录，例如 `/srv/medtalent-restored-data`。为容器运行用户 UID/GID 1000 授予这个独立目标目录的读写权限和源备份的读取权限；不要扩大权限到其它数据。
3. 停止旧服务（保留卷）：`docker compose --env-file .env.local stop platform`。
4. 运行一次性校验/恢复容器。以下是 Linux 示例；替换实际路径，备份源必须是完整备份目录，目标必须是空目录：

```sh
docker compose --env-file .env.local run --rm --no-deps \
  -v "$PWD/backup-export:/backup-source:ro" \
  -v "/srv/medtalent-restored-data:/restore-target" \
  -e SQLITE_RESTORE_SOURCE_DIR=/backup-source \
  -e DATA_DIR=/restore-target \
  platform node scripts/restore-backup.mjs
```

5. 只有返回 `SQLITE_RESTORE_ZERO_DIFF` 才继续。将 `.env.local` 中 `PLATFORM_DATA_PATH` 设为已恢复目录的绝对路径，使用 `docker compose --env-file .env.local -f compose.yml -f compose.data-bind.yml up -d platform` 启动。原部署有其它覆盖文件时，上述所有命令均须带同一组覆盖文件。
6. 验证登录、目录、知识检索与任务后再恢复业务流量。以后始终使用相同覆盖文件。回退旧卷时先停止新实例，再移除数据绑定覆盖文件启动；不要让新旧实例同时服务或共享同一数据目录。

该覆盖文件要求宿主机目录已存在，路径写错会报错，不会静默新建空库。备份应定期导出到独立加密存储，仅存于同一宿主机不构成灾难恢复。

## 管理员密码重置

原生 Node：必须先停止使用目标 `DATA_DIR` 和数据库的平台服务，再使用本机受控终端设置 `RESET_ADMIN_PASSWORD`，可选 `RESET_ADMIN_USERNAME`，确认 `DATA_DIR` 与 `DATABASE_URL` 指向目标后执行 `npm run reset-admin`。脚本按后端分派，并取得平台实例租约；MySQL 还会取得服务端单实例锁、校验 schema 并串行锁定写 guard。如有活动实例则明确失败且不更改数据。PowerShell 7 可使用掩码输入（密码值不进入命令历史）：

```powershell
$env:RESET_ADMIN_PASSWORD = Read-Host -MaskInput '输入新的独立强密码'
try { npm run reset-admin } finally { Remove-Item Env:RESET_ADMIN_PASSWORD }
```

Windows PowerShell 5.1 不支持`-MaskInput`，可用密码管理器进行受控环境注入，不建议把真实密码直接写进命令。

Docker：在受控终端注入同一变量后，先停止服务，再启动一个仅执行重置脚本的容器，确保它挂载**同一数据卷**：

```sh
docker compose --env-file .env.local stop platform
docker compose --env-file .env.local run --rm --no-deps -e RESET_ADMIN_PASSWORD platform node scripts/reset-admin.mjs
docker compose --env-file .env.local up -d platform
```

如需要其它管理员，增加`-e RESET_ADMIN_USERNAME`并提前注入对应值。如果使用了数据/NAS覆盖文件，上面每个命令都要带同一组`-f`；不要在宿主机执行`npm run reset-admin`来代替容器重置。脚本退出成功后再启动服务，并清除临时密码环境变量。

脚本不会打印密码，不创建新账号，也不会把普通成员升级成admin；仅更新指定已有管理员并撤销其会话。密码虽使用掩码输入，仍会短暂存在当前进程环境中，只应在受控运维会话使用。

## 资源与容量

- 单文档50 MB、抽取正文200万字符、最多3000片段；扫描件需先OCR。
- PDF/DOCX/文本解析在独立 Node 子进程执行：V8 old-space 限制 640 MiB、默认超时45秒（硬上限60秒）、stdout 32 MiB、stderr 64 KiB，且不继承服务端密钥。解析器崩溃、超时或超限只会让当前文档失败，不会终止平台主进程。
- 后台任务最多自动尝试3次；服务重启时已耗尽次数的任务会原子收口为失败并释放对应文档状态，不会无限重放。管理员显式重试会开启一个新的、有界的尝试周期。
- 平台默认每个知识来源最多5000份、10 GiB，每个智能体最多10000份、20 GiB；分别用 `KNOWLEDGE_MAX_DOCUMENTS_PER_SOURCE`、`KNOWLEDGE_MAX_BYTES_PER_SOURCE`、`KNOWLEDGE_MAX_DOCUMENTS_PER_AGENT`、`KNOWLEDGE_MAX_BYTES_PER_AGENT` 调整。配额统计排除已软删除文档，文档更新按替换后的大小计算，并在写盘前及SQLite事务内各校验一次。
- 文档新版本提交后，旧不可变 blob 只有在数据库确认已无任何文档引用时才删除；正在执行的知识任务会让回收延后到任务结束。删除失败会保留待回收项并在后续任务重试，服务启动后的首次空闲扫描也会回收崩溃遗留的无引用 blob。软删除保留文档元数据和审计记录，但释放原件引用及配额。
- 每智能体单节点检索最多25000已生效片段，超出明确报错而非忽略后续资料。
- NAS扫描默认5000文件/12层/60秒，每轮导入默认100个变更/60秒，未完成会显示partial并在下个周期继续。
- 请求速率限制在进程内存，适用于单节点。平台实例租约用于拒绝误启动的共享DATA_DIR副本，不把SQLite转换为多节点数据库；公网应另配网关限流、访问日志、告警和磁盘配额。
- 当前已支持把 MinIO/S3 作为 NAS 读取来源，但平台导入后的文档 blob 仍保存在 `DATA_DIR`；没有分布式锁、Redis队列、多组织租户/计费或自动证书申请。高并发、大知识库及平台 blob 外置对象存储应单独规划。

## 上线前验收

- 运行全部自动化测试、TypeScript检查、生产构建。
- 配置真实模型，确认普通/流式问答与AI建档输出；确认密钥不出现在浏览器网络响应或构建文件中。
- 按NAS文档验证新建、更新、审核、隔离、故障保护；同时测试Embedding模型变化后的重新索引。
- 检查所有医生身份、肖像、文案、内容来源授权与医疗安全边界，不把AI草稿当已核实事实。
- 为知识库资料和外部模型发送制定数据分类/保留制度；患者病历不应进入公开问答库。
- 完成一次备份与**独立目录恢复演练**，确认服务账号权限和持久化卷。
