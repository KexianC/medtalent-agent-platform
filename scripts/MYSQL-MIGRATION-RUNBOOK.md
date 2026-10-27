# SQLite 到 MySQL 安全迁移与恢复

本流程要求应用和所有外部 NAS 调度器在迁移、恢复、最终校验期间保持停止。脚本会同时争用本地平台实例租约、blob maintenance 租约及 MySQL advisory lock；任一活动实例存在都会失败退出。

## 共同前提

- MySQL 必须为 8.0.16 或更高版本，目标必须是从未建表的专用空数据库；脚本不会清空、覆盖或修复非空目标。可复用已授权的共享账号，但迁移和运行只操作 URL 指定的 `agent` 库，不修改账号密码、权限或其它数据库，也不自动创建账号。
- `DATABASE_URL` 只能由受保护环境注入，不能作为命令行参数。`MYSQL_SSL_MODE` 仅支持 `required` 和 `disabled`，默认或留空为 `required`。远程 `required` 模式必须设置当前执行环境可读取的绝对 `MYSQL_SSL_CA_FILE`；宿主机使用宿主 CA 路径，`compose.mysql-tls.yml` 会在容器内覆盖为 `/run/secrets/mysql-ca.pem` 并固定为 `required`。TLS `servername` 固定使用 URL hostname，无法覆盖。经确认的可信内网不加密连接显式设置 `MYSQL_SSL_MODE=disabled`，无需 CA，不叠加 TLS 覆盖文件；TLS 失败不会自动降级。
- 使用内网地址前，从应用宿主机验证预期私网 DNS 结果和 TCP 3306 连通性，不因内网不通自动切换公网明文地址。
- `DATA_DIR/uploads` 必须是候选实例实际挂载的 blob 目录。迁移前它必须与 SQLite 完整备份中的引用 blob 清单精确一致。Docker 使用新的宿主机目录时，必须设置 `PLATFORM_DATA_PATH` 并在每条 Compose 命令中同时叠加 `compose.mysql.yml` 和 `compose.data-bind.yml`；仅修改宿主机 `DATA_DIR` 不会替换容器命名卷。
- 可选设置 `EXPECTED_EMBEDDING_DIMENSIONS`，对所有非空向量强制统一目标维度。
- 所有脚本只向终端输出固定错误码、计数及 SHA-256 摘要，不输出 URL、凭据、业务内容或文件路径。

## SQLite 切换窗口

1. 先停止新任务入口，等待 queued/running job 和 running sync 全部结束，并暂停所有 `autoPublish` NAS 源及外部调度器。
2. 在尚未设置 `DATABASE_URL` 的 SQLite 环境运行 `npm run backup`，仅选择 `manifest.completed=true` 的备份。
3. 停止应用进程，保持 NAS 调度器停止。创建新的候选数据目录，把最终备份的 `uploads/` 原样复制到该目录；设置 `MIGRATION_SOURCE_DIR` 指向完整备份，`DATA_DIR` 指向候选目录，同时设置目标 `DATABASE_URL`、`MYSQL_SSL_MODE`，并仅在 `required` 模式配置远程 CA。Docker 内网不加密模式使用 `compose.yml`、`compose.mysql.yml`、`compose.data-bind.yml`；TLS 模式额外叠加 `compose.mysql-tls.yml`，后续操作保持一致。
4. 运行导入：

   ```text
   npm run migrate:mysql
   ```

   脚本先验证 SQLite integrity/FK/JSON/向量/活动状态/blob，再确认 MySQL 全空；建结构后在单事务内显式写入每个 SQLite `rowid` 到 MySQL `seq`，提交前及提交后各做一次规范零差校验。

5. 应用仍保持停止，独立复核：

   ```text
   npm run verify:mysql
   ```

   仅当输出 `SQLITE_MYSQL_ZERO_DIFF`、`verified:true`、所有表 `matched:true`、`schemaMatched:true` 和 blob `matched:true` 时，才可启动 MySQL 版应用并恢复调度。

6. 首次对外写入前保留 SQLite 数据卷和完整备份。若验收失败，停止 MySQL 应用、撤掉 `DATABASE_URL`，可回到未被迁移脚本修改的 SQLite；MySQL 已承接新写入后不得直接回滚，否则会丢失差异写入。

## MySQL 逻辑备份

有 `DATABASE_URL` 时，原入口会自动分派到 MySQL 备份：

```text
npm run backup
```

新备份只有在运行时 schema、规范行摘要、JSON/FK/向量及引用 blob 均有效时才发布 `manifest.json`，并标记 `completed:true`、`restorable:true`、`kind:"logical-export-v1"`。NDJSON 和 uploads 含私有数据，必须使用加密存储及最小权限。

## 恢复与恢复演练

恢复使用一个全新的空 MySQL 数据库和空 `DATA_DIR/uploads`，设置 `MYSQL_RESTORE_SOURCE_DIR` 指向逻辑备份后运行：

```text
npm run restore:mysql
```

恢复前会重算每个 NDJSON 的 SHA-256、行数、`seq` 映射、aggregate、schema fingerprint、JSON/FK/向量/活动状态和 blob 清单。结构或目标非空即拒绝；事务提交前和提交后均要求零差。随后在应用仍停止时运行只读演练验证：

```text
npm run verify:restore:mysql
```

仅 `MYSQL_LOGICAL_RESTORE_ZERO_DIFF` 可作为恢复成功证据。

## COMMIT 回执不确定

若导入或恢复返回下列任一错误码，不要重跑、不要清理当前目标：

- `MYSQL_IMPORT_COMMIT_OUTCOME_UNKNOWN` / `MYSQL_RESTORE_COMMIT_OUTCOME_UNKNOWN`：连接断开可能发生在服务端已提交但客户端尚未收到回执之后；
- `MYSQL_IMPORT_POST_COMMIT_VERIFICATION_REQUIRED` / `MYSQL_RESTORE_POST_COMMIT_VERIFICATION_REQUIRED`：服务端已经明确确认提交，但随后数据库、租约或 blob 零差复核未能完成。

应用继续保持停止，并立即执行对应只读验证：

- SQLite 导入立即运行 `verify-sqlite-mysql-migration.mjs`；
- MySQL 恢复立即运行 `verify-mysql-backup-restore.mjs`。

验证为零差即可把结果视为已提交；验证失败或无法连接时继续隔离该目标，等待查明或使用另一个全空数据库和空数据目录重新执行，不要在当前目标上覆盖、清理或重跑。
