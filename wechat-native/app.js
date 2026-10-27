const { getRuntime } = require('./utils/runtime.js');
App({
  globalData: { runtime: null },
  onLaunch() { this.globalData.runtime = getRuntime(); },
  onShow() {
    const runtime = this.globalData.runtime || getRuntime();
    runtime.session.refresh();
  },
  onHide() {
    const runtime = this.globalData.runtime;
    if (runtime) { runtime.speech.cancelRecording(); runtime.speech.stopPlayback(); }
  }
});
