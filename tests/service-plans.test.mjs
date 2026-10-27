import test from 'node:test';
import assert from 'node:assert/strict';
import { doctorProfiles } from '../src/data/doctorProfiles.ts';
import { buildServicePlanSummary, emptyServicePlans, getServiceWorkflow, isServicePlanDate, normalizeServicePlans, saveServicePlan } from '../src/lib/servicePlans.ts';

const plan = (changes = {}) => ({ id: '术前准备清单', service: '术前准备清单', completed: ['整理已有检查与手术相关资料'], note: '想了解就诊前怎样整理报告。', targetDate: '2026-11-01', updatedAt: '2026-10-22T06:00:00.000Z', ...changes });

test('all eleven agents have actionable workflows for every configured service', () => {
  assert.equal(doctorProfiles.length, 11);
  let count = 0;
  for (const doctor of doctorProfiles) for (const service of doctor.services) {
    const workflow = getServiceWorkflow(doctor.slug, service);
    assert.ok(workflow.description.length > 10, `${doctor.slug}: ${service}`);
    assert.ok(workflow.steps.length >= 3);
    assert.ok(workflow.steps.length <= 16);
    assert.equal(new Set(workflow.steps).size, workflow.steps.length);
    assert.ok(workflow.steps.every(step => step.length <= 160));
    assert.ok(['record', 'prepare', 'learn', 'voice', 'assessment'].includes(workflow.action));
    count++;
  }
  assert.equal(count, 44);
  assert.notDeepEqual(getServiceWorkflow('fu-junfen', '术前准备清单').steps, getServiceWorkflow('zhou-yong', '术前准备清单').steps);
  assert.equal(getServiceWorkflow('__proto__', '自定义服务').action, 'learn');
});

test('service plans support independent creation, editing and removal without mutating prior snapshots', () => {
  const original = emptyServicePlans();
  const first = saveServicePlan(original, plan());
  const second = saveServicePlan(first, plan({ note: '已整理完成', completed: [] }));
  assert.equal(original.plans.length, 0);
  assert.equal(first.plans[0].note, '想了解就诊前怎样整理报告。');
  assert.equal(second.plans.length, 1);
  assert.equal(second.plans[0].note, '已整理完成');
  const third = saveServicePlan(second, plan({ id: '术后症状记录', service: '术后症状记录' }));
  assert.equal(third.plans.length, 2);
  assert.equal(normalizeServicePlans({ version: 1, plans: third.plans.filter(item => item.id !== '术前准备清单') }).plans[0].id, '术后症状记录');
});

test('service plan dates allow optional future planning while rejecting invalid calendar dates', () => {
  for (const date of ['', '2028-02-29', '2026-11-01', '1900-01-01', '2200-12-31']) assert.equal(isServicePlanDate(date), true, date);
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '1899-12-31', '2201-01-01', '2026-1-01', null]) assert.equal(isServicePlanDate(date), false, String(date));
});

test('malformed local service plans do not become writable cloud documents', () => {
  for (const input of [null, [], { version: 2, plans: [plan()] }, { version: 1, plans: {} }]) assert.deepEqual(normalizeServicePlans(input), emptyServicePlans());
  for (const change of [{ id: '' }, { id: 'x'.repeat(121) }, { service: '' }, { completed: [42] }, { completed: Array(17).fill('a') }, { note: 'n'.repeat(2001) }, { targetDate: '2026-02-31' }, { updatedAt: 'yesterday' }, { updatedAt: '2026-02-30T08:00:00Z' }, { updatedAt: '2026-10-22T24:00:00Z' }]) {
    assert.equal(normalizeServicePlans({ version: 1, plans: [plan(change)] }).plans.length, 0);
    assert.throws(() => saveServicePlan(emptyServicePlans(), plan(change)));
  }
  assert.equal(normalizeServicePlans({ version: 1, plans: [plan(), plan()] }).plans.length, 1);
  assert.equal(normalizeServicePlans({ version: 1, plans: [plan({ id: 'legacy-id', updatedAt: '2026-10-22T14:00:00+08:00' })] }).plans[0].id, 'legacy-id');
});

test('capacity refusal preserves every saved plan and still permits updates at the limit', () => {
  let document = emptyServicePlans();
  for (let i = 0; i < 32; i++) document = saveServicePlan(document, plan({ id: `plan-${i}` }));
  assert.throws(() => saveServicePlan(document, plan({ id: 'plan-32' })), /32/);
  assert.equal(document.plans.length, 32);
  assert.equal(saveServicePlan(document, plan({ id: 'plan-31', note: 'updated' })).plans[31].note, 'updated');
});

test('the preview summary contains only the selected plan and stays inside the chat draft limit', () => {
  const current = plan();
  const summary = buildServicePlanSummary('于卫华', current);
  assert.ok(summary.includes('于卫华智能体'));
  assert.ok(summary.includes(current.targetDate));
  assert.ok(summary.includes(current.note));
  assert.ok(summary.includes(current.completed[0]));
  assert.ok(buildServicePlanSummary('于卫华', plan({ note: '详'.repeat(2000) })).length <= 1900);
  assert.ok(!buildServicePlanSummary('于卫华', plan({ note: '', targetDate: '', completed: [] })).includes('undefined'));
});
