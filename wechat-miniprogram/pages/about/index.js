const config = require("../../config.js");
Page({
  data: { appName: config.appName, version: config.version, operatorName: config.operatorName, privacyEmail: config.privacyEmail },
  openWechatPrivacy() {
    if (!wx.openPrivacyContract) return wx.showToast({ title: "请更新微信后查看", icon: "none" });
    wx.openPrivacyContract({ fail: () => wx.showToast({ title: "暂无法打开，请查看本页隐私说明", icon: "none" }) });
  }
});
