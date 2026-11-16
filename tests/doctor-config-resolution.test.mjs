import test from 'node:test';
import assert from 'node:assert/strict';
import { getDoctorConfig, resolveDoctorConfig, doctorModule } from '../src/doctors/index.ts';
import { normalizeDoctorConfig } from '../src/lib/doctorConfig.ts';
import { parsePublicDoctor, parsePublicDoctorDetail, parsePublicDirectory } from '../src/hooks/useDoctorDirectory.ts';
import { getDoctorCustom } from '../src/features/services/doctorCustom.ts';
import { getServiceWorkflow } from '../src/lib/servicePlans.ts';
import { getSpecialtyRecordConfig } from '../src/lib/specialtyRecords.ts';
import { componentEnabled, configuredNavigation } from '../src/lib/builderRuntime.ts';
import { doctorProfiles } from '../src/data/doctorProfiles.ts';

const slugs = ['tang-jinsong', 'chen-zhiling', 'yu-wen', 'fu-junfen'];

test('without backend doctorConfig, Yu and Fu retain bundled config and generic service data from ca31cfd', () => {
  for (const slug of ['yu-wen', 'fu-junfen']) {
    const original = doctorProfiles.find(doctor => doctor.slug === slug);
    const before = structuredClone(original);
    for (const parsed of [parsePublicDoctor(original), parsePublicDoctorDetail(original), parsePublicDirectory([original])[0]]) {
      assert.equal(parsed.doctorConfig, undefined);
      assert.strictEqual(resolveDoctorConfig(parsed), getDoctorConfig(slug));
      assert.deepEqual(parsed.services, original.services);
      assert.ok(parsed.services.length > 0);
      assert.deepEqual(resolveDoctorConfig(parsed).profile.expertSections, []);
      // ca31cfd 没有这两位医生的定制对象，页面使用通用服务而非空分组。
      assert.equal(getDoctorCustom(parsed), undefined);
    }
    assert.deepEqual(original, before);
  }
});

test('resolveDoctorConfig selects backend v2, bundled fallback, then undefined without mutating either source', () => {
  for (const slug of slugs) {
    const bundled = getDoctorConfig(slug);
    const before = structuredClone(bundled);
    const doctorConfig = normalizeDoctorConfig({ ...structuredClone(bundled), home: { ...bundled.home, heroTitle: '后台标题' } });
    assert.strictEqual(resolveDoctorConfig({ slug, doctorConfig }), doctorConfig);
    assert.strictEqual(resolveDoctorConfig({ slug, doctorConfig, builder: {} }), doctorConfig);
    assert.strictEqual(resolveDoctorConfig({ slug }), bundled);
    assert.deepEqual(getDoctorConfig(slug), before);
  }
  assert.equal(resolveDoctorConfig({ slug: 'unconfigured-doctor' }), undefined);
});

test('public doctor parsing retains and validates backend config in directory, detail and display profile', () => {
  const bundled = getDoctorConfig('tang-jinsong');
  const doctorConfig = normalizeDoctorConfig({ ...structuredClone(bundled), theme: { ...bundled.theme, accent: '#123456' }, home: { ...bundled.home, heroTitle: '后台标题', quickQuestions: ['后台问法'] } });
  const raw = { slug: bundled.slug, name: bundled.profile.name, doctorConfig, content: [], internal: '不应公开' };
  for (const parsed of [parsePublicDoctor(raw), parsePublicDoctorDetail(raw), parsePublicDirectory([raw])[0]]) {
    assert.deepEqual(resolveDoctorConfig(parsed), doctorConfig);
    assert.equal(parsed.accent, '#123456');
    assert.deepEqual(parsed.quickQuestions, ['后台问法']);
    assert.equal(parsed.name, doctorConfig.profile.name);
    assert.equal('internal' in parsed, false);
  }
  assert.throws(() => parsePublicDoctor({ ...raw, doctorConfig: { ...doctorConfig, slug: 'another-doctor' } }), /标识必须与智能体标识一致/);
  assert.throws(() => parsePublicDoctor({ ...raw, doctorConfig: { ...doctorConfig, safety: { crisisCard: false } } }), /不能关闭或削弱/);
});

test('profile, modules, record fields and service preparation all use backend v2 on the same doctor', () => {
  const bundled = getDoctorConfig('fu-junfen');
  const doctorConfig = normalizeDoctorConfig({ ...structuredClone(bundled),
    records: { ...bundled.records, specialty: { title: '后台记录', description: '后台说明', fieldKeys: ['weightKg'] } },
    services: { ...bundled.services, preparation: ['后台准备'], groups: [{ title: '后台服务', items: ['就诊准备'] }] },
    modules: bundled.modules.map(module => ({ ...module, enabled: module.id === 'chat' ? false : module.enabled })),
  });
  const doctor = { slug: bundled.slug, doctorConfig };
  assert.deepEqual(getDoctorCustom(doctor).featureGroups, doctorConfig.services.groups);
  assert.equal(getDoctorCustom(doctor).bio.department, bundled.profile.displayDepartment);
  assert.deepEqual(getDoctorCustom(doctor).bio.topics, bundled.profile.topics);
  assert.equal(getSpecialtyRecordConfig(doctor).title, '后台记录');
  assert.deepEqual(getSpecialtyRecordConfig(doctor).fields.map(field => field.key), ['weightKg']);
  assert.deepEqual(getServiceWorkflow(doctor, '就诊准备').steps, ['后台准备', '列出本次最想沟通的问题']);
  assert.equal(doctorModule(doctor, 'chat').enabled, false);
  assert.equal(componentEnabled({ ...doctor, builder: { components: [{ id: 'chat', enabled: true }] } }, 'chat'), false);
  assert.deepEqual(configuredNavigation(doctor, [{ id: 'ask', label: '问答' }, { id: 'me', label: '我的' }]), [{ id: 'me', label: '我的' }]);
});
