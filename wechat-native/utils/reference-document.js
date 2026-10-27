const { ASSESSMENT_SOURCE, ASSESSMENT_MANUAL } = require('./models/wellness.js');
const REFERENCE_DOCUMENT_URLS = Object.freeze([ASSESSMENT_SOURCE, ASSESSMENT_MANUAL]);

function openReferenceDocument(url, options = {}) {
  const host = options.wx || (typeof wx !== 'undefined' ? wx : null);
  const timeout = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 45000;
  let task, timer, settled = false, resolve, reject, filePath;
  const promise = new Promise((success, failure) => { resolve = success; reject = failure; });
  function finish(error) {
    if (settled) return;
    settled = true; clearTimeout(timer);
    if (error) reject(error); else resolve({ filePath });
  }
  function failure(message, cancelled = false) {
    const error = new Error(message);
    error.name = cancelled ? 'AbortError' : 'ReferenceDocumentError';
    finish(error);
  }
  function abortDownload() { try { if (task && task.abort) task.abort(); } catch (_) { /* Already completed. */ } }
  function cancel() {
    if (settled) return;
    failure('查看已取消，请再次点击原文链接重试。', true);
    abortDownload();
  }
  if (!REFERENCE_DOCUMENT_URLS.includes(url)) failure('此原文链接不受支持，请使用量表页面提供的原文链接。');
  else if (!host || typeof host.downloadFile !== 'function' || typeof host.openDocument !== 'function') failure('当前环境不支持 PDF 文档查看，请稍后重试。');
  else {
    timer = setTimeout(() => { failure('原文查看超时，请检查网络后重试。'); abortDownload(); }, timeout);
    try {
      task = host.downloadFile({ url, timeout,
        success(result) {
          if (settled) return;
          if (result.statusCode !== 200) { failure('原文下载失败（HTTP ' + result.statusCode + '），请稍后点击原文链接重试。'); return; }
          if (!result.tempFilePath) { failure('未取得原文文件，请再次点击原文链接重试。'); return; }
          filePath = result.tempFilePath;
          try { host.openDocument({ filePath, fileType: 'pdf', showMenu: true,
            success() { finish(); },
            fail() { failure('PDF 未能打开，请再次点击原文链接重试。'); }
          }); } catch (_) { failure('PDF 未能打开，请再次点击原文链接重试。'); }
        },
        fail(error) { if (error && /abort|cancel/i.test(error.errMsg || '')) failure('查看已取消，请再次点击原文链接重试。', true); else failure('原文下载失败，请检查网络后重试。'); }
      });
    } catch (_) { failure('原文下载失败，请检查网络后重试。'); }
  }
  return { promise, cancel };
}
module.exports = { openReferenceDocument, REFERENCE_DOCUMENT_URLS };
