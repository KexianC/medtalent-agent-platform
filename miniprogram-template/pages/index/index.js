Page({
  data: { h5Url: "", failed: false, networkType: "unknown" },
  onLoad() {
    const config = require("../../config.js");
    this.baseUrl = config.h5Url || getApp().globalData.h5Url;
    this.loadH5();
    wx.getNetworkType({ success: ({ networkType }) => this.setData({ networkType }) });
    this.networkHandler = ({ isConnected, networkType }) => {
      this.setData({ networkType });
      if (isConnected && this.data.failed) this.retry();
    };
    wx.onNetworkStatusChange(this.networkHandler);
  },
  onUnload() { if (this.networkHandler) wx.offNetworkStatusChange(this.networkHandler); },
  loadH5() {
    if (!this.baseUrl) return this.setData({ failed: true });
    const separator = this.baseUrl.includes("?") ? "&" : "?";
    this.setData({ failed: false, h5Url: `${this.baseUrl}${separator}wv=${Date.now()}` });
  },
  onWebError() { this.setData({ failed: true }); },
  retry() {
    if (this.data.networkType === "none") return wx.showToast({ title: "当前网络不可用", icon: "none" });
    this.setData({ h5Url: "", failed: false }, () => this.loadH5());
  },
});
