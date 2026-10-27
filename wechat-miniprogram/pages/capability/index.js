const bridge = require("../../utils/capabilities.js");
const routes = require("../../utils/routes.js");
const config = require("../../config.js");

Page({
  data: { title: "暂时无法使用", description: "请返回应用后重新操作。", enabled: false, pending: false, completed: false },
  onLoad(options) {
    this.disposed = false;
    if (wx.hideShareMenu) wx.hideShareMenu();
    const pages = getCurrentPages();
    const previous = pages[pages.length - 2];
    // 父页检查只保证返回流程正确，不能代替服务端身份校验或登录 CSRF 防护。
    this.caller = previous && !previous.disposed && previous.route === "pages/webview/index" && typeof previous.loadPage === "function" && routes.pathFromWebViewUrl(previous.data && previous.data.src, config) ? previous : null;
    this.request = bridge.parseRequest(options);
    // 能力页不是独立登录入口。审核/分享冷启动无事务参数时先进入公开应用，
    // 用户可在“我的”重新发起；非空但异常的请求仍安全拒绝，不能伪造登录。
    const emptyLaunch = options === undefined || options === null || (typeof options === "object" && !Array.isArray(options) && Object.keys(options).length === 0);
    if (emptyLaunch) return this.goBack();
    if (!this.caller || !this.request) return;
    const capability = bridge.definition(this.request.action);
    this.setData({ title: capability.title, description: capability.description, enabled: capability.enabled });
    wx.setNavigationBarTitle({ title: capability.title });
    // H5 的“微信一键登录”点击已明确发起登录；校验来源和服务端能力后继续，避免重复确认。
    // 手机号、支付、订阅仍为关闭状态，不能由进入此页面自动触发。
    if (this.request.action === "login") return this.confirm();
  },
  async confirm() {
    if (this.disposed || !this.caller || !this.request || !this.data.enabled || this.data.pending || this.data.completed) return;
    this.setData({ pending: true, description: "正在连接微信并登录，请稍候…" });
    this.operation = bridge.executeCapability(this.request);
    const result = await this.operation.promise;
    if (this.disposed) return;
    this.operation = null;
    if (result.status === "completed") {
      this.setData({ pending: false, enabled: false, completed: true, description: "正在返回并同步账号…" });
      // 返回现有 WebView，保留 H5 的发起上下文、草稿和会话消费流程。
      // 原生完成提交不等于 H5 已登录；不能重建 WebView 来传递身份。
      this.request = null;
      this.goBack();
      return;
    }
    const retryable = result.status === "unavailable";
    const description = result.status === "disabled" ? "微信登录暂未开放，请返回继续使用应用。"
      : result.status === "expired" ? "登录请求已失效，请返回应用后重新点击微信登录。"
      : result.status === "cancelled" ? "已取消登录，你可以返回继续使用应用。"
      : "登录暂未成功，请检查网络后重试，或返回应用重新发起。";
    this.setData({ pending: false, enabled: retryable, description });
  },
  goBack() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.operation) this.operation.cancel();
    this.request = null;
    if (this.caller) {
      wx.navigateBack({ delta: 1, fail: () => wx.reLaunch({ url: "/pages/index/index" }) });
    } else {
      wx.reLaunch({ url: "/pages/index/index" });
    }
  },
  onUnload() {
    this.disposed = true;
    if (this.operation) this.operation.cancel();
    this.request = null;
  }
});
