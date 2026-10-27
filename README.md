# 有医说医 · Medtalent 智能体平台

React + TypeScript 前台与管理后台、Express API、SQLite / MySQL 持久化，以及微信原生小程序和 WebView 工程。支持智能体草稿与发布、知识库导入与审核、模型供应商配置、NAS 同步及消费者账户相关功能。

## 独立部署

详细步骤见 [部署与运维](docs/DEPLOYMENT.md)。推荐在支持持久化磁盘的 Linux 服务器上使用 Docker Compose，准备自己的域名与 HTTPS 证书。

```sh
git clone https://github.com/KexianC/medtalent-agent-platform.git
cd medtalent-agent-platform
cp .env.example .env.local
chmod 600 .env.local
# 编辑 .env.local，填写自己的 ADMIN_PASSWORD、PUBLIC_URL 等配置
docker compose --env-file .env.local up -d --build
curl --fail http://127.0.0.1:8788/api/health
```

服务默认只监听宿主机 `127.0.0.1:8788`。参考 [Nginx 配置](nginx.conf.example) 配置 HTTPS 反向代理，后台入口为 `/admin`。管理员账号只在首次建库时初始化；生产必须使用自己的强密码。

业务数据存放于命名卷，部署与升级须保留数据卷。本项目只运行一个应用实例。备份、恢复、密码重置、MySQL 和 NAS 配置见部署文档。

模型为可选配置：未配置模型时不会生成 AI 回答，仍可使用后台与知识管理。真实问答、Embedding、语音、微信登录及支付等能力均需部署者配置自己的供应商或平台凭据。

## 本地开发

需要 Node.js 24.4+。

```sh
npm ci
cp .env.example .env.local
npm run dev
```

前台与后台：`http://127.0.0.1:5174` 和 `/admin`；API：`http://127.0.0.1:8788`。默认开发账号 `admin` / `dev-admin-password` 仅供本机开发。

```sh
npm run check
npm run build
npm test
npm start
```

`npm start` 读取 `.env.local`。原生 Node 正式部署需设置 `NODE_ENV=production`、强密码和 HTTPS `PUBLIC_URL`，并由进程管理器保持单实例。

## 微信小程序

- [微信原生版](docs/NATIVE_IMPORT_GUIDE.md)：导入 `wechat-native/`。
- [WebView 版](wechat-miniprogram/README.md)：导入 `wechat-miniprogram/`。

部署者须替换工程 AppID、API/H5 域名、运营主体和隐私联系信息，并在自己的微信后台配置合法域名和隐私指引。AppSecret 只配置到服务端。

重新生成原生资源：

```sh
npm ci
npm run build:native
npm run test:native
```

`check:native` / `package:native` 另需微信开发者工具中的官方 `wcc.exe`、`wcsc.exe`，可设置 `WECHAT_COMPILER_DIR`。源码上传 GitHub 和本地构建均不会自动上传、提审或发布小程序。

## 源码范围与文档

公开仓库不包含 `.env.local`、生产数据库、知识原件、用户数据、账号会话、服务密钥、私有证书、本地备份和现场运维记录。首次部署从新数据库开始；需展示自己的业务内容时，在后台配置、核验并发布。现有医生资料、头像和文案为项目初始内容，复用前需核验资料与授权。

- [环境变量示例](.env.example)
- [API](docs/API.md) · [架构](docs/ARCHITECTURE.md)
- [MySQL 迁移](docs/MYSQL_MIGRATION.md) · [NAS](docs/NAS.md)
- [NAS 同步 Worker](docs/NAS_MINIO_SYNC.md)

本平台用于科普和就医准备，AI 输出不替代医生诊断。
