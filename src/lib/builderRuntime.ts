import { configForDoctor, doctorModule } from '../doctors/index.ts';
export { getBuilderComponents } from './agentBuilder.ts';
import type { DoctorProfile } from '../data/doctorProfiles';
import type { SpecialtyRecordConfig } from './specialtyRecords';
import type { AgentBuilderConfig, BuilderComponentId } from './agentBuilder';
export type BuilderDoctor = Pick<DoctorProfile, 'slug'> & { builder?: AgentBuilderConfig; healthContextEnabled?: boolean };
export const componentEnabled = (doctor: BuilderDoctor, id: BuilderComponentId) => doctor.builder ? doctor.builder.components.some(item => item.id === id && item.enabled) : doctorModule(doctor, id)?.enabled ?? true;
export const usesWellness = (doctor: BuilderDoctor) => doctor.builder ? componentEnabled(doctor, 'wellness') : doctorModule(doctor, 'wellness')?.enabled === true;
export const usesTangRecords = (doctor: BuilderDoctor) => doctorModule(doctor, 'records')?.variant === 'sleep-mood-function';
export const voiceEnabled = (doctor: BuilderDoctor) => doctor.builder ? componentEnabled(doctor, 'voice') && doctor.builder.voice.enabled : doctorModule(doctor, 'voice')?.enabled === true;
export const healthContextEnabled = (doctor: BuilderDoctor) => doctor.healthContextEnabled !== false && (doctor.builder ? doctor.builder.healthContext !== false && componentEnabled(doctor, 'records') : usesTangRecords(doctor));
export function configuredRecordConfig(doctor: BuilderDoctor, fallback: SpecialtyRecordConfig): SpecialtyRecordConfig {
  if (!doctor.builder) return fallback;
  return { title: '日常健康记录', description: '按实际情况填写配置的健康指标，未测量的项目可留空。', fields: doctor.builder.recordFields.map(field => ({ key: field.key, label: field.label, unit: field.unit || '', min: field.min ?? -100000, max: field.max ?? 100000, step: field.step ?? 1, ...(field.type === undefined ? {} : {type:field.type}), ...(field.group === undefined ? {} : {group:field.group}), ...(field.options === undefined ? {} : {options:field.options}) })) };
}
export function configuredNavigation<T extends { id: string; label: string }>(doctor: BuilderDoctor, items: T[]): T[] {
  if (!doctor.builder && !configForDoctor(doctor)) return items;
  const ids: Record<string, BuilderComponentId> = { home: 'home', ask: 'chat', manage: 'records', services: 'services' };
  const navigation = items.filter(item => item.id === 'me' || componentEnabled(doctor, ids[item.id]) || item.id === 'manage' && (componentEnabled(doctor, 'assessments') || usesWellness(doctor)) || item.id === 'services' && usesWellness(doctor))
    .map(item => { const component = (doctor.builder?.components ?? configForDoctor(doctor)!.modules).find(value => value.id === ids[item.id]); return { ...item, label: (component && "label" in component ? component.label : undefined) || item.label }; })
    .sort((a,b) => (a.id === 'me' ? 10001 : (doctor.builder?.components ?? configForDoctor(doctor)!.modules).find(item => item.id === ids[a.id])?.order ?? 10000) - (b.id === 'me' ? 10001 : (doctor.builder?.components ?? configForDoctor(doctor)!.modules).find(item => item.id === ids[b.id])?.order ?? 10000));
  return navigation.length === items.length && navigation.every((item, index) => item.id === items[index].id && item.label === items[index].label) ? items : navigation;
}
export function realHealthReminder(recordedDays: number, todayRecorded: boolean) {
  if (todayRecorded) return '今天已有健康记录，可继续补充实际变化，或在管理页回顾。';
  return recordedDays ? '近 7 日已记录 ' + recordedDays + ' 天；今天如有新的测量或感受，可按实际情况补充。' : '还没有近期健康记录，可按实际情况填写；记录仅用于个人梳理和就医准备。';
}

export const canWriteBuilderData = (doctor: BuilderDoctor, section: 'records'|'assessments'|'services') => doctor.builder?.dataPermissions?.[section] !== 'read-only';

export function builderLayoutClass(doctor: BuilderDoctor) { return doctor.builder?.layout ? 'builder-density-' + doctor.builder.layout.density + ' builder-cards-' + doctor.builder.layout.cards : ''; }
