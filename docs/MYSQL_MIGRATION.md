# SQLite 切换到阿里云 RDS MySQL

平台在未配置 `DATABASE_URL` 时继续使用 SQLite；配置后使用 MySQL。`MYSQL_SSL_MODE` 支持 `required` 和 `disabled`，默认或留空为 `required`。`required` 保持证书与主机名校验，不能用自定义 `servername` 绕过；经确认的可信内网连接可显式设置 `disabled`，此时连接不加密且不需要 CA。程序不会在 TLS 失败后自动降级为明文。

## 前置条件

- MySQL 8.0.16 或更高版本，目标数据库必须完全为空。
- 可使用已授权的现有共享账号；本平台迁移和运行的数据库范围仅限 URL 指定的 `agent` 库。不得修改共享账号的密码、权限或其它数据库，不因迁移自动创建账号。
- 使用 RDS 内网地址前，从实际应用宿主机确认它解析到预期私网地址且 TCP 3306 可达；选择 `disabled` 时显式配置该模式。不要因内网不可达而自动换成公网明文地址。
- 使用 `required` 时，在 RDS 控制台启用 SSL，下载阿里云 CA 链并保存为权限受控文件，保证实际运行用户可读取。启用 MySQL 8.0 SSL 可能触发实例重启或主备切换，应安排在低峰窗口。
- 密码按 URL 规范编码；连接串和 CA 只放在权限受控的环境文件，不写入仓库、发布包、日志或命令历史。
- 保留最后一份 SQLite 一致性备份和旧镜像，直到业务验收和回滚保留期结束。

以下示例只表示格式，不可照抄账号。内网不加密模式：

```dotenv
DATABASE_URL=mysql://<user>:<url-encoded-password>@<rds-internal-host>:3306/agent
MYSQL_SSL_MODE=disabled
PLATFORM_DATA_PATH=/opt/medtalent-agent-platform/data-mysql
EXPECTED_EMBEDDING_DIMENSIONS=256
```

`compose.mysql.yml` 只传递数据库 URL 和 SSL 模式，不强制挂载 CA。若迁移后的 blob 位于新的宿主机目录，Docker 必须同时叠加 MySQL 和数据绑定覆盖文件；`DATA_DIR` 在基础 Compose 中固定为 `/app/data`，仅修改宿主机环境变量并不会替换命名卷：

```sh
docker compose --env-file .env.local -f compose.yml -f compose.mysql.yml -f compose.data-bind.yml config --quiet
docker compose --env-file .env.local -f compose.yml -f compose.mysql.yml -f compose.data-bind.yml up -d platform
```

使用 TLS 时，将模式和证书配置为：

```dotenv
MYSQL_SSL_MODE=required
MYSQL_SSL_CA_PATH=/opt/medtalent-agent-platform/secrets/ApsaraDB-CA-Chain.pem
MYSQL_SSL_CA_FILE=/opt/medtalent-agent-platform/secrets/ApsaraDB-CA-Chain.pem
```

`MYSQL_SSL_CA_FILE` 是宿主机直接运行 npm 脚本时读取的绝对路径。额外的 `compose.mysql-tls.yml` 会把同一个 `MYSQL_SSL_CA_PATH` 只读挂载进容器，将容器内 `MYSQL_SSL_CA_FILE` 覆盖为 `/run/secrets/mysql-ca.pem`，并固定模式为 `required`；不要把容器路径用于宿主机命令。TLS 容器命令为：

```sh
docker compose --env-file .env.local -f compose.yml -f compose.mysql.yml -f compose.mysql-tls.yml -f compose.data-bind.yml config --quiet
docker compose --env-file .env.local -f compose.yml -f compose.mysql.yml -f compose.mysql-tls.yml -f compose.data-bind.yml up -d platform
```

后续启动、停止、日志、备份和更新必须保持所选模式的完整 `-f` 参数组合。也可以继续使用原 `platform-data` 命名卷中的 uploads，但一次性迁移命令和候选容器必须明确挂载同一卷并通过 blob 零差异校验；不得把宿主机新目录与容器旧卷混用。

## 一次性迁移

1. 暂停 NAS 外部调度和所有写入入口，等待任务、同步运行和自动发布来源均归零，再停止旧平台容器。
2. 在未设置 `DATABASE_URL` 的环境中执行 `npm run backup`，得到带完整 `manifest.json`、`platform.sqlite` 和 `uploads/` 的最终 SQLite 快照。
3. 创建一个新的宿主机平台数据目录，将该快照的 `uploads/` 原样复制到新目录的 `uploads/`，设置 `PLATFORM_DATA_PATH` 并在候选容器中叠加 `compose.data-bind.yml`。不要复用或覆盖旧在线目录。
4. 设置 `MIGRATION_SOURCE_DIR` 为最终 SQLite 快照目录，设置 `DATA_DIR` 为新平台数据目录，并配置 `DATABASE_URL`、`MYSQL_SSL_MODE` 和预期向量维度；`required` 模式还须配置当前执行环境的 CA 文件。
5. 在宿主机执行 `npm run migrate:mysql`；若使用候选镜像，则以同一组 Compose 覆盖文件执行 `docker compose ... run --rm --no-deps platform npm run migrate:mysql`。脚本要求源快照静止、blob 全量一致、目标 MySQL 为空；导入在事务中完成，并在提交前后校验表级摘要、序列、JSON、外键、业务不变量、向量和 blob。
6. 以相同运行环境单独执行 `npm run verify:mysql`。只有输出 `ok:true`、`code:SQLITE_MYSQL_ZERO_DIFF` 且所有表和 blob 均匹配时才能继续。
7. 先以 `WORKER_ENABLED=false` 启动候选实例，确认 `/api/health` 返回 `storage:MySQL`，再验收管理员登录、智能体列表、知识统计、已发布 RAG 问答和未审核资料隔离。
8. 验收通过后再开启工作器、恢复 NAS 调度和业务流量，持续观察健康、任务积压、错误率与 RDS 连接数。

任何一步失败都应保持旧 SQLite 服务和数据不变。目标 MySQL 导入只支持空库重试；失败后使用新的空数据库或经明确核准清空专用目标库，不能在未知现有数据上覆盖导入。

## 备份、恢复与管理员密码

- `npm run backup` 会按当前存储后端分派；显式 MySQL 命令是 `npm run backup:mysql`。
- MySQL 逻辑备份只在数据库和 blob 的一致性快照、运行时 schema 校验与摘要全部通过后发布完成 manifest。
- 用 `MYSQL_RESTORE_SOURCE_DIR` 指向完整 MySQL 逻辑备份，并在新的空数据库和空 `DATA_DIR` 上执行 `npm run restore:mysql`，随后执行只读的 `npm run verify:restore:mysql`。脚本拒绝旧格式、损坏、schema 不兼容或内容不一致的备份。
- `npm run reset-admin` 会按当前后端分派；显式 MySQL 命令是 `npm run reset-admin:mysql`。执行前必须停止平台，并通过受控交互设置 `RESET_ADMIN_PASSWORD`。

## COMMIT 与提交后验证

以下错误都表示当前目标不能清理或重跑，应用及 NAS 调度必须继续停止：

- `MYSQL_IMPORT_COMMIT_OUTCOME_UNKNOWN` / `MYSQL_RESTORE_COMMIT_OUTCOME_UNKNOWN`：客户端未收到可靠 COMMIT 回执，服务端可能已经提交；
- `MYSQL_IMPORT_POST_COMMIT_VERIFICATION_REQUIRED` / `MYSQL_RESTORE_POST_COMMIT_VERIFICATION_REQUIRED`：MySQL 已明确确认 COMMIT，但随后的数据库、租约或 blob 复核未完成。

SQLite 迁移立即执行只读 `npm run verify:mysql`；逻辑备份恢复立即执行只读 `npm run verify:restore:mysql`。只有对应零差错误码和 `ok:true` 才能视为成功。若验证失败或暂时无法连接，应继续隔离当前目标并调查，或改用另一个全空数据库及空数据目录重新执行，禁止在当前目标上覆盖、清理或直接重跑。

## 回滚边界

切换开放写入前，可停止候选实例并恢复旧镜像和旧 SQLite 数据卷。MySQL 接受新写入后，旧 SQLite 已不再是最新状态，不能直接切回；应优先修复 MySQL 服务，或从迁移后 MySQL 备份/时间点恢复，并为任何反向迁移单独停机、校验和审批。

MySQL 只替换结构化数据库。文档 blob、平台实例租约、任务工作器和进程内限流仍是单节点设计，不能据此直接启动多个应用副本。
