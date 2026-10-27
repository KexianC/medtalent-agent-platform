// WeChat's JS runtime does not guarantee the browser AbortController global.
class NativeAbortController {
  constructor() {
    const listeners = new Set();
    this.signal = {
      aborted: false,
      addEventListener(type, listener) { if (type === 'abort') listeners.add(listener); },
      removeEventListener(type, listener) { if (type === 'abort') listeners.delete(listener); }
    };
    this.abort = () => {
      if (this.signal.aborted) return;
      this.signal.aborted = true;
      for (const listener of [...listeners]) listener();
      listeners.clear();
    };
  }
}
function abortError() { const error = new Error('操作已取消。'); error.name = 'AbortError'; return error; }
module.exports = { NativeAbortController, abortError };
