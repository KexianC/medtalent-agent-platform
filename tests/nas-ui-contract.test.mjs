import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NAS_TRANSPORT_OPTIONS, nasSourcePathError, nasTransportLabel, toNasS3Display } from '../src/lib/nasConnectors.ts';
import { getNasAdminStatus } from '../src/lib/platformApi.ts';
import { adminStatusLabel } from '../src/lib/adminStatus.ts';

test('NAS connector selector exposes canonical S3 transport with MinIO label', () => {
  assert.deepEqual(NAS_TRANSPORT_OPTIONS.map((item) => item.value), ['webdav', 'local', 's3']);
  assert.equal(nasTransportLabel('webdav'), 'WebDAV');
  assert.equal(nasTransportLabel('local'), '服务器本地挂载');
  assert.equal(nasTransportLabel('s3'), 'MinIO / S3');
  assert.match(nasSourcePathError('s3', '   '), /必须填写/);
  assert.equal(nasSourcePathError('s3', 'doctors/gong-wenbo'), null);
  assert.equal(nasSourcePathError('webdav', ''), null);
  assert.equal(adminStatusLabel('partial'), '部分完成');
});

test('partial sync status has an explicit visual state', async () => {
  const css = await readFile(new URL('../src/pages/admin.css', import.meta.url), 'utf8');
  assert.match(css, /\.status-partial\s*\{/u);
});

test('S3 source editor requires a non-empty bucket-relative prefix', async () => {
  const panel = await readFile(new URL('../src/components/admin/NasPanel.tsx', import.meta.url), 'utf8');
  const connectors = await readFile(new URL('../src/lib/nasConnectors.ts', import.meta.url), 'utf8');
  assert.match(panel, /nasSourcePathError\(form\.transport, form\.path\)/u);
  assert.match(panel, /required=\{form\.transport === 's3'\}/u);
  assert.match(connectors, /不能直接映射整个全局根前缀/u);
});

test('unsafe legacy source scopes are visible and cannot be tested or synchronized', async () => {
  const panel = await readFile(new URL('../src/components/admin/NasPanel.tsx', import.meta.url), 'utf8');
  const api = await readFile(new URL('../src/lib/platformApi.ts', import.meta.url), 'utf8');
  assert.match(api, /scopeIssue\?: \{ code: string; message: string \} \| null/u);
  assert.match(panel, /source\.scopeIssue\.message/u);
  assert.match(panel, /映射已暂停/u);
  assert.equal((panel.match(/disabled=\{!canEdit \|\| busy \|\| Boolean\(source\.scopeIssue\)\}/gu) || []).length, 2);
});

test('S3 display model allow-lists public configuration and never forwards credentials', () => {
  const display = toNasS3Display({
    endpoint: 'https://browser-user:browser-password@minio.example.test/api/?token=private#fragment',
    bucket: 'agent-knowledge',
    region: 'cn-hangzhou',
    prefix: 'trusted/',
    forcePathStyle: true,
    credentialConfigured: true,
    accessKeyId: 'must-not-reach-react',
    secretAccessKey: 'must-not-reach-react-either',
    password: 'also-private',
    health: { ok: true, checkedAt: '2026-09-04T10:00:00.000Z', message: 'arbitrary detail is not rendered' },
    capabilities: { listObjects: true, getObject: true, deleteObject: true },
  });

  assert.equal(display.endpoint, 'https://minio.example.test/api');
  assert.equal(display.bucket, 'agent-knowledge');
  assert.equal(display.region, 'cn-hangzhou');
  assert.equal(display.prefix, 'trusted/');
  assert.equal(display.pathStyle, 'path');
  assert.equal(display.credentialConfigured, true);
  assert.equal(display.health, 'healthy');
  assert.deepEqual(display.capabilities, ['列出对象', '读取对象']);
  const serialized = JSON.stringify(display);
  assert.equal(serialized.includes('browser-password'), false);
  assert.equal(serialized.includes('token=private'), false);
  assert.equal(serialized.includes('must-not-reach-react'), false);
  assert.equal(serialized.includes('arbitrary detail'), false);
});

test('S3 display model has explicit environment-backed placeholders when summary is absent', () => {
  const display = toNasS3Display(undefined);
  assert.match(display.endpoint, /NAS_S3_ENDPOINT/);
  assert.match(display.bucket, /NAS_S3_BUCKET/);
  assert.match(display.region, /NAS_S3_REGION/);
  assert.equal(display.pathStyle, 'unknown');
  assert.equal(display.credentialConfigured, undefined);
  assert.equal(display.health, 'unknown');
});

test('NAS API client requests the management status endpoint and preserves the safe S3 summary', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let request;
  globalThis.fetch = async (path, options) => {
    request = { path, options };
    return new Response(JSON.stringify({
      configured: { webdav: false, local: false, s3: true },
      sources: [],
      runs: [],
      s3: { endpoint: 'https://minio.example.test', bucket: 'knowledge', region: 'us-east-1', prefix: '', forcePathStyle: true, credentialConfigured: true },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await getNasAdminStatus();
  assert.equal(request.path, '/api/admin/nas');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.credentials, 'include');
  assert.equal(result.configured.s3, true);
  assert.equal(result.s3.bucket, 'knowledge');
  assert.equal(Object.hasOwn(result.s3, 'secretAccessKey'), false);
});
