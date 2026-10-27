import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createNativeLoader } from '../scripts/native-module-loader.mjs';
import { ASSESSMENT_SOURCE, ASSESSMENT_MANUAL } from '../src/features/yuwen/assessmentModel.ts';

const { openReferenceDocument, REFERENCE_DOCUMENT_URLS } = createNativeLoader()(fileURLToPath(new URL('../wechat-native/utils/reference-document.js', import.meta.url)));
function host() {
  const downloads = [], documents = [];
  const wx = {
    downloadFile(options) { const task = { options, aborted: false, abort() { this.aborted = true; options.fail({ errMsg: 'downloadFile:fail abort' }); } }; downloads.push(task); return task; },
    openDocument(options) { documents.push(options); },
    setClipboardData() { assert.fail('opening a document must never silently copy its URL'); }
  };
  return { wx, downloads, documents };
}
test('reference viewer downloads only the two H5 source PDFs and resolves only after native document open succeeds', async () => {
  assert.deepEqual(Array.from(REFERENCE_DOCUMENT_URLS), [ASSESSMENT_SOURCE, ASSESSMENT_MANUAL]);
  for (const url of REFERENCE_DOCUMENT_URLS) {
    const f = host(); const handle = openReferenceDocument(url, { wx: f.wx });
    let complete = false; handle.promise.then(() => { complete = true; });
    assert.equal(f.downloads[0].options.url, url); assert.equal(f.documents.length, 0);
    assert.equal(f.downloads[0].options.header, undefined);
    assert.equal(f.downloads[0].options.filePath, undefined, 'use a native temporary file, not a packaged or persistent PDF');
    f.downloads[0].options.success({ statusCode: 200, tempFilePath: '/wx-temp/source.pdf' });
    assert.equal(f.documents[0].fileType, 'pdf'); assert.equal(f.documents[0].showMenu, true);
    await Promise.resolve(); assert.equal(complete, false);
    f.documents[0].success(); assert.equal((await handle.promise).filePath, '/wx-temp/source.pdf');
    assert.equal(complete, true);
  }
});
test('unsupported, insecure or altered source URLs never start a download', async () => {
  for (const url of ['http://inform-iadr.com/source.pdf', 'https://example.invalid/source.pdf', ASSESSMENT_SOURCE + '?other=1', ASSESSMENT_MANUAL.replace('www.phqscreeners.com', 'www.phqscreeners.com.evil.invalid'), 'javascript:alert(1)', null]) {
    const f = host(); const handle = openReferenceDocument(url, { wx: f.wx });
    await assert.rejects(handle.promise, /不受支持/); assert.equal(f.downloads.length, 0); assert.equal(f.documents.length, 0);
  }
});
test('non-200, missing temporary file, download failure and native open failure remain explicit retryable errors', async () => {
  for (const statusCode of [204, 302, 403, 404, 500]) {
    const f = host(); const handle = openReferenceDocument(ASSESSMENT_SOURCE, { wx: f.wx });
    f.downloads[0].options.success({ statusCode, tempFilePath: '/wx-temp/not-a-pdf' });
    await assert.rejects(handle.promise, new RegExp('HTTP ' + statusCode + '.*重试')); assert.equal(f.documents.length, 0);
  }
  const missing = host(); const missingHandle = openReferenceDocument(ASSESSMENT_SOURCE, { wx: missing.wx });
  missing.downloads[0].options.success({ statusCode: 200 }); await assert.rejects(missingHandle.promise, /未取得原文文件.*重试/);
  const offline = host(); const offlineHandle = openReferenceDocument(ASSESSMENT_SOURCE, { wx: offline.wx });
  offline.downloads[0].options.fail({ errMsg: 'network error' }); await assert.rejects(offlineHandle.promise, /下载失败.*重试/);
  const unsupported = openReferenceDocument(ASSESSMENT_SOURCE, { wx: {} }); await assert.rejects(unsupported.promise, /不支持.*重试/);
  const brokenOpen = host(); const brokenHandle = openReferenceDocument(ASSESSMENT_SOURCE, { wx: brokenOpen.wx });
  brokenOpen.downloads[0].options.success({ statusCode: 200, tempFilePath: '/wx-temp/source.pdf' });
  brokenOpen.documents[0].fail({ errMsg: 'unsupported document' }); await assert.rejects(brokenHandle.promise, /未能打开.*重试/);
  brokenOpen.documents[0].success(); await assert.rejects(brokenHandle.promise, /未能打开/);
});
test('cancel aborts download and late download or open callbacks cannot report successful viewing', async () => {
  const f = host(); const handle = openReferenceDocument(ASSESSMENT_SOURCE, { wx: f.wx });
  handle.cancel(); assert.equal(f.downloads[0].aborted, true);
  await assert.rejects(handle.promise, error => error.name === 'AbortError' && /取消.*重试/.test(error.message));
  f.downloads[0].options.success({ statusCode: 200, tempFilePath: '/wx-temp/late.pdf' }); assert.equal(f.documents.length, 0);
  const opening = host(); const openingHandle = openReferenceDocument(ASSESSMENT_SOURCE, { wx: opening.wx });
  opening.downloads[0].options.success({ statusCode: 200, tempFilePath: '/wx-temp/source.pdf' }); openingHandle.cancel();
  opening.documents[0].success(); await assert.rejects(openingHandle.promise, error => error.name === 'AbortError');
  const nativeCancel = host(); const nativeHandle = openReferenceDocument(ASSESSMENT_SOURCE, { wx: nativeCancel.wx });
  nativeCancel.downloads[0].options.fail({ errMsg: 'downloadFile:fail abort' }); await assert.rejects(nativeHandle.promise, error => error.name === 'AbortError');
});
test('a stalled native document callback fails within its deadline and later callbacks stay inactive', async () => {
  const f = host(); const handle = openReferenceDocument(ASSESSMENT_SOURCE, { wx: f.wx, timeoutMs: 5 });
  f.downloads[0].options.success({ statusCode: 200, tempFilePath: '/wx-temp/source.pdf' });
  await assert.rejects(handle.promise, /超时.*重试/); assert.equal(f.downloads[0].aborted, true);
  f.documents[0].success(); await assert.rejects(handle.promise, /超时/);
});
