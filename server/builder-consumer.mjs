import { PlatformError } from './domain.mjs';

export function validateBuilderAssessmentResults(value) {
  const invalid = () => new PlatformError('量表记录格式无效。', 400, 'INVALID_DOCUMENT');
  const record = item => item && typeof item === 'object' && !Array.isArray(item);
  const text = (item,max) => typeof item === 'string' && item.trim().length > 0 && item.length <= max;
  if (!record(value) || Object.keys(value).some(key => !['version','results'].includes(key)) || value.version !== 1 || !Array.isArray(value.results) || value.results.length > 100) throw invalid();
  const ids = new Set();
  for (const result of value.results) {
    if (!record(result) || Object.keys(result).some(key => !['id','assessmentId','title','answers','score','createdAt','source','definitionVersion','resultLabel','resultDescription'].includes(key))
      || !text(result.id,120) || ids.has(result.id) || !text(result.assessmentId,100) || !text(result.title,200)
      || !Array.isArray(result.answers) || result.answers.length < 1 || result.answers.length > 30
      || result.answers.some(answer => typeof answer !== 'number' || !Number.isFinite(answer) || Math.abs(answer) > 10000)
      || typeof result.score !== 'number' || !Number.isFinite(result.score)
      || Math.abs(result.answers.reduce((sum,answer)=>sum+answer,0) - result.score) > 1e-8
      || typeof result.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(result.createdAt)
      || !Number.isFinite(Date.parse(result.createdAt))) throw invalid();
    for (const [key,max] of [['source',1000],['definitionVersion',100],['resultLabel',100],['resultDescription',1000]]) if (result[key] !== undefined && (typeof result[key] !== 'string' || result[key].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result[key]))) throw invalid();
    ids.add(result.id);
  }
  return value;
}

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
export function isOnlyComponentRemoval(section, previous, next) {
 if (next === null) return true;
 const collection = section === 'builder-assessments-v1' ? 'results' : section === 'service-plans-v1' ? 'plans' : null;
 let before=previous,after=next;
 if(collection){
  if(!previous||!next||previous.version!==next.version||Object.keys(next).some(key=>!['version',collection].includes(key)))return false;
  before=previous[collection];after=next[collection];
 }
 if(!Array.isArray(before)||!Array.isArray(after)||after.length>before.length)return false;
 const remaining=new Map();for(const item of before){const key=JSON.stringify(canonical(item));remaining.set(key,(remaining.get(key)||0)+1)}
 for(const item of after){const key=JSON.stringify(canonical(item));if(!remaining.get(key))return false;remaining.set(key,remaining.get(key)-1)}
 return true;
}
