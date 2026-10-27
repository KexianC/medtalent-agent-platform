# 绿联 NAS 自动同步

## 接入边界

平台支持三种只读来源：UGOS Pro WebDAV、操作系统已挂载的 SMB/NFS 目录，以及 MinIO/S3 对象前缀。不是模拟登录“绿联云”网页，也不依赖未经公开的私有 API。无固定公网 IP 且已有 MinIO/FRP 的现场，推荐由 NAS 本地 Worker 把授权目录增量写入私有 bucket，平台再通过 HTTPS S3 API 读取；真实设备仍需完成网络、TLS、账号与目录验收。

绿联官方 WebDAV 开启路径为“控制面板 → 文件服务 → WebDAV”，文档默认 HTTP 5005、HTTPS 5006，实际端口以设备配置为准。[官方 WebDAV 教程](https://www.ugnas.com/tutorial-detail/id-223.html)；账号共享目录权限参考[官方文件服务说明](https://support.ugnas.com/detail/article/zh-CN/77)。

## 方案一：WebDAV（优先）

1. NAS 新建专用账号，例如 `agent-reader`，只允许读取要导入的共享目录，不授予写入、删除或管理员权限。
2. 开启 WebDAV，确认服务器能通过内网/VPN到达。建议使用 HTTPS 和有效证书，不公开暴露不必要的 NAS 管理端口。
3. 在平台 `.env.local` 配置：

```dotenv
NAS_WEBDAV_URL=https://nas.internal.example:5006/
NAS_WEBDAV_USERNAME=agent-reader
NAS_WEBDAV_PASSWORD=your-secret
```

4. 重启平台。后台“系统设置”只显示连接是否配置，不显示密码。
5. 新建如下映射（相对路径以账号实际可见的 WebDAV 根目录为准）：

| 映射 | 智能体标识 | 相对目录 | 同步策略 |
| --- | --- | --- | --- |
| 唐医生审核资料 | tang-jinsong | AgentKnowledge/tang-jinsong | 每5分钟，导入后待审核 |
| 傅医生审核资料 | fu-junfen | AgentKnowledge/fu-junfen | 每5分钟，导入后待审核 |
| 新助手资料 | 后台创建的slug | AgentKnowledge/new-assistant | 每10分钟，导入后待审核 |

路径可含中文；不要填写 `/volume1/...` 这样的设备系统绝对路径，也不要填 `smb://...` 或完整网页URL。若连接根URL已包含 `AgentKnowledge/`，映射只需 `tang-jinsong` 等相对目录。

6. 点击“测试连接”，确认示例路径属于期望目录，再点击“立即同步”。

客户端使用 `PROPFIND Depth:1` 递归列目录和 `GET` 下载，不发送 PUT、DELETE、MOVE、MKCOL。不会跟随重定向，不把认证信息转发到其他源。公开暴露的链接/目录逃逸会被拒绝；若 NAS 把底层符号链接透明呈现成普通文件，协议无法辨别，所以账号共享权限仍是最终隔离边界。

## 方案二：服务器只读挂载共享

先由管理员通过操作系统挂载 SMB/NFS 共享，例如 Linux `/mnt/ugreen/AgentKnowledge` 或 Windows `Z:/AgentKnowledge`。平台不保管 SMB 挂载密码，也不会自动执行系统挂载命令。

```dotenv
NAS_LOCAL_ROOT=/mnt/ugreen/AgentKnowledge
```

后台连接方式选择“挂载目录”，映射填写 `tang-jinsong` 等相对路径。平台拒绝符号链接/junction 和目录穿越；NAS根目录本身也必须是实际挂载目录，不是指向其他目录的链接。

Docker 使用宿主机已挂载目录：

```dotenv
NAS_MOUNT_PATH=/mnt/ugreen/AgentKnowledge
```

```sh
docker compose --env-file .env.local -f compose.yml -f compose.nas-local.yml up -d --build
```

容器将其只读挂载为 `/mnt/nas`；需要确保容器用户有目录读取和遍历权限。

## 方案三：NAS 本地 Worker → MinIO / S3

这个方案适用于平台服务器无法稳定直连 NAS、但 NAS 已通过 MinIO/FRP 提供稳定对象存储入口的情况。它由两个独立权限面组成：

1. NAS Worker 只读访问知识目录，并仅向专用 bucket/prefix 写入对象。
2. 平台只拥有专用 bucket/prefix 的 `ListBucket` 与 `GetObject` 权限，不拥有上传、删除或 MinIO 管理权限。

先创建私有 bucket（例如 `agent-knowledge`），不要复用媒体 bucket。NAS Worker 的完整配置、Docker 安全选项、dry-run、目录映射和删除保护见 [NAS_MINIO_SYNC.md](NAS_MINIO_SYNC.md)。平台配置示例：

```dotenv
NAS_S3_ENDPOINT=https://minio.example.com
NAS_S3_REGION=us-east-1
NAS_S3_BUCKET=agent-knowledge
NAS_S3_PREFIX=knowledge
NAS_S3_FORCE_PATH_STYLE=true
NAS_S3_ACCESS_KEY_ID=platform-readonly
NAS_S3_SECRET_ACCESS_KEY=your-secret
```

Endpoint 必须是不含用户名、密码、查询参数和额外路径的 HTTP(S) 根地址。生产跨公网必须使用有效 HTTPS 证书；Access Key、Secret Key 与可选 Session Token 只从服务端环境读取，不写入 source、SQLite 或浏览器响应。

后台连接方式选择“MinIO / S3”，`source.path` 必须填写相对于全局 `NAS_S3_PREFIX` 的非空对象前缀，不能把整个全局根前缀绑定给单个智能体。例如 Worker 把资料写为 `knowledge/tang-jinsong/...`，后台填写 `tang-jinsong`。对象列举使用完整分页；读取使用 ETag/LastModified/Size 条件校验，扫描或分页不完整时不执行缺失移除。

每次独立部署都需要自行创建 bucket、服务身份和映射，并按下方清单验收。平台安装与 HTTPS 配置见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 同步与审核规则

- 每个映射绑定一个智能体，智能体标识不能在编辑映射时悄悄更换；要改所属智能体应新建映射。
- 新建或修改启用的映射立即排队同步，之后按1—1440分钟间隔运行。关闭自动同步不删除知识；手动同步可继续使用。
- 使用文件版本签名和内容SHA-256去重；相同文件内容不重复切片；变更后的文件替换旧索引。
- 默认导入文档“待审核”，不参与公开回答；可信且已完成上游审核的资料库可明确开启自动生效。
- 新版本待解析/待审核时不继续把旧版本冒充当前资料引用。审核后再参与检索。
- “移除缺失资料”默认关闭。启用后也必须完整扫描、零文件读取错误才会在平台内软移除，NAS原件不动。
- 删除映射只停止后续同步，保留已经导入的知识。移除知识是单独操作。
- 格式错误、超时、认证失败会显示在任务和同步记录，可修复后重试。服务进程重启会恢复未完成任务。

默认限制：每次目录扫描最多5000文件、12层，单文件50 MB，网络请求20秒、目录扫描60秒。每轮最多导入100个变更文件、导入预算60秒；已成功文件在下一周期跳过，剩余变更继续处理，失败文件不会一直挡住新文件。数量/时间截断会明确标记为不完整，不执行缺失删除。可通过 `NAS_SYNC_MAX_FILES_PER_RUN`（1—1000）和 `NAS_SYNC_MAX_DURATION_MS`（最多60000）调整。

达到限制、权限不足或跳过不安全路径会标记扫描不完整，并显示具体告警。大库应分目录映射、分批接入；不要把整个NAS根文件系统映射给单个助手。

## 部署验收清单

1. **连通**：测试连接成功；确认列出的相对目录和文件数量合理。
2. **新建**：向对应 NAS 目录上传一个有唯一测试词的 TXT/PDF；等待一个周期，平台出现文档并成功切片。
3. **审核**：待审核状态搜不到；批准后检索测试命中该文档及正确片段。
4. **隔离**：切换另一智能体检索相同唯一测试词，不应命中前一智能体私有资料。
5. **变更**：修改测试词，下一周期更新同一文档版本；旧词不再被旧索引引用。
6. **故障**：临时停用测试账号读取权限，平台显示失败，已经入库资料不会因一次空/失败扫描被删除。
7. **缺失**：在测试目录移除测试文件；仅开启对应策略后平台才软移除知识，且没有 NAS 写入操作。
8. **模型**：配置聊天/Embedding后重新索引，用前台问答核验引用和内容；不要仅凭“连接已配置”认定结果正确。

资料发送到外部 Embedding/聊天端点前，必须确认内容授权、隐私处理和供应商数据要求。包含患者身份/病历的文件不应直接放进公开问答知识库。
