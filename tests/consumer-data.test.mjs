import assert from 'node:assert/strict';
import test from 'node:test';
import { createConsumerDataStore } from '../src/lib/consumerData.ts';

const doctor = 'tang-jinsong';
const section = 'chat-messages';
const identity = (userId = 'user-a') => ({ userId, csrfToken: `csrf-${userId}` });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
const clone = value => JSON.parse(JSON.stringify(value));
function memoryStorage() {
  const items = new Map();
  return { items, getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value), removeItem: key => items.delete(key) };
}
function backend() {
  const documents = new Map();
  const requests = [];
  function client(initialUser = 'user-a') {
    const controls = { user: initialUser, csrfToken: null, offline: false, readGate: null, writeGate: null, dropNextAck: false };
    const fetchImpl = async (url, options = {}) => {
      const user = controls.user;
      const parsedUrl = new URL(url, 'https://agent.example');
      const [slug, name] = parsedUrl.pathname.replace('/api/user/data/', '').split('/').map(decodeURIComponent);
      const key = `${user}/${slug}/${name}`;
      const method = options.method || 'GET';
      requests.push({ user, slug, name, method, query: parsedUrl.search, credentials: options.credentials, ...(options.body ? JSON.parse(options.body) : {}) });
      if (controls.offline) throw new TypeError('Failed to fetch');
      if (method === 'GET') {
        const rows = [...documents].filter(([id]) => id.startsWith(`${user}/${slug}/`)).map(([, item]) => clone(item));
        const gate = controls.readGate;
        controls.readGate = null;
        if (gate) await gate.promise;
        return Response.json({ documents: rows });
      }
      assert.equal(options.credentials, 'include');
      assert.equal(options.headers['X-CSRF-Token'], controls.csrfToken || `csrf-${user}`);
      const current = documents.get(key) ?? { section: name, value: null, revision: 0 };
      const body = JSON.parse(options.body);
      if (body.expectedRevision !== current.revision) return Response.json({ code: 'DATA_CONFLICT', document: clone(current) }, { status: 409 });
      const stored = { section: name, value: clone(body.value), revision: current.revision + 1, updatedAt: new Date().toISOString() };
      documents.set(key, stored);
      const gate = controls.writeGate;
      controls.writeGate = null;
      if (gate) await gate.promise;
      if (controls.dropNextAck) { controls.dropNextAck = false; throw new TypeError('Failed to fetch'); }
      return Response.json({ document: clone(stored) });
    };
    return { controls, fetchImpl };
  }
  return { documents, requests, client };
}
function device(server, storage = memoryStorage()) {
  const connection = server.client();
  const store = createConsumerDataStore({ fetchImpl: connection.fetchImpl, storage });
  store.setIdentity(identity());
  return { store, storage, ...connection };
}

test('requires an authenticated GET baseline and never imports guest storage', async () => {
  const server = backend();
  const storage = memoryStorage();
  storage.setItem('doctor:tang-jinsong:chat-messages', JSON.stringify(['guest conversation']));
  const { store } = device(server, storage);
  assert.equal(store.get(doctor, section, []).canEdit, false);
  assert.equal(store.set(doctor, section, ['unsafe initial value']), false);
  await store.load(doctor);
  assert.deepEqual(store.get(doctor, section, []).value, []);
  assert.equal(store.get(doctor, section, []).revision, 0);
  assert.equal(store.get(doctor, section, []).canEdit, true);
  assert.equal(server.requests.filter(item => item.method === 'PUT').length, 0);
  store.setIdentity(null);
  assert.equal(store.set(doctor, section, []), false);
  assert.deepEqual(store.get(doctor, section, []).value, []);
});

test('two devices receive saved documents, tombstone deletions, and doctor isolation', async () => {
  const server = backend();
  const first = device(server).store;
  const second = device(server).store;
  await first.load(doctor);
  first.set(doctor, section, [{ id: 'message-1', text: 'hello' }]);
  await first.flush();
  await second.load(doctor);
  assert.deepEqual(second.get(doctor, section, []).value, [{ id: 'message-1', text: 'hello' }]);
  assert.equal(second.get(doctor, section, []).revision, 1);
  assert.deepEqual(second.get('different-doctor', section, []).value, []);
  second.set(doctor, section, null);
  await second.flush();
  await first.load(doctor);
  assert.deepEqual(first.get(doctor, section, []).value, []);
  assert.equal(first.get(doctor, section, []).revision, 2, 'deletion retains its version');
  assert.equal(server.documents.get(`user-a/${doctor}/${section}`).value, null);
});

test('concurrent edits conflict without discarding either version; both resolutions are explicit', async () => {
  const server = backend();
  const first = device(server).store;
  const second = device(server).store;
  await Promise.all([first.load(doctor), second.load(doctor)]);
  first.set(doctor, section, ['device A']);
  await first.flush();
  second.set(doctor, section, ['device B']);
  await second.flush();
  let state = second.get(doctor, section, []);
  assert.equal(state.status, 'conflict');
  assert.deepEqual(state.value, ['device B']);
  assert.deepEqual(state.cloudValue, ['device A']);
  assert.equal(state.cloudRevision, 1);
  await second.resolveConflict(doctor, section, 'local');
  assert.equal(second.get(doctor, section, []).status, 'synced');
  assert.deepEqual(server.documents.get(`user-a/${doctor}/${section}`).value, ['device B']);
  first.set(doctor, section, ['new local A']);
  await first.flush();
  assert.equal(first.get(doctor, section, []).status, 'conflict');
  const before = server.requests.length;
  await first.resolveConflict(doctor, section, 'cloud');
  assert.deepEqual(first.get(doctor, section, []).value, ['device B']);
  assert.equal(server.requests.length, before, 'choosing cloud does not write');
});

test('choosing local still detects a cloud update that happened while conflict UI was open', async () => {
  const server = backend();
  const first = device(server).store;
  const second = device(server).store;
  await Promise.all([first.load(doctor), second.load(doctor)]);
  first.set(doctor, section, ['A first']);
  await first.flush();
  second.set(doctor, section, ['B local']);
  await second.flush();
  assert.equal(second.get(doctor, section, []).cloudRevision, 1);
  first.set(doctor, section, ['A later']);
  await first.flush();
  await second.resolveConflict(doctor, section, 'local');
  assert.equal(second.get(doctor, section, []).status, 'conflict');
  assert.deepEqual(second.get(doctor, section, []).value, ['B local']);
  assert.deepEqual(second.get(doctor, section, []).cloudValue, ['A later']);
  assert.equal(second.get(doctor, section, []).cloudRevision, 2);
  assert.deepEqual(server.documents.get(`user-a/${doctor}/${section}`).value, ['A later']);
});

test('failed initial reads never turn an unknown account into an editable empty account', async () => {
  const server = backend();
  const { store, controls } = device(server);
  controls.offline = true;
  await store.load(doctor);
  assert.equal(store.get(doctor, section, []).status, 'error');
  assert.equal(store.get(doctor, section, []).revision, null);
  assert.equal(store.set(doctor, section, ['must not overwrite']), false);
  controls.offline = false;
  await store.retry(doctor, section);
  assert.equal(store.get(doctor, section, []).canEdit, true);
  assert.equal(server.requests.filter(item => item.method === 'PUT').length, 0);
});

test('an offline edit survives reload with its base revision and is checked before retry', async () => {
  const server = backend();
  const first = device(server);
  await first.store.load(doctor);
  first.store.set(doctor, section, ['original']);
  await first.store.flush();
  first.controls.offline = true;
  first.store.set(doctor, section, ['offline change']);
  await first.store.flush();
  assert.equal(first.store.get(doctor, section, []).status, 'offline');
  assert.ok([...first.storage.items.values()].every(value => !value.includes('csrf-')));
  first.store.setIdentity(null);
  const restored = device(server, first.storage);
  assert.deepEqual(restored.store.get(doctor, section, []).value, ['offline change']);
  assert.equal(restored.store.get(doctor, section, []).revision, 1);
  const puts = server.requests.filter(item => item.method === 'PUT').length;
  await restored.store.flush();
  assert.equal(server.requests.filter(item => item.method === 'PUT').length, puts, 'hydrating does not upload before a fresh read');
  await restored.store.retry(doctor, section);
  assert.equal(restored.store.get(doctor, section, []).status, 'synced');
  assert.equal(server.requests.at(-1).expectedRevision, 1);
  assert.deepEqual(server.documents.get(`user-a/${doctor}/${section}`).value, ['offline change']);
});

test('offline local edits are preserved when another device deleted the cloud document', async () => {
  const server = backend();
  const first = device(server);
  await first.store.load(doctor);
  first.store.set(doctor, section, ['original']);
  await first.store.flush();
  const second = device(server).store;
  await second.load(doctor);
  first.controls.offline = true;
  first.store.set(doctor, section, ['unsynced']);
  await first.store.flush();
  second.set(doctor, section, null);
  await second.flush();
  first.controls.offline = false;
  await first.store.retry(doctor, section);
  const state = first.store.get(doctor, section, []);
  assert.equal(state.status, 'conflict');
  assert.deepEqual(state.value, ['unsynced']);
  assert.deepEqual(state.cloudValue, []);
  assert.equal(state.cloudRevision, 2);
  assert.equal(server.documents.get(`user-a/${doctor}/${section}`).value, null);
});

test('edits made during a write acknowledgement are serialized against the new revision', async () => {
  const server = backend();
  const { store, controls } = device(server);
  await store.load(doctor);
  const gate = deferred();
  controls.writeGate = gate;
  store.set(doctor, section, ['first']);
  await tick();
  assert.equal(store.get(doctor, section, []).status, 'saving');
  store.set(doctor, section, ['second']);
  assert.deepEqual(store.get(doctor, section, []).value, ['second']);
  gate.resolve();
  await store.flush();
  assert.deepEqual(server.documents.get(`user-a/${doctor}/${section}`).value, ['second']);
  assert.deepEqual(server.requests.filter(item => item.method === 'PUT').map(item => item.expectedRevision), [0, 1]);
  assert.equal(store.get(doctor, section, []).revision, 2);
});

test('returning to the old value during an in-flight save is still saved after its acknowledgement', async () => {
  const server = backend();
  const { store, controls } = device(server);
  await store.load(doctor);
  const gate = deferred();
  controls.writeGate = gate;
  store.set(doctor, section, ['temporary']);
  await tick();
  store.set(doctor, section, null);
  gate.resolve();
  await store.flush();
  assert.equal(server.documents.get(`user-a/${doctor}/${section}`).value, null);
  assert.equal(store.get(doctor, section, []).revision, 2);
});

test('same-account CSRF rotation preserves in-memory edits and uses the new token for subsequent writes', async () => {
  const server = backend();
  const blockedStorage = { getItem: () => null, setItem: () => { throw new Error('blocked storage'); }, removeItem: () => {} };
  const { store, controls } = device(server, blockedStorage);
  await store.load(doctor);
  const gate = deferred();
  controls.writeGate = gate;
  store.set(doctor, section, ['first']);
  await tick();
  store.set(doctor, section, ['latest in memory']);
  controls.csrfToken = 'rotated-token';
  store.setIdentity({ userId: 'user-a', csrfToken: 'rotated-token' });
  assert.deepEqual(store.get(doctor, section, []).value, ['latest in memory']);
  assert.equal(store.get(doctor, section, []).canEdit, true);
  assert.equal(store.get(doctor, section, []).status, 'saving');
  gate.resolve();
  await store.flush();
  assert.deepEqual(server.documents.get(`user-a/${doctor}/${section}`).value, ['latest in memory']);
  assert.equal(store.get(doctor, section, []).revision, 2);
});

test('an old-token rejection arriving after refresh retries once with the new CSRF token', async () => {
  const server = backend();
  const connection = server.client();
  const gate = deferred();
  let oldRequests = 0;
  const store = createConsumerDataStore({ storage: null, fetchImpl: async (url, options = {}) => {
    if (options.method === 'PUT' && options.headers['X-CSRF-Token'] === 'csrf-user-a') {
      oldRequests += 1;
      await gate.promise;
      return Response.json({ code: 'INVALID_CSRF' }, { status: 403 });
    }
    return connection.fetchImpl(url, options);
  } });
  store.setIdentity(identity());
  await store.load(doctor);
  store.set(doctor, section, ['survives token refresh']);
  await tick();
  connection.controls.csrfToken = 'new-token';
  store.setIdentity({ userId: 'user-a', csrfToken: 'new-token' });
  gate.resolve();
  await store.flush();
  assert.equal(oldRequests, 1);
  assert.equal(store.get(doctor, section, []).status, 'synced');
  assert.deepEqual(server.documents.get(`user-a/${doctor}/${section}`).value, ['survives token refresh']);
});

test('a slow GET preserves edits made while it was pending and refresh waits for the previous write', async () => {
  const server = backend();
  const { store, controls } = device(server);
  await store.load(doctor);
  const read = deferred();
  controls.readGate = read;
  const loading = store.load(doctor);
  await tick();
  store.set(doctor, section, ['typed during GET']);
  read.resolve();
  await loading;
  await store.flush();
  assert.deepEqual(store.get(doctor, section, []).value, ['typed during GET']);
  const write = deferred();
  controls.writeGate = write;
  store.set(doctor, section, ['typed during PUT']);
  await tick();
  const refreshing = store.load(doctor);
  const requests = server.requests.length;
  await tick();
  assert.equal(server.requests.length, requests, 'refresh does not read before the pending write finishes');
  write.resolve();
  await refreshing;
  assert.equal(store.get(doctor, section, []).status, 'synced');
  assert.deepEqual(store.get(doctor, section, []).value, ['typed during PUT']);
});

test('a lost acknowledgement reconciles the identical cloud value without a duplicate write', async () => {
  const server = backend();
  const { store, controls } = device(server);
  await store.load(doctor);
  controls.dropNextAck = true;
  store.set(doctor, section, ['committed but response lost']);
  await store.flush();
  assert.equal(store.get(doctor, section, []).status, 'offline');
  await store.retry(doctor, section);
  assert.equal(store.get(doctor, section, []).status, 'synced');
  assert.equal(server.requests.filter(item => item.method === 'PUT').length, 1);
});

test('an account switch isolates cache and ignores late GET and PUT responses', async () => {
  const server = backend();
  const { store, controls, storage } = device(server);
  await store.load(doctor);
  const write = deferred();
  controls.writeGate = write;
  store.set(doctor, section, ['A private conversation']);
  await tick();
  controls.user = 'user-b';
  store.setIdentity(identity('user-b'));
  assert.deepEqual(store.get(doctor, section, []).value, []);
  await store.load(doctor);
  store.set(doctor, section, ['B private conversation']);
  await store.flush();
  write.resolve();
  await tick();
  assert.deepEqual(store.get(doctor, section, []).value, ['B private conversation']);
  const read = deferred();
  controls.readGate = read;
  const loadingB = store.load(doctor);
  await tick();
  controls.user = 'user-a';
  store.setIdentity(identity());
  read.resolve();
  await loadingB;
  await store.load(doctor);
  assert.deepEqual(store.get(doctor, section, []).value, ['A private conversation']);
  const aCache = storage.items.get('medtalent:consumer-data:v1:user-a');
  const bCache = storage.items.get('medtalent:consumer-data:v1:user-b');
  assert.ok(aCache.includes('A private conversation') && !aCache.includes('B private conversation'));
  assert.ok(bCache.includes('B private conversation') && !bCache.includes('A private conversation'));
});

test('snapshot version is stable between actual notifications and subscribers can unsubscribe', async () => {
  const server = backend();
  const { store } = device(server);
  const initial = store.getVersion();
  store.get(doctor, section, []);
  assert.equal(store.getVersion(), initial);
  let count = 0;
  const unsubscribe = store.subscribe(() => { count += 1; });
  await store.load(doctor);
  assert.ok(count >= 2);
  unsubscribe();
  const stopped = count;
  store.set(doctor, section, ['saved']);
  await store.flush();
  assert.equal(count, stopped);
});

// Candidate-only protocol tests model the server's atomic privacy cascade.
function cascadingBackend({ omitRelated = false } = {}) {
  const documents = new Map();
  const requests = [];
  return { documents, requests, client() {
    const controls = { user: 'user-a', privacyGate: null };
    const fetchImpl = async (url, options = {}) => {
      const parsedUrl = new URL(url, 'https://agent.example');
      const [slug, name] = parsedUrl.pathname.replace('/api/user/data/', '').split('/').map(decodeURIComponent);
      const prefix = `${controls.user}/${slug}/`;
      if (!options.method || options.method === 'GET') return Response.json({ documents: [...documents].filter(([key]) => key.startsWith(prefix)).map(([, row]) => clone(row)) });
      const body = JSON.parse(options.body);
      requests.push({ slug, name, ...body });
      const current = documents.get(prefix + name) || { section: name, value: null, revision: 0 };
      if (body.expectedRevision !== current.revision) return Response.json({ document: clone(current) }, { status: 409 });
      const privacy = documents.get(prefix + 'privacy');
      if (['chat-messages', 'chat-assessments-v1'].includes(name) && body.value !== null && privacy?.value?.saveChat === false) return Response.json({ code: 'CHAT_STORAGE_DISABLED' }, { status: 403 });
      const saved = { section: name, value: clone(body.value), revision: current.revision + 1, updatedAt: new Date().toISOString() };
      documents.set(prefix + name, saved);
      let relatedDocuments;
      if (name === 'privacy' && body.value?.saveChat === false) {
        relatedDocuments = ['chat-messages', 'chat-assessments-v1'].map(section => {
          const previous = documents.get(prefix + section);
          const row = { section, value: null, revision: (previous?.revision || 0) + 1, updatedAt: saved.updatedAt };
          documents.set(prefix + section, row);
          return clone(row);
        });
        const gate = controls.privacyGate;
        controls.privacyGate = null;
        if (gate) await gate.promise;
      }
      return Response.json({ document: clone(saved), ...(!omitRelated && relatedDocuments ? { relatedDocuments } : {}) });
    };
    return { controls, fetchImpl };
  } };
}

test('privacy cascade confirms both tombstone versions and re-enabled new chat syncs to a second device', async () => {
  const server = cascadingBackend();
  const first = device(server), second = device(server);
  await first.store.load(doctor);
  first.store.set(doctor, section, ['old chat']);
  first.store.set(doctor, 'chat-assessments-v1', ['old assessment']);
  await first.store.flush();
  await second.store.load(doctor);
  first.store.set(doctor, section, []);
  first.store.set(doctor, 'chat-assessments-v1', null);
  first.store.set(doctor, 'privacy', { saveChat: false });
  await first.store.flush();
  for (const name of [section, 'chat-assessments-v1']) {
    assert.equal(first.store.get(doctor, name, null).status, 'synced');
    assert.equal(first.store.get(doctor, name, null).revision, 2);
  }
  second.store.set(doctor, section, ['old device attempt']);
  await second.store.flush();
  assert.equal(second.store.get(doctor, section, []).status, 'conflict');
  assert.equal(server.documents.get(`user-a/${doctor}/${section}`).value, null);
  first.store.set(doctor, 'privacy', { saveChat: true });
  await first.store.flush();
  first.store.set(doctor, section, ['new chat']);
  await first.store.flush();
  assert.equal(first.store.get(doctor, section, []).status, 'synced');
  assert.deepEqual(server.documents.get(`user-a/${doctor}/${section}`).value, ['new chat']);
  await second.store.resolveConflict(doctor, section, 'cloud');
  await second.store.load(doctor);
  assert.deepEqual(second.store.get(doctor, section, []).value, ['new chat']);
});

test('privacy cascade updates initially absent chat revisions before first re-enabled save', async () => {
  const { store } = device(cascadingBackend());
  await store.load(doctor);
  store.set(doctor, 'privacy', { saveChat: false });
  await store.flush();
  assert.equal(store.get(doctor, section, null).revision, 1);
  store.set(doctor, 'privacy', { saveChat: true });
  await store.flush();
  store.set(doctor, section, ['first new chat']);
  await store.flush();
  assert.equal(store.get(doctor, section, []).status, 'synced');
  assert.equal(store.get(doctor, section, []).revision, 2);
});

test('late privacy-clear acknowledgement preserves nonempty edits after saving was re-enabled', async () => {
  const { store, controls } = device(cascadingBackend());
  await store.load(doctor);
  store.set(doctor, section, ['old chat']);
  await store.flush();
  const gate = deferred(); controls.privacyGate = gate;
  store.set(doctor, 'privacy', { saveChat: false });
  await tick();
  store.set(doctor, 'privacy', { saveChat: true });
  store.set(doctor, section, ['new after re-enable']);
  store.set(doctor, 'chat-assessments-v1', ['new assessment']);
  gate.resolve();
  await store.flush();
  assert.equal(store.get(doctor, section, []).status, 'synced');
  assert.deepEqual(store.get(doctor, section, []).value, ['new after re-enable']);
  assert.deepEqual(store.get(doctor, 'chat-assessments-v1', []).value, ['new assessment']);
});

test('unconfirmed privacy cascade never fabricates synced related revisions', async () => {
  const { store } = device(cascadingBackend({ omitRelated: true }));
  await store.load(doctor);
  store.set(doctor, 'privacy', { saveChat: false });
  await store.flush();
  assert.equal(store.get(doctor, 'privacy', null).status, 'offline');
  assert.equal(store.get(doctor, section, null).revision, 0);
});


test('new clients opt into service plan reads while writes retain their original paths and CAS revision', async () => {
  const server = backend();
  const original = { version: 1, plans: [{ id: 'plan-1', service: '就诊资料准备', completed: [], note: '原计划', targetDate: '', updatedAt: '2026-10-23T00:00:00Z' }] };
  server.documents.set('user-a/tang-jinsong/service-plans-v1', { section: 'service-plans-v1', value: original, revision: 4 });
  const { store } = device(server);
  await store.load(doctor);
  const query = new URLSearchParams(server.requests[0].query);
  assert.equal(query.get('include'), 'service-plans-v1');
  assert.equal(query.get('includeBuilder'), '1');
  assert.equal(server.requests[0].credentials, 'include');
  assert.deepEqual(store.get(doctor, 'service-plans-v1', null).value, original);
  const updated = { ...original, plans: [{ ...original.plans[0], note: '更新后的计划' }] };
  assert.equal(store.set(doctor, 'service-plans-v1', updated), true);
  await store.flush();
  const write = server.requests.find(request => request.method === 'PUT');
  assert.equal(write.slug, doctor);
  assert.equal(write.name, 'service-plans-v1');
  assert.equal(write.query, '');
  assert.equal(write.expectedRevision, 4);
  assert.deepEqual(write.value, updated);
});
