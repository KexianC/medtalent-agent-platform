# 微信能力通道接入约定

已预留 H5 SDK、原生能力页和服务端接口。微信登录、手机号授权、支付、订阅消息均**默认关闭**，没有自动授权或新增登录按钮，没有消费者账号体系、凭证兑换或登录态回传。本次只更新本地源码与小程序工程包，未发布 H5/后端服务，也未向微信上传版本。

## 代码入口

| 文件 | 用途 |
| --- | --- |
| `src/lib/wechatBridge.ts` | H5 能力查询、环境识别、按需加载微信 SDK、原生导航、会话读取 |
| `wechat-miniprogram/utils/capabilities.js` | 原生协议版本、动作白名单、参数校验、关闭的处理器入口 |
| `wechat-miniprogram/pages/capability/index.*` | 未开放提示、后续用户操作位置、返回原 WebView |
| `server/wechat-bridge.mjs` | 能力、消费者会话和登录兑换三个接口位置 |
| `server/app.mjs` | 在已有安全/同源写入检查之后注册路由 |

协议为 `medtalent.wechat`，版本为数字 `1`。H5、原生、后端分别验证；只改一端开关不会启用真实功能。

## H5 调用示例

```ts
import {
  readWechatCapabilities, readWechatSession,
  requestWechatLogin, requestWechatCapability,
} from "./lib/wechatBridge";

const capabilities = await readWechatCapabilities();
// 后续放在用户点击登录的位置，当前为 disabled；接口未部署时为 unavailable。
const result = await requestWechatLogin();
if (result.status === "disabled") {
  // 继续访客流程；业务界面可不显示尚未开放的按钮。
} else if (result.status === "dispatched") {
  // 仅表示导航调用已发起，不能当作登录或授权完成。
}
await requestWechatCapability("phoneNumber");
await requestWechatCapability("payment");
await requestWechatCapability("subscribeMessage");

// 未来真实登录接好后，返回 H5/恢复可见时由业务层显式查询。
const session = await readWechatSession();
if (!("status" in session) && session.enabled && session.authenticated) {
  // 后端确认消费者会话。业务权限仍必须由服务端判定。
}
```

也导出 `createWechatBridge(options)` 供隔离测试。导入无网络/DOM/登录副作用；每次能力调用先读同源接口，禁用时不下载 SDK、不导航。网络失败、404、协议不符、超时会停止调用。

真实通道只允许 `https://agent.hzmwmt.com`，localhost 等本机地址可读本地接口但不发起真实微信导航；更换正式域名需同步调整 `WECHAT_APP_ORIGIN` 与小程序配置。启用能力后按需加载固定官方脚本 `https://res.wx.qq.com/open/js/jweixin-1.6.0.js`，以 `miniProgram.getEnv` 确认小程序环境，不能把普通微信网页当小程序。加载失败允许重试。

## 原生路由与返回

```text
/pages/capability/index?v=1&action=login&requestId=<32位小写十六进制随机值>
```

只允许四个登记动作，不接受任意 URL、任意 `wx` 方法、returnUrl、code/token 或透传 JSON。requestId 仅用于关联，**不具备身份或授权效力**。原生检查父页和请求格式只保证流程正确，不能代替服务端来源、身份或登录 CSRF 校验。

使用 `navigateTo` 打开、`navigateBack` 返回；原 WebView 不改 src、不改 URL/hash、不重建，保留仍存活的网页与输入。系统回收页面后的恢复仍由 H5 草稿存储负责。原生页面加载不自动调用 wx.login/授权/支付；当前处理器关闭，直接访问也只显示未开放。后续敏感能力要有明确用户操作。

能力页隐藏分享，原 WebView 仍只分享公开路径与固定品牌封面。不把 postMessage 当作实时 RPC，不通过 WebView 地址传凭证，也不把导航回调当登录结果；dispatched 仅表示调用已发起。实际登录结果需下面的服务端事务通道。

## 当前服务端合约

| 接口 | 当前响应 |
| --- | --- |
| `GET /api/wechat/capabilities` | 200，协议与四项 `enabled:false` |
| `GET /api/wechat/session` | 200，`enabled:false, authenticated:false, user:null` |
| `POST /api/wechat/login` | 501，`code:WECHAT_LOGIN_NOT_CONFIGURED`，不处理/回显凭证 |

全部 no-store，不颁发 Cookie、不写身份、不请求微信。`/api/auth/login` 与 medtalent_session 是运营后台认证；即使携带真实管理员 Cookie，微信会话仍未认证。未来消费者用户投影为 `{id, displayName?, avatarUrl?}`，不混入后台角色/服务端凭证。本次接口尚未部署到线上；线上404时 SDK 返回 unavailable。

## 后续真实登录接入

1. 建立独立消费者身份、账号绑定和会话，明确 AppID/OpenID 绑定、UnionID 条件、注销/过期，保持与后台权限分离。
2. AppSecret 仅放服务端。原生经用户操作取得 wx.login code，通过固定 HTTPS 接口正文提交，服务端兑换并校验身份。AppSecret、session_key、微信原始响应不下发，也不进入 URL、分享、日志或 VITE_*。
3. 实现 H5 发起事务→原生提交→H5 查询/消费的完整返回通道。事务须短时、一次性、绑定发起浏览器上下文；原生提交须有与事务绑定的证明，防重放与登录 CSRF。当前随机 requestId 不能直接作为票据或登录依据。
4. 由 H5 同源 HTTP 响应建立 Secure、HttpOnly、适当 SameSite 的消费者会话。不能假定原生 wx.request 的 Cookie 自动共享给 WebView，不能把 token 拼到返回地址；核对 WebView 共享 Cookie 对会话隔离的影响。
5. 同步实现原生处理器、两端开关，再加入按钮与取消/失败/超时。手机号要真实授权按钮；支付要后端订单、验签回调；订阅消息要用户操作、模板和发送策略。
6. 配置原生 request 合法域名、微信隐私指引/资质，真机验收后重新上传审核。现有业务域名校验文件不代表新增能力权限已配置。仅提供 AppSecret 或改环境变量不会自动开启当前预留实现。

## 验证与参考

`npm run test:wechat` 覆盖原生、H5 SDK、配置、真实 Express 与隔离平台账号测试；`npm run check` 检查 TypeScript；`node scripts/compile-wechat-local.cjs 'D:\微信web开发者工具'` 编译五个原生页面。测试中的启用响应和 SDK 替身只验证协议分支，不代表真实登录。

官方参考：[web-view](https://developers.weixin.qq.com/miniprogram/dev/component/web-view.html)、[微信登录](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/login/wx.login.html)、[JS SDK](https://res.wx.qq.com/open/js/jweixin-1.6.0.js)。本次微信文档页无法直接读取，已读取官方 SDK 源码确认 miniProgram 桥接入口；实际启用前仍需核对当前要求与真机行为。
