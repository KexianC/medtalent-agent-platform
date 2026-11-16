import test from 'node:test';
import assert from 'node:assert/strict';
import { getDoctorConfig, configForDoctor, doctorModule } from '../src/doctors/index.ts';
import { tangJinsong } from '../src/doctors/tang-jinsong.config.ts';
import { chenZhiling } from '../src/doctors/chen-zhiling.config.ts';
import { yuWen } from '../src/doctors/yu-wen.config.ts';
import { fuJunfen } from '../src/doctors/fu-junfen.config.ts';
import { BLANK_DOCTOR_CONFIG, normalizeDoctorConfig } from '../src/lib/doctorConfig.ts';
import { normalizeAgentBuilder } from '../src/lib/agentBuilder.ts';
import { componentEnabled, configuredNavigation, healthContextEnabled, usesTangRecords, usesWellness, voiceEnabled } from '../src/lib/builderRuntime.ts';
import { doctorProfiles } from '../src/data/doctorProfiles.ts';
import { doctorCustoms, noticeLines } from '../src/data/doctorCustomData.ts';
import { doctorCustoms as configuredCustoms } from '../src/features/services/doctorCustom.ts';
import { getSpecialtyRecordConfig } from '../src/lib/specialtyRecords.ts';
import { getServiceWorkflow } from '../src/lib/servicePlans.ts';
import { buildWellnessRecordReview } from '../src/features/yuwen/recordReview.ts';

const configs = [tangJinsong, chenZhiling, yuWen, fuJunfen];
const defaultSafety = normalizeDoctorConfig({ ...structuredClone(BLANK_DOCTOR_CONFIG), slug: 'test-doctor', profile: { ...BLANK_DOCTOR_CONFIG.profile, name: '测试' } }).safety;
for (const input of configs) {
  test(`${input.slug} 模块加载校验、资料和内容保持原值，安全严格等于平台默认`, () => {
    const original = structuredClone(input);
    const config = getDoctorConfig(input.slug);
    assert.deepEqual(config, normalizeDoctorConfig(input));
    assert.deepEqual(input, original);
    assert.deepEqual(normalizeDoctorConfig(config), config);
    assert.deepEqual(config.safety, defaultSafety);
    assert.deepEqual(config.safety.noticeLines, noticeLines);
    const profile = doctorProfiles.find(item => item.slug === input.slug);
    for (const key of ['name', 'hospital', 'department', 'title', 'portrait', 'portraitPosition']) assert.equal(config.profile[key], profile[key]);
    assert.deepEqual(config.content.articles, profile.articles);
    const custom = doctorCustoms[input.slug];
    if (custom) {
      for (const key of ['featureGroups', 'off', 'servicesIntro', 'videos', 'videoPlaceholders', 'introPhoto', 'expertSections', 'bio', 'materials', 'articleDetails']) {
        assert.deepEqual(configuredCustoms[input.slug][key], custom[key], key);
      }
    }
    for (const key of ['enabled', 'crisisCard', 'showHotlinesInBoundary']) {
      assert.throws(() => normalizeDoctorConfig({ ...config, safety: { ...config.safety, [key]: false } }), /不能关闭或削弱/);
    }
    for (const safety of [undefined, null, { hotlines: ['120'] }, { noticeLines: [] }]) assert.throws(() => normalizeDoctorConfig({ ...config, safety }));
  });
}

test('未知医生返回 undefined，沿用通用默认且不继承四位医生行为', () => {
  for (const slug of ['unknown-doctor', '', '__proto__', 'constructor']) {
    assert.equal(getDoctorConfig(slug), undefined);
    assert.equal(configForDoctor({ slug }), undefined);
    assert.equal(usesTangRecords({ slug }), false);
    assert.equal(usesWellness({ slug }), false);
    assert.equal(voiceEnabled({ slug }), false);
    assert.equal(healthContextEnabled({ slug }), false);
    assert.equal(componentEnabled({ slug }, 'records'), true);
  }
});

test('四位医生的模板、记录、语音、模块与原有行为一致', () => {
  const expected = [
    [tangJinsong, true, false, true, true, 'sleep-mood-function'],
    [chenZhiling, false, false, true, false, 'standard'],
    [yuWen, false, true, false, false, 'legacy'],
    [fuJunfen, false, false, false, false, 'standard'],
  ];
  const nav = ['home', 'ask', 'manage', 'services', 'me'].map(id => ({ id, label: id }));
  for (const [config, records, wellness, voice, context, variant] of expected) {
    const doctor = { slug: config.slug };
    assert.equal(usesTangRecords(doctor), records);
    assert.equal(usesWellness(doctor), wellness);
    assert.equal(voiceEnabled(doctor), voice);
    assert.equal(healthContextEnabled(doctor), context);
    assert.equal(healthContextEnabled({ ...doctor, healthContextEnabled: false }), false);
    assert.equal(doctorModule(doctor, 'records').variant, variant);
    assert.deepEqual(configuredNavigation(doctor, nav), nav);
    assert.equal(doctorModule(doctor, 'voice').requirePlaybackOptIn, voice);
    assert.equal(doctorModule(doctor, 'diaryAdvice')?.enabled ?? false, records);
    assert.equal(doctorModule(doctor, 'visitSummary')?.enabled ?? false, records);
  }
  assert.equal(getDoctorConfig(yuWen.slug).home.showNotice, false);
  assert.equal(getDoctorConfig(fuJunfen.slug).theme.heroArtwork, 'growth');
  assert.equal(getDoctorConfig(tangJinsong.slug).home.heroTitle, '一起梳理困扰，找到下一步');
  assert.equal(getDoctorConfig(tangJinsong.slug).services.showPlanStatus, false);
  assert.equal(getDoctorConfig(chenZhiling.slug).chat.demoReplyStyle, 'ent');
});

test('同 slug 有 v1 搭建器时，继续以搭建器模块设置为准', () => {
  const builder = normalizeAgentBuilder({ schemaVersion: 1, components: [{ id: 'home', enabled: true }, { id: 'records', enabled: false }, { id: 'voice', enabled: false }, { id: 'wellness', enabled: true }] });
  for (const config of configs) {
    const doctor = { slug: config.slug, builder };
    assert.equal(configForDoctor(doctor), undefined);
    assert.equal(usesTangRecords(doctor), false);
    assert.equal(usesWellness(doctor), true);
    assert.equal(voiceEnabled(doctor), false);
    assert.equal(healthContextEnabled(doctor), false);
    assert.equal(componentEnabled(doctor, 'records'), false);
  }
});

test('专科字段、就诊准备、记录分享及导出读取配置，保留医生归属', () => {
  for (const config of configs) {
    const specialty = config.records.specialty;
    if (specialty) {
      const actual = getSpecialtyRecordConfig(config.slug);
      assert.equal(actual.title, specialty.title);
      assert.equal(actual.description, specialty.description);
      assert.deepEqual(actual.fields.map(field => field.key), specialty.fieldKeys);
    }
    assert.deepEqual(getServiceWorkflow(config.slug, '就诊准备').steps, [...config.services.preparation, '列出本次最想沟通的问题']);
  }
  const ask = getDoctorConfig(tangJinsong.slug).records.askWithRecords;
  assert.deepEqual(ask, { label: '带近期记录咨询', prompt: '请结合我最近的睡眠、情绪和日常状态记录，帮我看看最值得先调整的一点。', share: 'summary' });
  const config = getDoctorConfig(yuWen.slug);
  const review = buildWellnessRecordReview([], 7, '2026-11-16', false, { name: config.profile.name, exportPrefix: config.records.exportPrefix });
  assert.equal(review.title, '喻雯 · 睡眠与身心记录摘要');
  assert.equal(review.filename, 'yu-wen-health-2026-11-10-2026-11-16.csv');
});

test('新增字段严格校验类型、长度、枚举和专科字段白名单', () => {
  for (const mutate of [
    c => { c.home.knowledgeFocus = false; }, c => { c.home.startHint = '字'.repeat(2001); },
    c => { c.chat.showAiLabel = 'false'; }, c => { c.chat.demoReplyStyle = 'unknown'; },
    c => { c.chat.quickQuestions = Array(11).fill('问题'); }, c => { c.chat.quickQuestions = ['问题\u0000']; },
    c => { c.services.preparation = false; }, c => { c.services.showBoundaryTagline = 0; },
    c => { c.records.exportPrefix = '字'.repeat(81); }, c => { c.records.accountHint = false; },
    c => { c.records.assessmentLabel = '字'.repeat(81); },
    c => { c.records.specialty.fieldKeys = ['unknown']; }, c => { c.records.specialty.fieldKeys = []; },
    c => { c.records.specialty.fieldKeys = ['heightCm', 'heightCm']; }, c => { c.records.specialty.extra = true; },
    c => { c.records.specialty.title = ''; },
  ]) {
    const input = structuredClone(fuJunfen);
    mutate(input);
    assert.throws(() => normalizeDoctorConfig(input));
  }
});
