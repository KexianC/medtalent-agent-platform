const { NativeAbortController, abortError } = require('./cancel.js');
const { createChatDisclaimerFilter } = require('./chat-disclaimer.js');
function parseRetrieval(value) {
  const result = {};
  if (Array.isArray(value.citations)) {
    const seen = new Set();
    result.citations = value.citations.filter(item => item && typeof item.title === 'string' && item.title.trim()).map(item => ({ title: item.title.trim(), ...(typeof item.shareUrl==='string'&&/^\/api\/citations\/[a-z0-9-]+\/[A-Za-z0-9_-]+\/\d+$/.test(item.shareUrl)?{shareUrl:item.shareUrl}:{}) })).filter(item => { if (seen.has(item.title)) return false; seen.add(item.title); return true; });
  }
  if (['hybrid', 'lexical', 'none'].includes(value.retrievalMode)) result.retrievalMode = value.retrievalMode;
  return result;
}
// Incremental UTF-8 decoder preserves Chinese code points split across wx chunks.
function createUtf8Decoder() {
  let pending = [];
  return {
    push(buffer, final = false) {
      const bytes = pending.concat(Array.from(new Uint8Array(buffer || new ArrayBuffer(0))));
      pending = [];
      let text = '';
      for (let i = 0; i < bytes.length;) {
        const first = bytes[i];
        const length = first < 0x80 ? 1 : first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
        if (!length) throw new Error('流式回复编码无效，请重试。');
        if (i + length > bytes.length) { if (final) throw new Error('流式回复编码不完整，请重试。'); pending = bytes.slice(i); break; }
        let point = first & (length === 1 ? 0x7f : length === 2 ? 0x1f : length === 3 ? 0x0f : 0x07);
        for (let n = 1; n < length; n += 1) { const byte = bytes[i + n]; if ((byte & 0xc0) !== 0x80) throw new Error('流式回复编码无效，请重试。'); point = point * 64 + (byte & 63); }
        if ((length === 2 && point < 0x80) || (length === 3 && point < 0x800) || (length === 4 && point < 0x10000) || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) throw new Error('流式回复编码无效，请重试。');
        text += String.fromCodePoint(point); i += length;
      }
      return text;
    }
  };
}
function createChat({ wx, api }) {
  const active = new Set();
  function send(body, handlers = {}) {
    const controller = new NativeAbortController();
    const signal = controller.signal;
    const filter = createChatDisclaimerFilter();
    const decoder = createUtf8Decoder();
    let buffer = '';
    let reply = '';
    let receivedText = false;
    let receivedChunks = false;
    let ended = false;
    let retrieval = {};
    let requestTask;
    let streamHeaders = 200;
    let settled = false;
    let timer;
    let rejectStream;
    const append = delta => { const text = filter.push(delta); reply += text; if (text && handlers.onDelta && !signal.aborted) handlers.onDelta(text); };
    const event = value => {
      if (!value || typeof value !== 'object' || signal.aborted) return;
      if (ended && value.type === 'delta') throw new Error('智能问答流格式异常，请重试。');
      if (value.type === 'error') { const error = new Error(value.error || '智能问答服务暂时不可用。'); error.code = value.code; throw error; }
      if (value.type === 'delta' && typeof value.text === 'string') { receivedText = true; append(value.text); }
      else if (value.type === 'result') {
        retrieval = Object.assign(retrieval, parseRetrieval(value));
        const text = typeof value.reply === 'string' ? value.reply : typeof value.text === 'string' ? value.text : '';
        if (!receivedText && text) { receivedText = true; append(text); }
      } else if (value.type === 'done') { retrieval = Object.assign(retrieval, parseRetrieval(value)); ended = true; }
      if (handlers.onEvent) handlers.onEvent(value);
    };
    const consume = (text, final) => {
      buffer += text;
      if (buffer.length > 2 * 1024 * 1024) throw new Error('回复内容超过限制，请重试。');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      if (final && buffer.trim()) { lines.push(buffer); buffer = ''; }
      for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith(':') || /^event:/.test(line)) continue;
        if (line.startsWith('data:')) line = line.slice(5).trim();
        if (line === '[DONE]') { ended = true; continue; }
        let value;
        try { value = JSON.parse(line); } catch (_) { throw new Error('流式回复格式无效，请重试。'); }
        event(value);
      }
    };
    const cancel = () => { if (signal.aborted) return; controller.abort(); clearTimeout(timer); if (rejectStream) rejectStream(abortError()); if (requestTask && requestTask.abort) requestTask.abort(); };
    active.add(cancel);
    const stream = new Promise((resolve, reject) => {
      rejectStream = error => { if (settled) return; settled = true; clearTimeout(timer); reject(error); };
      timer = setTimeout(() => { rejectStream(new Error('智能问答等待超时，请重试。')); if (requestTask && requestTask.abort) requestTask.abort(); }, 120000);
      try {
        requestTask = wx.request({
          url: api.origin + '/api/chat/stream', method: 'POST', data: body,
          header: api.headers(), enableChunked: true, responseType: 'arraybuffer', dataType: 'text', timeout: 120000,
          success(response) {
            if (settled || signal.aborted) return;
            try {
              if ([404, 405].includes(response.statusCode)) { settled = true; clearTimeout(timer); resolve({ fallback: true }); return; }
              if (response.statusCode < 200 || response.statusCode >= 300) {
                let data = response.data;
                if (data instanceof ArrayBuffer) { try { data = JSON.parse(createUtf8Decoder().push(data, true)); } catch (_) { data = null; } }
                throw api.responseError({ statusCode: response.statusCode, data });
              }
              if (!receivedChunks) consume(typeof response.data === 'string' ? response.data : decoder.push(response.data, true), true);
              else consume(decoder.push(undefined, true), true);
              if (!ended) throw new Error('智能问答流意外中断，请点击重试。');
              const tail = filter.finish(); reply += tail; if (tail && handlers.onDelta) handlers.onDelta(tail);
              reply = reply.trim();
              if (!reply) throw new Error('智能问答未返回有效回复，请重试。');
              settled = true; clearTimeout(timer); resolve(Object.assign({ reply }, retrieval));
            } catch (error) { rejectStream(error); }
          },
          fail() { if (!signal.aborted) rejectStream(new Error('智能问答连接中断，请重试。')); }
        });
        if (requestTask.onHeadersReceived) requestTask.onHeadersReceived(response => { streamHeaders = response.statusCode || 200; });
        if (requestTask.onChunkReceived) requestTask.onChunkReceived(response => {
          if (settled || signal.aborted || streamHeaders < 200 || streamHeaders >= 300) return;
          try { receivedChunks = true; consume(decoder.push(response.data), false); } catch (error) { rejectStream(error); if (requestTask && requestTask.abort) requestTask.abort(); }
        });
      } catch (error) { rejectStream(error); }
    });
    const promise = stream.then(async result => {
      if (signal.aborted) throw abortError();
      if (!result.fallback) return result;
      const data = await api.json('/api/chat', { method: 'POST', data: body, timeout: 120000, signal });
      if (signal.aborted) throw abortError();
      if (!data || typeof data.reply !== 'string' || !data.reply.trim()) throw new Error('智能问答未返回有效回复，请重试。');
      append(data.reply); const tail = filter.finish(); reply += tail; if (tail && handlers.onDelta) handlers.onDelta(tail);
      return Object.assign({ reply: reply.trim() }, parseRetrieval(data));
    }).finally(() => { clearTimeout(timer); active.delete(cancel); });
    return { promise, cancel };
  }
  return { send, dispose() { for (const cancel of [...active]) cancel(); } };
}
module.exports = { createChat, createUtf8Decoder, parseRetrieval };
