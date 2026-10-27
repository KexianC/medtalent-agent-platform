// Like H5 sessionStorage, UI drafts and selected tabs live only in this app session.
// Account and doctor scopes are independent; sensitive drafts are never uploaded.
const entries = new Map();
const key = (owner, slug) => JSON.stringify([owner || 'guest', slug]);
function read(owner, slug, section, fallback = '') {
  const value = entries.get(key(owner, slug));
  return value && Object.prototype.hasOwnProperty.call(value, section) ? value[section] : fallback;
}
function write(owner, slug, section, value) {
  const scope = key(owner, slug);
  entries.set(scope, { ...(entries.get(scope) || {}), [section]: value });
}
function clear(owner, slug) { entries.delete(key(owner, slug)); }
function clearOwner(owner) {
  for (const scope of entries.keys()) {
    const storedOwner = JSON.parse(scope)[0];
    if (storedOwner === (owner || 'guest') || (owner === 'guest' && storedOwner.startsWith('guest:'))) entries.delete(scope);
  }
}
module.exports = { read, write, clear, clearOwner };
