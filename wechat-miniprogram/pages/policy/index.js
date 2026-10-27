const config = require("../../config.js");
Page({
  data: { type: "privacy", appName: config.appName, operatorName: config.operatorName, privacyEmail: config.privacyEmail, updatedAt: config.privacyUpdatedAt },
  onLoad(options) {
    const type = options && options.type === "terms" ? "terms" : "privacy";
    this.setData({ type });
    wx.setNavigationBarTitle({ title: type === "privacy" ? "隐私说明" : "使用须知" });
  }
});
