const { stripChatDisclaimer, formatMedicalText, resolveDoctorEntryTab } = require('./models/chat.js');
const sections = ['privacy','chat-messages','favorites','health-records','health-daily-tasks','profile-name','voice-input-hint-dismissed','chat-assessments-v1','wellness-v1','service-plans-v1', 'builder-assessments-v1'];
const defaults = { saveChat:true, voicePlayback:true, reminders:true };
function id(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`; }
function medicalText(text) { return formatMedicalText(String(text || '')); }
function displayMessages(messages, favorites, greetingId) {
  return messages.map(m => ({ ...m, body:medicalText(m.role==='assistant'&&!m.error ? stripChatDisclaimer(m.text) : m.text), saved:favorites.some(f=>f.id===m.id), notice:m.role==='assistant'&&!m.error&&m.id!==greetingId, createdLabel:new Date(m.createdAt).toLocaleString('zh-CN'), citations:(m.citations||[]).map((c,i)=>({ index:i+1,title:c.title||c.sourceTitle||'知识库资料',sourceId:c.sourceId||'',shareUrl:c.shareUrl||'' })) }));
}
function safeSlug(value) { return typeof value==='string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value) ? value : ''; }
function resolveEntry(query, readSavedTab = () => null) {
  let slug=safeSlug(query.slug), tab=query.tab==='ask'?'ask':'home';
  if (!slug && query.path) { try { const path=decodeURIComponent(query.path); const match=/^\/d\/([a-z0-9][a-z0-9-]{0,79})(\/ask)?\/?$/.exec(path); if(match){slug=match[1];tab=match[2]?'ask':'home';} } catch {} }
  return {slug,tab:resolveDoctorEntryTab(`/d/${slug}${tab==='ask'?'/ask':''}`,slug,readSavedTab)};
}
module.exports={sections,defaults,id,medicalText,displayMessages,resolveEntry};
