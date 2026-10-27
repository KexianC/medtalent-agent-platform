import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the actual component's recovery handlers without a browser/native
// channel. Hooks are deterministic; the cookie-backed session API is mocked.
const source = ts.transpileModule(fs.readFileSync(new URL('../src/features/account/ConsumerAccount.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const controls = {
    session: { status: 'authenticated', enabled: true, user: { id: 'account-a' }, csrfToken: 'csrf-a' },
    snapshot: { status: 'error', canEdit: false, value: null, error: '读取云端记录超时，请检查网络后重试。' },
    confirm: true, calls: [], confirms: [], states: [], cursor: 0,
    async refresh() {}, async logout() {}, async load() {},
  };
  const store = { subscribe() {}, getVersion: () => 0, get: () => controls.snapshot,
    async load(doctor) { controls.calls.push(`load:${doctor}`); await controls.load(); } };
  const sessionApi = {
    getConsumerSession: () => controls.session,
    async refreshConsumerSession() { controls.calls.push('refresh'); await controls.refresh(); },
    async logoutConsumer() { controls.calls.push('logout'); await controls.logout(); },
    async loginWithWechat() { controls.calls.push('login'); },
  };
  const jsx = (type, props, key) => ({ type, props, key });
  const react = { useEffect() {}, useSyncExternalStore() {}, useState(initial) {
    const index = controls.cursor++;
    if (!(index in controls.states)) controls.states[index] = typeof initial === 'function' ? initial() : initial;
    return [controls.states[index], value => { controls.states[index] = typeof value === 'function' ? value(controls.states[index]) : value; }];
  } };
  const modules = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    '../../hooks/useConsumerSession': { useConsumerSession: () => controls.session },
    '../../lib/consumerData': { consumerDataStore: store },
    '../../lib/consumerSession': sessionApi,
    '../../hooks/useDoctorLocalState': { getDoctorVisitorId: () => 'isolated-guest' },
    './consumer-account.css': {},
  };
  const module = { exports: {} };
  const context = vm.createContext({ Error, window: { confirm(message) { controls.confirms.push(message); return controls.confirm; } } });
  vm.runInContext(`(function(require, module, exports) { ${source}\n})`, context)(id => {
    assert.ok(id in modules, id); return modules[id];
  }, module, module.exports);
  const render = (card = false) => { controls.cursor = 0; return module.exports[card ? 'ConsumerAccountCard' : 'ConsumerDataBoundary']({ doctorSlug: 'tang-jinsong', children: 'CORE-CONTENT' }); };
  return { controls, render };
}
function nodes(node) { return !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]; }
function text(node) { return typeof node === 'string' ? node : !node || typeof node !== 'object' ? '' : [node.props?.children].flat(Infinity).map(text).join(''); }
function button(tree, label) { const found = nodes(tree).find(node => node.type === 'button' && text(node) === label); assert.ok(found, label); return found; }
const guest = () => ({ status: 'guest', enabled: true, user: null, csrfToken: 'csrf-guest' });

test('a failed initial guest session keeps core content reachable, while unknown signed-in data exposes recovery', () => {
  const h = fixture();
  const blocked = h.render();
  assert.equal(text(blocked).includes('CORE-CONTENT'), false);
  assert.match(text(blocked), /读取云端记录超时/);
  button(blocked, '重新确认账户'); button(blocked, '退出登录，使用本机');
  assert.ok(nodes(blocked).some(node => node.type === 'a' && node.props.href === '/'));
  h.controls.session = { ...guest(), status: 'error', error: '暂时无法连接' };
  assert.equal(text(h.render()), 'CORE-CONTENT');
});

test('reconfirm recovery calls the actual session API and an expired account becomes guest before any cloud retry', async () => {
  const h = fixture();
  h.controls.refresh = async () => { h.controls.session = guest(); };
  button(h.render(), '重新确认账户').props.onClick(); await tick();
  assert.deepEqual(h.controls.calls, ['refresh']);
  assert.equal(h.render().key, 'guest');
  assert.equal(text(h.render()), 'CORE-CONTENT');
});

test('reconfirm recovery retries cloud data only after the API still confirms the account', async () => {
  const h = fixture();
  h.controls.load = async () => { h.controls.snapshot = { ...h.controls.snapshot, canEdit: true, status: 'synced' }; };
  button(h.render(), '重新确认账户').props.onClick(); await tick();
  assert.deepEqual(h.controls.calls, ['refresh', 'load:tang-jinsong']);
  assert.equal(h.render().key, 'account-a');
  assert.equal(text(h.render()), 'CORE-CONTENT');
});

test('canceling unsynced logout retains the account and never calls the logout API', async () => {
  const h = fixture(); h.controls.confirm = false;
  button(h.render(), '退出登录，使用本机').props.onClick(); await tick();
  assert.equal(h.controls.confirms.length, 1);
  assert.match(h.controls.confirms[0], /尚未同步/);
  assert.match(h.controls.confirms[0], /可能丢失/);
  assert.deepEqual(h.controls.calls, []);
  assert.equal(h.controls.session.user.id, 'account-a');
});

test('a rejected real logout keeps the signed-in recovery boundary and shows the failure', async () => {
  const h = fixture(); h.controls.logout = async () => { throw new Error('退出登录失败，请检查网络后重试。'); };
  button(h.render(), '退出登录，使用本机').props.onClick(); await tick();
  assert.deepEqual(h.controls.calls, ['logout']);
  assert.equal(h.controls.session.user.id, 'account-a');
  assert.equal(text(h.render()).includes('CORE-CONTENT'), false);
  assert.match(text(h.render()), /退出登录失败/);
});

test('explicitly confirmed logout opens core guest content only when the real API reports guest', async () => {
  const h = fixture(); h.controls.logout = async () => { h.controls.session = guest(); };
  button(h.render(), '退出登录，使用本机').props.onClick(); await tick();
  assert.equal(h.controls.confirms.length, 1);
  assert.deepEqual(h.controls.calls, ['logout']);
  assert.equal(h.render().key, 'guest');
  assert.equal(text(h.render()), 'CORE-CONTENT');
});

test('pending native login leaves an explicit manual confirmation action and avoids duplicate dispatch', async () => {
  const h = fixture(); h.controls.session = { ...guest(), loginPending: true };
  const card = h.render(true);
  assert.equal(button(card, '正在等待微信登录…').props.disabled, true);
  button(card, '已返回，确认登录').props.onClick(); await tick();
  assert.deepEqual(h.controls.calls, ['refresh']);
});
