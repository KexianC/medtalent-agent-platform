const config = require("../../config.js");
const routes = require("../../utils/routes.js");

Page({
  data: { appName: config.appName, opening: false },
  onShow() { this.setData({ opening: false }); },
  openPlatform() {
    if (this.data.opening) return;
    this.setData({ opening: true });
    wx.navigateTo({
      url: routes.sharePath(routes.launchPath({}, config)),
      fail: () => wx.showToast({ title: "暂时无法打开，请重试", icon: "none" }),
      complete: () => this.setData({ opening: false })
    });
  },
  onShareAppMessage() { return { title: config.appName + " · 健康科普与智能问答", path: "/pages/index/index", imageUrl: "/assets/medtalent-logo.png" }; }
});
