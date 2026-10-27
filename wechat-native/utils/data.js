const { consumerSections } = require('./consumer-data.js');
const copy = value => JSON.parse(JSON.stringify(value));
const chats = ['chat-messages', 'chat-assessments-v1'];
function combineImported(local, cloud) {
  if (cloud == null) return local;
  if (Array.isArray(local) && Array.isArray(cloud)) {
    const identity = item => item && typeof item === 'object' && 'id' in item ? item.id : item && typeof item === 'object' && 'date' in item && 'goalId' in item ? item.date + ':' + item.goalId : JSON.stringify(item);
    const existing = new Set(cloud.map(identity));
    return [...cloud, ...local.filter(item => !existing.has(identity(item)))];
  }
  if (local && cloud && typeof local === 'object' && typeof cloud === 'object' && !Array.isArray(local) && !Array.isArray(cloud)) {
    const merged = Object.assign({}, cloud);
    for (const key of Object.keys(local)) if (!['__proto__', 'prototype', 'constructor'].includes(key)) merged[key] = combineImported(local[key], merged[key]);
    return merged;
  }
  return cloud;
}
function createData({ storage, cloud, session }) {
  const listeners = new Set();
  const entries = new Map();
  const ephemeral = new Map();
  let visitorId;
  try { visitorId = storage.getItem('medtalent:visitor-id'); } catch (_) { /* Use memory. */ }
  if (!visitorId) {
    visitorId = 'guest-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    try { storage.setItem('medtalent:visitor-id', visitorId); } catch (_) { /* Use memory. */ }
  }
  const emit = () => { for (const listener of [...listeners]) listener(); };
  const guestKey = (slug, section) => 'medtalent:' + visitorId + ':' + slug + ':' + section;
  const identity = () => session.get().user;
  const memoryKey = (slug, section) => (identity() ? identity().id : visitorId) + ':' + slug + ':' + section;
  const unsubscribeCloud = cloud.subscribe(emit);
  let previousOwner = identity() && identity().id;
  const unsubscribeSession = session.subscribe(() => {
    const owner = identity() && identity().id;
    if (owner !== previousOwner) { ephemeral.clear(); previousOwner = owner; }
    emit();
  });
  function readGuest(slug, section, fallback) {
    const key = guestKey(slug, section);
    if (!entries.has(key)) {
      let raw;
      try {
        raw = storage.getItem(key);
      } catch (_) { entries.set(key, { value: null, status: 'memory-only', error: '本机存储暂时不可用，修改仅保留在当前会话。' }); }
      if (!entries.has(key)) {
        try { entries.set(key, { value: raw == null ? null : JSON.parse(raw), status: 'ready' }); }
        catch (_) { entries.set(key, { value: null, status: 'error', invalid: true, errorCode: 'INVALID_DATA', error: '本机记录格式异常，原记录未被覆盖。请先核对原记录或在隐私设置中确认清除。' }); }
      }
    }
    const entry = entries.get(key);
    return Object.assign({}, entry, { value: entry.value == null ? copy(fallback) : copy(entry.value), canEdit: !entry.invalid, revision: null });
  }
  function get(slug, section, fallback) {
    if (chats.includes(section) && get(slug, 'privacy', { saveChat: true }).value.saveChat === false) {
      const key = memoryKey(slug, section);
      return { value: ephemeral.has(key) ? copy(ephemeral.get(key)) : copy(fallback), status: 'memory-only', canEdit: !identity() || cloud.get(slug, 'privacy', null).canEdit, revision: null };
    }
    return identity() ? cloud.get(slug, section, fallback) : readGuest(slug, section, fallback);
  }
  function set(slug, section, value) {
    if (!consumerSections.includes(section) || value === undefined) return false;
    if (chats.includes(section) && get(slug, 'privacy', { saveChat: true }).value.saveChat === false) {
      if (identity() && !cloud.get(slug, 'privacy', null).canEdit) return false;
      ephemeral.set(memoryKey(slug, section), copy(value)); emit(); return true;
    }
    let accepted;
    if (identity()) accepted = cloud.set(slug, section, value);
    else {
      const key = guestKey(slug, section);
      if (!readGuest(slug, section, null).canEdit) return false;
      const entry = { value: copy(value), status: 'ready' };
      try { storage.setItem('medtalent:visitor-id', visitorId); storage.setItem(key, JSON.stringify(value)); }
      catch (_) { entry.status = 'memory-only'; entry.pendingWrite = true; entry.error = '本机存储暂时不可用，修改仅保留在当前会话。'; }
      entries.set(key, entry); accepted = true; emit();
    }
    if (accepted && section === 'privacy' && value && value.saveChat === false) {
      for (const name of chats) {
        ephemeral.delete(memoryKey(slug, name));
        if (!identity()) { entries.delete(guestKey(slug, name)); try { storage.removeItem(guestKey(slug, name)); } catch (_) { /* Already excluded by privacy state. */ } }
      }
      emit();
    }
    return accepted;
  }
  function hasGuestData(slug) {
    return consumerSections.some(section => { try { return storage.getItem(guestKey(slug, section)) !== null; } catch (_) { return false; } });
  }
  async function importGuest(slug) {
    const owner = identity();
    if (!owner) throw new Error('请先登录微信账户。');
    await cloud.load(slug);
    if (!identity() || identity().id !== owner.id) throw new Error('账户已变化，请重新操作。');
    const copied = [];
    const guestPrivacy = readGuest(slug, 'privacy', { saveChat: true }).value;
    const cloudPrivacy = cloud.get(slug, 'privacy', { saveChat: true }).value;
    for (const section of consumerSections) {
      const raw = storage.getItem(guestKey(slug, section));
      if (raw === null) continue;
      if (chats.includes(section) && (guestPrivacy.saveChat === false || cloudPrivacy.saveChat === false)) continue;
      let value;
      try { value = JSON.parse(raw); } catch (_) { throw new Error('本机记录格式异常，请先核对记录。'); }
      if (!cloud.set(slug, section, combineImported(value, cloud.get(slug, section, null).value))) throw new Error('云端记录尚未就绪，请重试。');
      copied.push({ section, raw });
    }
    await cloud.flush();
    if (!identity() || identity().id !== owner.id) throw new Error('账户已变化，本机原记录仍保留。');
    for (const item of copied) if (cloud.get(slug, item.section, null).status !== 'synced') throw new Error('部分记录尚未同步，本机原记录仍保留。');
    for (const item of copied) if (storage.getItem(guestKey(slug, item.section)) === item.raw) { storage.removeItem(guestKey(slug, item.section)); entries.delete(guestKey(slug, item.section)); }
    emit();
  }
  function resetGuest() {
    if (identity()) throw new Error('请先退出账户后清理本机游客记录。');
    const prefix = 'medtalent:' + visitorId + ':';
    const sessionPrefix = 'medtalent:session:' + visitorId + ':';
    const snapshots = new Map();
    let originalVisitor;
    try {
      let keys;
      if (typeof storage.listKeys === 'function') keys = storage.listKeys();
      else if (typeof storage.key === 'function' && Number.isInteger(storage.length)) keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
      else throw new Error('无法枚举本机存储。');
      if (!Array.isArray(keys)) throw new Error('本机存储列表异常。');
      for (const key of keys) if (typeof key === 'string' && (key.startsWith(prefix) || key.startsWith(sessionPrefix))) snapshots.set(key, storage.getItem(key));
      originalVisitor = storage.getItem('medtalent:visitor-id');
    } catch (_) { throw new Error('未能读取本机记录，尚未开始清除。请检查存储权限后重试。'); }
    const nextVisitor = 'guest-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    const removed = [];
    try {
      for (const [key, raw] of snapshots) {
        removed.push([key, raw]);
        storage.removeItem(key);
        if (storage.getItem(key) !== null) throw new Error('本机记录未删除。');
      }
      storage.setItem('medtalent:visitor-id', nextVisitor);
      if (storage.getItem('medtalent:visitor-id') !== nextVisitor) throw new Error('游客身份未保存。');
    } catch (_) {
      let restored = true;
      for (const [key, raw] of removed) {
        try { if (raw === null) storage.removeItem(key); else storage.setItem(key, raw); if (storage.getItem(key) !== raw) restored = false; }
        catch (_) { restored = false; }
      }
      try { if (originalVisitor === null) storage.removeItem('medtalent:visitor-id'); else storage.setItem('medtalent:visitor-id', originalVisitor); if (storage.getItem('medtalent:visitor-id') !== originalVisitor) restored = false; }
      catch (_) { restored = false; }
      throw new Error(restored ? '未完成清除，原游客身份与记录已保留。请检查本机存储后重试。' : '未完成清除，部分本机记录可能已删除，当前会话仍保留。请检查本机存储后重试。');
    }
    for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
    for (const key of ephemeral.keys()) if (key.startsWith(visitorId + ':')) ephemeral.delete(key);
    visitorId = nextVisitor;
    emit();
    return true;
  }
  return {
    get, set, hasGuestData, importGuest, resetGuest,
    getVisitorId: () => visitorId,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    load: cloud.load, flush: cloud.flush,
    async retry(slug, section) {
      if (identity()) return cloud.retry(slug, section);
      const key = guestKey(slug, section);
      const entry = entries.get(key);
      if (entry && entry.pendingWrite) {
        try {
          storage.setItem('medtalent:visitor-id', visitorId);
          storage.setItem(key, JSON.stringify(entry.value));
          entries.set(key, { value: copy(entry.value), status: 'ready' });
        } catch (_) { /* Keep the pending value until a later retry succeeds. */ }
      } else { entries.delete(key); readGuest(slug, section, null); }
      emit();
    },
    resolveConflict: cloud.resolveConflict,
    dispose() { unsubscribeCloud(); unsubscribeSession(); listeners.clear(); }
  };
}
module.exports = { createData, combineImported };
