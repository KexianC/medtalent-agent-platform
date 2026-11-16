import assert from 'node:assert/strict';
import test from 'node:test';
import { matchDoctorVideos } from './videoMatch.mjs';

const videos = [
  { title: 'A', url: 'https://example.test/a', platform: '抖音', keywords: ['失眠', '睡不着'] },
  { title: 'B', url: 'https://example.test/b', platform: '小红书', keywords: ['焦虑'] },
  { title: 'C', url: 'https://example.test/c', platform: '抖音', keywords: ['失眠'] },
  { title: 'D', url: 'https://example.test/d', platform: '抖音', keywords: ['失眠'] },
];

test('returns only videos whose keywords hit the question', () => {
  assert.deepEqual(matchDoctorVideos('最近总是焦虑', videos).map(v => v.title), ['B']);
});
test('no hit, no video: nothing is guessed', () => {
  assert.deepEqual(matchDoctorVideos('今天天气好', videos), []);
  assert.deepEqual(matchDoctorVideos('', videos), []);
  assert.deepEqual(matchDoctorVideos('失眠', []), []);
});
test('shows at most two videos', () => {
  assert.equal(matchDoctorVideos('失眠怎么办', videos).length, 2);
});
