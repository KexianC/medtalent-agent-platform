import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as icons from '@phosphor-icons/react';

// Compile only the component dependency graph, without starting the app or API.
// Reject restricted paths before esbuild can open them.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./TangServicePanels.tsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  loader: { '.css': 'empty' }, jsx: 'automatic',
  plugins: [{ name: 'no-private-inputs', setup(builder) {
    builder.onResolve({ filter: /(^|\/)data\/|(^|\/)\.env/ }, () => { throw new Error('Restricted input'); });
  } }],
});
const compiled = { exports: {} };
const require = createRequire(import.meta.url);
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(name => name === '@phosphor-icons/react' ? icons : require(name), compiled, compiled.exports);
const { TangClinicPanel, SourceNote, TangEducationPanel, TangVisitTrends, TangVisitSummary, TangMessagePanel } = compiled.exports;
const render = (component, props) => renderToStaticMarkup(createElement(component, props));

test('clinic cards merge departments by campus and preserve booking-only campuses without fake images', () => {
  const bio = { clinics: [{ campus: '钱塘院区', times: ['专家门诊 周二上午', '名医门诊 周二下午'] }], bookingDepartments: [
    { campus: '钱塘院区', department: '科室甲' }, { campus: '钱塘院区', department: '科室乙' }, { campus: '庆春院区', department: '科室丙' },
  ] };
  const html = render(TangClinicPanel, { bio, onPrepare() {} });
  assert.equal((html.match(/class="tang-svc-box tang-clinic-card"/g) || []).length, 2);
  assert.match(html, /<dt>专家门诊<\/dt><dd>周二上午<\/dd>/);
  assert.match(html, /<dt>名医门诊<\/dt><dd>周二下午<\/dd>/);
  assert.match(html, /科室甲.*科室乙.*aria-label="庆春院区".*门诊时间待确认.*科室丙/);
  assert.doesNotMatch(html, /<img/);
  bio.clinics[0].image = '/campus.jpg';
  assert.match(render(TangClinicPanel, { bio, onPrepare() {} }), /<img src="\/campus.jpg" alt="钱塘院区"/);
});

test('source notes render all requested groups with safe external links and one fixed footer', () => {
  for (const [key, count] of [['breath', 1], ['pmr', 4], ['family', 8], ['quit', 3]]) {
    const html = render(SourceNote, { keys: [key] });
    assert.match(html, /<summary>查看依据<\/summary>/);
    assert.equal((html.match(/target="_blank" rel="noreferrer"/g) || []).length, count);
    assert.equal((html.match(/以上为公开资料，用于健康科普，不是治疗方案。/g) || []).length, 1);
    if (key === 'breath' || key === 'pmr') {
      assert.match(html, /<ul><li>中国睡眠研究会《失眠症诊断和治疗指南（2025 版）》，[^<]+<\/li><li>中华医学会神经病学分会睡眠障碍学组/);
      assert.equal((html.match(/<li>/g) || []).length, key === 'breath' ? 2 : 5);
      assert.doesNotMatch(html, /href="undefined"/);
    }
    if (key === 'breath') assert.doesNotMatch(html, /NHS|Zaccaro|Birdee/);
  }
});

test('education defaults to articles, keeps videos in a hidden tab and links provided videos externally', () => {
  const html = render(TangEducationPanel, { videos: [], children: createElement('p', null, '已有文章') });
  assert.match(html, /aria-selected="true"[^>]*>科普文章/);
  assert.match(html, /hidden=""[^>]*><p>科普视频待医生提供/);
  assert.match(html, /已有文章/);
  const populated = render(TangEducationPanel, { videos: [{ title: '医生视频', url: 'https://example.org/video', platform: '医院官网', keywords: [] }] });
  assert.match(populated, /href="https:\/\/example.org\/video"[^>]*target="_blank" rel="noreferrer"/);
  assert.doesNotMatch(populated, /<iframe|<video/);
});

const dateKey = offset => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const record = (offset, metrics) => ({ id: `record-${offset}`, dateKey: dateKey(offset), createdAt: `${dateKey(offset)}T08:00:00+08:00`, source: 'manage', completedTitles: [], metrics });

test('each trend needs two distinct recorded dates, retains zero moods, and never fills missing dates', () => {
  const sparse = render(TangVisitTrends, { records: [record(-1, { sleepDurationMinutes: 360 }), record(0, { moodScore: 5 })] });
  assert.equal((sparse.match(/记录满 2 天后显示趋势/g) || []).length, 2);
  assert.doesNotMatch(sparse, /<svg/);
  const populated = render(TangVisitTrends, { records: [record(-2, { sleepDurationMinutes: 360, moodScore: 0 }), record(0, { sleepDurationMinutes: 420, moodScore: 5 })] });
  assert.equal((populated.match(/<svg/g) || []).length, 2);
  assert.equal((populated.match(/<circle/g) || []).length, 4);
  assert.match(populated, /：0\.0 \/ 10/);
  assert.doesNotMatch(populated, /改善|恶化/);
});

test('empty visit summary shows only the empty-state guidance, without trend placeholders', () => {
  const html = render(TangVisitSummary, { records: [], questions: '' });
  assert.doesNotMatch(html, /记录满 2 天后显示趋势/);
  assert.match(html, /还没有近 30 天的记录。填写睡眠日记、用药、戒烟或量表后，这里会自动整理成一页。/);
});

test('message panel saves to visit preparation, stays honest about delivery and keeps the emergency line', () => {
  const html = render(TangMessagePanel, { onSubmit() {}, onPrepare() {} });
  assert.match(html, /目前留言不会转给医生，也没有人工回复。如遇紧急情况，请立即拨打 120 或前往急诊。/);
  assert.match(html, /保存到就诊准备/);
  assert.doesNotMatch(html, /已发送|联系医生团队/);
});

test('local mp4 videos play in the page while external videos stay links', () => {
  const html = render(TangEducationPanel, { videos: [{ title: '本地视频', url: '/assets/doctors/videos/a.mp4', platform: '医院', keywords: [] }] });
  assert.match(html, /aria-expanded="false"[^>]*>.*本地视频.*点击播放/);
  assert.doesNotMatch(html, /<video|href="\/assets/);
});
