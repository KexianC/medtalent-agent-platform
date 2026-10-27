App({
  onLaunch() {
    const config = require("./config.js");
    this.globalData = { h5Url: config.h5Url || "" };
  },
});
