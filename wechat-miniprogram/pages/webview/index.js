const config = require("../../config.js");
const routes = require("../../utils/routes.js");

Page({
  data: { src: "", failed: false, attempt: 0, errorTitle: "正在打开智能体", errorDescription: "请稍候…" },
  onLoad(options) {
    this.disposed = false;
    this.currentPath = routes.launchPath(options || {}, config);
    this.networkType = "unknown";
    this.networkHandler = (event) => {
      if (this.disposed) return;
      this.networkType = event.isConnected ? event.networkType : "none";
      // 离线时保留已打开的网页和输入，避免重建 WebView 丢失草稿。
    };
    wx.getNetworkType({ success: (event) => { if (!this.disposed) this.networkType = event.networkType; } });
    wx.onNetworkStatusChange(this.networkHandler);
    this.loadPage();
  },
  clearLoading() {
    if (this.loadTimer) clearTimeout(this.loadTimer);
    this.loadTimer = null;
    wx.hideNavigationBarLoading();
  },
  loadPage() {
    if (this.disposed) return;
    this.clearLoading();
    const src = routes.h5Url(this.currentPath, config);
    if (!src) return this.failPage("服务暂时不可用", "请稍后再试，或通过帮助页面联系运营方。");
    if (wx.canIUse && !wx.canIUse("web-view")) return this.failPage("请更新微信后使用", "当前微信版本暂不支持打开应用，请更新微信后重试。");
    const attempt = this.data.attempt + 1;
    this.setData({ src: "", failed: false, attempt }, () => {
      if (this.disposed || this.data.attempt !== attempt) return;
      wx.showNavigationBarLoading();
      this.setData({ src });
      this.loadTimer = setTimeout(() => {
        if (!this.disposed && this.data.attempt === attempt) this.failPage("页面加载超时", "网络连接可能较慢，请检查网络后重新加载。");
      }, 30000);
    });
  },
  isCurrentEvent(event) {
    const attempt = event && event.currentTarget && event.currentTarget.dataset.attempt;
    return !this.disposed && !this.data.failed && Number(attempt) === this.data.attempt;
  },
  onWebLoad(event) {
    if (!this.isCurrentEvent(event)) return;
    this.clearLoading();
    const path = routes.pathFromWebViewUrl(event.detail && event.detail.src, config);
    if (path) this.currentPath = path;
  },
  onWebError(event) {
    if (!this.isCurrentEvent(event)) return;
    this.failPage(this.networkType === "none" ? "当前网络不可用" : "页面暂时无法打开", "请检查网络后重试。如果仍无法打开，可通过帮助页面联系运营方。");
  },
  failPage(title, description) {
    if (this.disposed) return;
    this.clearLoading();
    this.setData({ src: "", failed: true, errorTitle: title, errorDescription: description });
  },
  retry() {
    // 重新获取网络状态，不能依赖一次过期的离线快照永久禁止重试。
    wx.getNetworkType({
      success: (event) => {
        if (this.disposed) return;
        this.networkType = event.networkType;
        if (event.networkType === "none") return this.failPage("当前网络不可用", "请连接网络后重新加载。");
        this.loadPage();
      },
      fail: () => { if (!this.disposed) this.loadPage(); }
    });
  },
  goHome() { wx.reLaunch({ url: "/pages/index/index" }); },
  onShareAppMessage(event) {
    const path = routes.pathFromWebViewUrl(event && event.webViewUrl, config) || this.currentPath;
    // 固定公开品牌图，防止微信默认截取聊天或健康记录作为分享封面。
    return { title: config.appName + " · 健康科普与智能问答", path: routes.sharePath(path), imageUrl: "/assets/medtalent-logo.png" };
  },
  onUnload() {
    this.disposed = true;
    this.clearLoading();
    if (this.networkHandler) wx.offNetworkStatusChange(this.networkHandler);
  }
});
