const { NativeAbortController, abortError } = require('./cancel.js');
const { createSpeechChunker } = require('./speech-chunker.js');
const { stripChatDisclaimer } = require('./chat-disclaimer.js');
function callWx(wx, method, options) {
  return new Promise((resolve, reject) => {
    if (typeof wx[method] !== 'function') return reject(new Error('当前微信版本暂不支持此能力，请更新微信后重试。'));
    wx[method](Object.assign({}, options, { success: resolve, fail: reject }));
  });
}
function createSpeech({ wx, api }) {
  let recorder;
  let recording;
  let recorderOwner;
  let recordingEpoch = 0;
  let lastRecording;
  const players = new Set();
  const queues = new Set();
  const files = wx.getFileSystemManager && wx.getFileSystemManager();
  const removeFile = path => { if (files && path) files.unlink({ filePath: path, success() {}, fail() {} }); };
  const readFile = path => new Promise((resolve, reject) => files.readFile({ filePath: path, success: result => resolve(result.data), fail: () => reject(new Error('录音文件读取失败，请重试。')) }));
  const writeFile = (path, bytes) => new Promise((resolve, reject) => files.writeFile({ filePath: path, data: bytes, success: resolve, fail: () => reject(new Error('语音文件保存失败，请重试。')) }));
  function notifyRecord(operation, state, detail) { if (operation && operation.options.onState && recordingEpoch === operation.epoch) operation.options.onState(state, detail); }
  function settleRecording(operation, error, value) {
    if (!operation || operation.settled) return;
    operation.settled = true;
    clearTimeout(operation.startTimer);
    if (recording === operation) recording = undefined;
    if (error) { operation.rejectStarted(error); operation.rejectResult(error); notifyRecord(operation, error.name === 'AbortError' ? 'ready' : 'error', error.message); }
    else { operation.resolveResult(value); notifyRecord(operation, 'ready'); if (operation.options.onResult) operation.options.onResult(value); }
  }
  function ensureRecorder() {
    if (recorder) return recorder;
    if (!wx.getRecorderManager || !files) throw new Error('当前微信版本暂不支持录音，请更新微信后重试。');
    recorder = wx.getRecorderManager();
    recorder.onStart(() => {
      const operation = recorderOwner;
      if (!operation || operation.controller.signal.aborted) { recorder.stop(); return; }
      operation.startedAt = Date.now(); operation.recording = true;
      clearTimeout(operation.startTimer);
      notifyRecord(operation, 'recording'); operation.resolveStarted();
    });
    recorder.onError(() => { const operation = recorderOwner; recorderOwner = undefined; if (operation) settleRecording(operation, new Error('录音未成功，请确认麦克风权限后重试。')); });
    recorder.onStop(async result => {
      const operation = recorderOwner;
      recorderOwner = undefined;
      if (!operation) { if (result) removeFile(result.tempFilePath); return; }
      if (operation.settled) { if (result) removeFile(result.tempFilePath); return; }
      operation.recording = false;
      const path = result && result.tempFilePath;
      try {
        if (operation.controller.signal.aborted || recordingEpoch !== operation.epoch) throw abortError();
        operation.resolveStarted();
        const duration = typeof result.duration === 'number' ? result.duration : Date.now() - operation.startedAt;
        if (!path || duration < 400) throw new Error('录音时间太短，请按住后说出问题。');
        if (result.fileSize > 3 * 1024 * 1024) throw new Error('录音超过大小限制，请缩短后重试。');
        notifyRecord(operation, 'recognizing');
        const audio = await readFile(path);
        if (operation.controller.signal.aborted || recordingEpoch !== operation.epoch) throw abortError();
        if (!(audio instanceof ArrayBuffer) || !audio.byteLength || audio.byteLength > 3 * 1024 * 1024) throw new Error('录音文件无效或过大，请重试。');
        // RecorderManager MP3 is sent as raw audio/mpeg. The existing ASR route
        // maps this to the provider's supported mp3 format at 16 kHz.
        const body = await api.json('/api/asr', { method: 'POST', header: { 'content-type': 'audio/mpeg' }, data: audio, timeout: 45000, signal: operation.controller.signal });
        if (operation.controller.signal.aborted || recordingEpoch !== operation.epoch) throw abortError();
        if (!body || typeof body.text !== 'string' || !body.text.trim()) throw new Error('没有识别到清晰语音，请再说一次。');
        settleRecording(operation, null, { text: body.text.trim(), durationSeconds: Math.max(1, Math.round(duration / 1000)) });
      } catch (error) { settleRecording(operation, error); }
      finally { removeFile(path); }
    });
    if (recorder.onInterruptionBegin) recorder.onInterruptionBegin(() => {
      if (recording) { recording.controller.abort(); settleRecording(recording, new Error('录音已被系统打断，请重新录制。')); recorder.stop(); }
    });
    return recorder;
  }
  async function startRecording(options = {}) {
    if (recording || recorderOwner) throw new Error('当前录音尚未结束，请稍候。');
    stopPlayback();
    const operation = { options, epoch: ++recordingEpoch, controller: new NativeAbortController(), startedAt: Date.now(), settled: false, recording: false };
    operation.started = new Promise((resolve, reject) => { operation.resolveStarted = resolve; operation.rejectStarted = reject; });
    operation.result = new Promise((resolve, reject) => { operation.resolveResult = resolve; operation.rejectResult = reject; });
    // Cancellation and auto-stop can happen without a stopRecording caller.
    operation.result.catch(() => undefined);
    operation.started.catch(() => undefined);
    recording = operation; lastRecording = operation;
    try {
      ensureRecorder(); notifyRecord(operation, 'authorizing');
      if (wx.requirePrivacyAuthorize) await callWx(wx, 'requirePrivacyAuthorize');
      if (operation.controller.signal.aborted || recordingEpoch !== operation.epoch) throw abortError();
      await callWx(wx, 'authorize', { scope: 'scope.record' });
      if (operation.controller.signal.aborted || recordingEpoch !== operation.epoch) throw abortError();
      recorderOwner = operation;
      operation.startTimer = setTimeout(() => {
        if (!operation.settled && !operation.recording) { operation.controller.abort(); settleRecording(operation, new Error('录音启动超时，请重新录制。')); recorder.stop(); }
      }, 10000);
      recorder.start({ duration: 60000, sampleRate: 16000, numberOfChannels: 1, encodeBitRate: 48000, format: 'mp3' });
      await operation.started;
    } catch (error) {
      if (recorderOwner === operation && !operation.recording && !operation.controller.signal.aborted) recorderOwner = undefined;
      const failure = error.name === 'AbortError' ? error : new Error('录音未开始，请在微信设置中允许麦克风，并同意隐私保护指引后重试。');
      settleRecording(operation, failure); throw failure;
    }
  }
  function stopRecording() {
    const operation = recording || lastRecording;
    if (!operation) return Promise.reject(new Error('请先开始录音。'));
    if (!operation.settled && !operation.recording) {
      // A release before authorization/onStart does not create a background recording.
      cancelRecording(); return operation.result;
    }
    if (operation.recording) recorder.stop();
    return operation.result;
  }
  function cancelRecording() {
    const operation = recording;
    if (!operation) return;
    operation.controller.abort();
    const wasRecording = operation.recording || recorderOwner === operation;
    settleRecording(operation, abortError());
    recordingEpoch += 1;
    if (wasRecording && recorder) recorder.stop();
  }
  function speak(text, options = {}) {
    for (const cancel of [...players]) cancel();
    const controller = new NativeAbortController();
    const parent = options.signal;
    let audio;
    let path;
    let rejectPlayback;
    let playbackTimer;
    const notify = state => { if (!controller.signal.aborted && options.onState) options.onState(state); };
    const cancel = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      clearTimeout(playbackTimer);
      if (audio) { audio.stop(); audio.destroy(); audio = undefined; }
      if (rejectPlayback) rejectPlayback(abortError());
      removeFile(path);
    };
    if (parent) parent.addEventListener('abort', cancel);
    players.add(cancel);
    const promise = (async () => {
      if (parent && parent.aborted) cancel();
      if (controller.signal.aborted) throw abortError();
      if (!files || !wx.createInnerAudioContext || !wx.env || !wx.env.USER_DATA_PATH) throw new Error('当前微信版本暂不支持语音播放。');
      const content = stripChatDisclaimer(String(text || '')).replace(/[`*_#>]/g, '').trim();
      if (!content) return;
      // The server's speech text limit is 1,200 characters. Split replay without
      // silently truncating a longer answer.
      const chunks = [];
      for (let index = 0; index < content.length; index += 1200) chunks.push(content.slice(index, index + 1200));
      for (const chunk of chunks) {
        if (controller.signal.aborted) throw abortError();
        notify('loading');
        const response = await api.request('/api/tts', { method: 'POST', data: { text: chunk, ...(options.doctorSlug ? { doctorSlug: options.doctorSlug } : {}) }, responseType: 'arraybuffer', dataType: 'text', timeout: 45000, signal: controller.signal }).promise;
        if (response.statusCode < 200 || response.statusCode >= 300) {
          let body;
          try { body = typeof response.data === 'string' ? JSON.parse(response.data) : null; } catch (_) { /* Binary failure. */ }
          throw api.responseError({ statusCode: response.statusCode, data: body });
        }
        if (controller.signal.aborted) throw abortError();
        const bytes = response.data;
        if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 4 || bytes.byteLength > 20 * 1024 * 1024) throw new Error('语音服务未返回有效音频，请重试。');
        const magic = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 12));
        const wav = magic[0] === 82 && magic[1] === 73 && magic[2] === 70 && magic[3] === 70;
        path = wx.env.USER_DATA_PATH + '/medtalent-tts-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + (wav ? '.wav' : '.mp3');
        await writeFile(path, bytes);
        if (controller.signal.aborted) { removeFile(path); throw abortError(); }
        audio = wx.createInnerAudioContext(); audio.obeyMuteSwitch = false;
        await new Promise((resolve, reject) => {
          let complete = false;
          const finish = (callback, value) => { if (complete) return; complete = true; clearTimeout(playbackTimer); callback(value); };
          rejectPlayback = error => finish(reject, error);
          const initialWait = Number.isFinite(options.startTimeoutMs) ? Math.max(1, Math.min(15000, options.startTimeoutMs)) : 15000;
          playbackTimer = setTimeout(() => finish(reject, new Error('语音播放等待超时，请重试。')), initialWait);
          audio.onPlay(() => {
            if (complete || controller.signal.aborted) return;
            clearTimeout(playbackTimer);
            playbackTimer = setTimeout(() => finish(reject, new Error('语音播放未正常结束，请重试。')), Math.max(30000, Math.min(600000, chunk.length * 600 + 20000)));
            notify('playing');
          });
          audio.onEnded(() => finish(resolve));
          audio.onError(() => finish(reject, new Error('语音播放未成功，请重试。')));
          audio.src = path; audio.play();
        });
        clearTimeout(playbackTimer);
        if (audio) { audio.destroy(); audio = undefined; }
        removeFile(path); path = undefined; rejectPlayback = undefined;
      }
      notify('idle');
    })().catch(error => { if (error.name !== 'AbortError') notify('error'); throw error; }).finally(() => {
      clearTimeout(playbackTimer);
      if (audio) { audio.destroy(); audio = undefined; }
      removeFile(path); players.delete(cancel); if (parent) parent.removeEventListener('abort', cancel);
    });
    return { promise, cancel };
  }
  function createQueue(options = {}) {
    const chunker = createSpeechChunker();
    const controller = new NativeAbortController();
    let closed = false;
    let timer;
    let chain = Promise.resolve();
    let failure;
    const active = () => !controller.signal.aborted && (!options.isActive || options.isActive());
    const clearDeadline = () => { clearTimeout(timer); timer = undefined; };
    const enqueue = chunks => {
      if (chunks.length) clearDeadline();
      for (const chunk of chunks) chain = chain.then(async () => { if (active()) await speak(chunk, { doctorSlug: options.doctorSlug, onState: options.onState, signal: controller.signal }).promise; }).catch(error => { failure = error; controller.abort(); clearDeadline(); });
    };
    const cancel = () => { closed = true; clearDeadline(); controller.abort(); queues.delete(cancel); };
    queues.add(cancel);
    return {
      push(delta) {
        if (closed || !active()) return;
        enqueue(chunker.push(delta));
        if (timer === undefined && chunker.hasPending()) timer = setTimeout(() => { timer = undefined; if (!closed && active()) enqueue(chunker.flushPending()); }, chunker.hasEmitted() ? 1800 : 700);
      },
      async finish() { if (!closed) { closed = true; clearDeadline(); if (active()) enqueue(chunker.push('', true)); } await chain; queues.delete(cancel); if (failure && failure.name !== 'AbortError') throw failure; },
      cancel
    };
  }
  function stopPlayback() { for (const cancel of [...queues]) cancel(); for (const cancel of [...players]) cancel(); }
  return { startRecording, stopRecording, cancelRecording, speak, createQueue, stopPlayback, dispose() { cancelRecording(); stopPlayback(); } };
}
module.exports = { createSpeech };
