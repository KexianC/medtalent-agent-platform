# 微信能力通道接入约定

本版本实现小程序内的微信一键登录，连接 H5、原生 `wx.login` 和服务端账号数据库。手机号授权、支付、订阅消息仍关闭。该工程包不包含后端或 H5；必须配合对应服务版本。代码/模拟测试通过不代表小程序已上传、审核或真机登录成功。

## 代码入口

| 文件 | 用途 |
| --- | --- |
| `src/lib/wechatBridge.ts` | H5 能力查询、环境识别、微信 SDK 与登录事务发起/消费 |
| `wechat-miniprogram/utils/capabilities.js` | 固定原生动作、请求校验、登录处理及取消/超时 |
| `wechat-miniprogram/pages/capability/index.*` | 登录过渡、失败重试、取消与返回原 WebView |
| `server/wechat-bridge.mjs` | 消费者身份、登录事务和会话接口 |

协议为 `medtalent.wechat`，版本为数字 `1`。H5、原生、后端各自验证；原生实现存在不代表服务端已配置启用。

## 登录时序

1. 用户在 H5 点击“微信一键登录”。H5 确认小程序环境与登录能力，通过同源、带 CSRF 防护的 `POST /api/wechat/login` 建立短时一次性事务。
2. 服务端返回 `requestId`（32 位小写十六进制）、`bridgeToken`（64 位小写十六进制）与 `expiresAt`。事务绑定发起浏览器上下文，服务端只存令牌哈希。
3. H5 通过微信 SDK 打开固定原生页面：`/pages/capability/index?v=1&action=login&requestId=...&bridgeToken=...`。导航成功只表示已派发，不是登录成功。
4. 原生验证上一个页面确为本小程序的 WebView、来源属于配置的 HTTPS 域名且路径在公开白名单内。验证失败不请求任何服务。有效请求通过固定域名 `GET /api/wechat/capabilities` 再次确认 `capabilities.login.enabled === true`，随后继续用户已发起的登录，不重复要求确认。
5. 原生调用 `wx.login` 取得短时 code，通过固定 HTTPS `POST /api/wechat/login/complete` 正文提交 `{requestId, bridgeToken, code}`。服务端兑换并记录身份，成功仅返回 `{ok:true}`；原生不取得用户会话。
6. 原生返回原有 WebView，保持页面与输入内容。H5 在原发起上下文通过同源 CSRF `POST /api/wechat/login/consume` 消费事务，由响应建立独立消费者 HttpOnly 会话。所有用户数据访问与账号隔离继续由服务端校验。

`requestId` 只做关联，不能单独授权；`bridgeToken` 只用于原生提交，不是消费者登录态。只允许登记参数，不接受 `returnUrl`、任意 API 名、任意远程目标、code/token 透传 JSON。手机号/支付/订阅参数不能携带登录的 bridgeToken。

## 原生边界与异常处理

- 请求仅指向 `config.h5Origin` 的两个固定接口，不根据 URL 参数选择主机、方法或 API。不假设原生 `wx.request` 与 H5 共享 Cookie。
- 原生不保存 AppSecret、OpenID、session_key、登录 Cookie 或个人资料；临时 bridgeToken 不进入 storage、日志、分享卡片或 H5 返回 URL。
- 服务器能力关闭/协议不匹配时不会调用 `wx.login`。接口失败、code 缺失和超时显示重试；每次重试获取新的 code。事务过期须返回 H5 重新发起。
- 重复点击不会发出重复操作。页面取消/卸载会中止网络请求，清理计时器并忽略延迟的 wx.login/网络回调，离开后不会继续提交登录或导航。
- 无参数直接打开能力页时进入公开应用首页，已有 WebView 时返回原页；用户随后从“我的”发起登录。非空但格式异常的参数仍拒绝，不获取 code 或调用登录接口，公开浏览不依赖登录。
- 能力页隐藏分享。公开分享仍只包含 `/`、`/d/{slug}` 或 `/d/{slug}/ask` 以及固定品牌图，不带登录事务或健康记录。
- 成功后只返回，不调用 `loadPage()` 重建 WebView。H5 应保存可恢复的非秘密事务标识，并由发起上下文 Cookie 验证消费；不能只依赖原生 `navigateBack` 触发可见性事件，应配合有界重试恢复登录状态。原生不透传身份或消费者会话。
- 运营后台认证和消费者微信账号相互独立；管理员 Cookie 不能赋予消费者身份。

## 配置与发布

1. AppID 在 `project.config.json`，当前为 `wx7a4c71565eeee4b9`。AppSecret 仅配置于服务端，不放入代码包或 `VITE_*`。
2. 微信后台同时配置 `agent.hzmwmt.com` 的 WebView **业务域名**和 `https://agent.hzmwmt.com` 的 **request 合法域名**；二者不能替代。保持开发工具域名校验开启。
3. 根据实际账号数据处理更新微信后台隐私指引。登录不请求手机号、头像昵称、位置、通讯录权限；健康数据同步按 H5 的用户选择和页面说明处理。
4. 编译、打包此 `1.0.3` 原生版本；H5 发布不会更新用户已有的小程序包。需要上传并按微信流程完成审核与发布。
5. 在两台真实手机使用同一微信账号验证登录、已有记录、增加/删除、同步、退出、失效重登；使用不同账号验证隔离。另测取消、拒绝/失败、断网恢复和旧包提示。

## 本地验证

```powershell
node --test --test-isolation=none tests/wechat-capabilities.test.mjs tests/wechat-runtime.test.mjs tests/wechat-config.test.mjs
npm run test:wechat
npm run check:wechat
node scripts/compile-wechat-local.cjs 'D:\微信web开发者工具'
npm run package:wechat
```

原生测试使用模拟微信 API 与响应，覆盖成功、禁用、来源/参数拒绝、网络错误、重试、超时、取消及卸载回调，不调用真实微信兑换或上传。

官方参考：[微信登录](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/login/wx.login.html)、[wx.request](https://developers.weixin.qq.com/miniprogram/dev/api/network/request/wx.request.html)、[web-view](https://developers.weixin.qq.com/miniprogram/dev/component/web-view.html)。当前环境无法读取这些文档页面；账号权限、当前平台要求及真实设备行为须在微信后台和真机核验。
