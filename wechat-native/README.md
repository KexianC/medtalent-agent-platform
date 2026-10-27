# Medtalent 原生小程序

导入本目录前，将 `project.config.json` 的 AppID 和 `config.js` 的 API Origin、运营主体、隐私邮箱改为自己的配置。后端部署见 [独立部署指南](../docs/DEPLOYMENT.md)。本工程无需云服务或 WebView，AppSecret 和模型密钥仅保存在服务器。

在自己的微信账号后台，把后端 HTTPS 域名设为 request/downloadFile 合法域名。PDF 原文还需核对 `inform-iadr.com`、`www.phqscreeners.com` 的下载域名配置；录音隐私说明须覆盖麦克风。

构建需要 Node.js 24.4+。在仓库根目录运行：

```sh
npm ci
npm run build:native
npm run check:native
npm run test:native
npm run package:native
```

`sharp` 已声明为构建依赖，随 `npm ci` 安装。官方 `wcc.exe` / `wcsc.exe` 的 `wcc-exec` 目录可用 `WECHAT_COMPILER_DIR` 指定；已构建工程导入微信开发者工具时无需构建 npm。

完整步骤见 [原生导入手册](../docs/NATIVE_IMPORT_GUIDE.md)。打包输出为 `output/native/Medtalent-微信原生小程序.zip`。修改配置或共享源码后须重新构建，随后使用自己的微信账号上传、提审和发布。本机编译与测试不能替代真机、合法域名和供应商验收。
