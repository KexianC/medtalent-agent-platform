// 原生能力注册表：只接受明确登记的动作，不能用 H5 参数调用任意 wx API。
// 登录由原生实现、服务端配置共同开启；其他能力保持关闭。
const config = require("../config.js");
const routes = require("./routes.js");
const PROTOCOL = "medtalent.wechat";
const VERSION = 1;
const definitions = {
  login: { title: "微信一键登录", enabled: true, description: "使用当前微信账号登录，登录后可在其他设备查看已同步的数据。" },
  phoneNumber: { title: "手机号授权", enabled: false, description: "手机号授权暂未开放，当前不需要提供手机号。" },
  payment: { title: "微信支付", enabled: false, description: "微信支付暂未开放，当前不会发起支付。" },
  subscribeMessage: { title: "消息订阅", enabled: false, description: "消息订阅暂未开放，当前不会请求订阅授权。" }
};

function definition(action) {
  if (typeof action !== "string" || !Object.prototype.hasOwnProperty.call(definitions, action)) return null;
  const item = definitions[action];
  return { action, title: item.title, enabled: item.enabled === true, description: item.description };
}

function parseRequest(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) return null;
  if (Object.keys(options).some((key) => ["v", "action", "requestId", "bridgeToken"].indexOf(key) === -1)) return null;
  if (options.v !== "1" || !definition(options.action) || typeof options.requestId !== "string" || !/^[a-f0-9]{32}$/.test(options.requestId)) return null;
  if (options.action === "login" && (typeof options.bridgeToken !== "string" || !/^[a-f0-9]{64}$/.test(options.bridgeToken))) return null;
  if (options.action !== "login" && Object.prototype.hasOwnProperty.call(options, "bridgeToken")) return null;
  const request = { protocol: PROTOCOL, version: VERSION, action: options.action, requestId: options.requestId };
  if (options.action === "login") request.bridgeToken = options.bridgeToken;
  return request;
}

function getCapabilities() {
  const result = {};
  Object.keys(definitions).forEach((action) => { result[action] = definition(action); });
  return { protocol: PROTOCOL, version: VERSION, capabilities: result };
}

// 只向固定 HTTPS 源站提交临时 code。原生不接收、存储或返回消费者会话。
// cancel 同时终止请求并使后续 wx.login 回调失效，避免离开后继续提交身份。
function executeCapability(request) {
  let settled = false;
  let timer = null;
  let task = null;
  let resolveResult;
  const promise = new Promise((resolve) => { resolveResult = resolve; });
  const clearTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const finish = (status, code) => {
    if (settled) return;
    settled = true;
    clearTimer();
    resolveResult({ status, code });
  };
  const abortTask = () => {
    if (task && typeof task.abort === "function") task.abort();
    task = null;
  };
  const cancel = () => { finish("cancelled", "WECHAT_LOGIN_CANCELLED"); abortTask(); };
  const withDeadline = (timeout) => {
    clearTimer();
    timer = setTimeout(() => { finish("unavailable", "WECHAT_LOGIN_TIMEOUT"); abortTask(); }, timeout);
  };
  const options = request && { v: String(request.version), action: request.action, requestId: request.requestId };
  if (options && request.action === "login") options.bridgeToken = request.bridgeToken;
  if (!request || request.protocol !== PROTOCOL || request.version !== VERSION || !parseRequest(options)) {
    finish("invalid", "INVALID_BRIDGE_REQUEST");
    return { promise, cancel };
  }
  if (request.action !== "login") {
    finish("disabled", "CAPABILITY_DISABLED");
    return { promise, cancel };
  }
  const origin = routes.normalizeOrigin(config.h5Origin);
  const send = (path, method, data, success) => {
    if (settled) return;
    withDeadline(15000);
    try {
      task = wx.request({
        url: origin + path, method, data, timeout: 15000,
        header: { "content-type": "application/json", Accept: "application/json" },
        success: (response) => {
          if (settled) return;
          task = null;
          clearTimer();
          if (typeof response.statusCode !== "number" || response.statusCode < 200 || response.statusCode >= 300) {
            const expired = response.statusCode === 404 || response.statusCode === 409 || response.statusCode === 410;
            finish(expired ? "expired" : "unavailable", expired ? "WECHAT_LOGIN_EXPIRED" : "WECHAT_LOGIN_HTTP_ERROR");
            return;
          }
          success(response.data);
        },
        fail: () => { if (!settled) finish("unavailable", "WECHAT_LOGIN_NETWORK_ERROR"); }
      });
    } catch (_) { finish("unavailable", "WECHAT_LOGIN_UNAVAILABLE"); }
  };
  if (!origin || typeof wx === "undefined" || typeof wx.request !== "function" || typeof wx.login !== "function") {
    finish("unavailable", "WECHAT_LOGIN_UNAVAILABLE");
    return { promise, cancel };
  }
  send("/api/wechat/capabilities", "GET", undefined, (data) => {
    if (!data || data.protocol !== PROTOCOL || data.version !== VERSION || !data.capabilities || !data.capabilities.login || data.capabilities.login.enabled !== true) {
      finish("disabled", "CAPABILITY_DISABLED");
      return;
    }
    withDeadline(10000);
    try {
      wx.login({
        timeout: 10000,
        success: (result) => {
          if (settled) return;
          clearTimer();
          if (!result || typeof result.code !== "string" || !result.code || result.code.length > 512) {
            finish("unavailable", "WECHAT_LOGIN_CODE_MISSING");
            return;
          }
          send("/api/wechat/login/complete", "POST", { requestId: request.requestId, bridgeToken: request.bridgeToken, code: result.code }, (body) => {
            finish(body && body.ok === true ? "completed" : "unavailable", body && body.ok === true ? "WECHAT_LOGIN_COMPLETED" : "WECHAT_LOGIN_INVALID_RESPONSE");
          });
        },
        fail: () => { if (!settled) finish("unavailable", "WECHAT_LOGIN_FAILED"); }
      });
    } catch (_) { finish("unavailable", "WECHAT_LOGIN_UNAVAILABLE"); }
  });
  return { promise, cancel };
}

module.exports = { PROTOCOL, VERSION, definition, parseRequest, getCapabilities, executeCapability };
