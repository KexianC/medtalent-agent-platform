import assert from 'node:assert/strict';
import test from 'node:test';
import { tangReferenceView, TANG_TRANSCRIPT_NOTE } from './referenceNames.mjs';

const cite = (title, shareUrl) => ({ title, ...(shareUrl ? { shareUrl } : {}) });

test('recording transcripts collapse into one note and are not listed', () => {
  const view = tangReferenceView([cite('Tue Nov 18 2025 14_46_30 GMT+0800_原文.docx', '/api/citations/a/b/0'), cite('Mon Nov 24 2025 08_22_48 GMT+0800_原文.docx')]);
  assert.equal(view.fromTranscripts, true);
  assert.deepEqual(view.formal, []);
  assert.equal(TANG_TRANSCRIPT_NOTE, '内容参考唐劲松医生讲解整理');
});

test('formal documents stay listed in order without extension', () => {
  const guide = cite('失眠什么时候该就医.pdf', '/api/citations/a/c/1');
  const view = tangReferenceView([guide, cite('Tue Nov 25 2025 13_33_55 GMT+0800_原文.docx'), cite('讲解.v2.docx'), cite('无扩展名')]);
  assert.equal(view.fromTranscripts, true);
  assert.deepEqual(view.formal.map((item) => item.name), ['失眠什么时候该就医', '讲解.v2', '无扩展名']);
  assert.equal(view.formal[0].citation, guide);
});

test('invalid timestamps are treated as ordinary documents', () => {
  for (const title of ['Tue Feb 30 2025 14_46_30 GMT+0800_原文.docx', 'Tue Nov 18 2025 25_46_30 GMT+0800_原文.docx', 'Tue Nov 18 2025 14_46_30 GMT+0800_其他.docx']) {
    const view = tangReferenceView([cite(title)]);
    assert.equal(view.fromTranscripts, false, title);
    assert.deepEqual(view.formal.map((item) => item.name), [title.slice(0, -5)]);
  }
  assert.deepEqual(tangReferenceView([]), { fromTranscripts: false, formal: [] });
});
