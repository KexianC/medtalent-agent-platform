App({
  onLaunch() {
    if (!wx.getUpdateManager) return;
    const manager = wx.getUpdateManager();
    manager.onUpdateReady(() => {
      wx.showModal({
        title: "新版本已准备好",
        content: "更新会重新打开小程序。请先保存正在编辑的内容。",
        confirmText: "立即更新",
        cancelText: "稍后",
        success(result) { if (result.confirm) manager.applyUpdate(); }
      });
    });
  }
});
