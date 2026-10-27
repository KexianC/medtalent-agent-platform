import test from 'node:test';
import assert from 'node:assert/strict';
import { upgradeConsumerSchema } from '../scripts/upgrade-consumer-schema.mjs';

const environment = { DATABASE_URL: 'mysql://synthetic:synthetic-password@127.0.0.1/isolated_schema_test', MYSQL_SSL_MODE: 'disabled', DATA_DIR: './synthetic-unused-data' };
function harness({ version = '1', failMigration = false, leaseBusy = false } = {}) {
  const events = [];
  let migration = false;
  const databaseFactory = () => ({
    acquireInstanceLock: async timeout => { events.push(['instance-lock', timeout]); },
    assertSupportedServer: async () => events.push(['supported-server']),
    _rows: async () => [{ version: Number(version), name: 'synthetic-existing-schema', checksum: 'synthetic' }],
    _get: async () => ({ value: version }),
    runMigrations: async () => { migration = true; events.push(['schema-only']); if (failMigration) throw new Error('synthetic-secret-should-not-be-printed'); },
    close: async () => events.push(['database-close']),
  });
  const acquireLease = () => {
    if (leaseBusy) throw new Error('synthetic-platform-already-running');
    events.push(['lease-acquire']);
    return { assertOwned: () => events.push(['lease-assert']), release: async () => events.push(['lease-release']) };
  };
  return { events, options: { environment, pool: {}, databaseFactory, acquireLease }, migration: () => migration };
}
test('schema upgrade owns both locks and invokes only migrations, with cleanup on success', async () => {
  const h = harness();
  const result = await upgradeConsumerSchema(h.options);
  assert.equal(result.schemaVersion, 3); assert.equal(result.beforeVersion, 1);
  assert.equal(result.applicationStarted, false); assert.equal(result.recoveryRun, false); assert.equal(result.providerRequests, 0);
  assert.deepEqual(h.events.map(event => event[0]), ['lease-acquire', 'instance-lock', 'supported-server', 'lease-assert', 'schema-only', 'lease-assert', 'database-close', 'lease-release']);
});
test('existing v2/v3 is supported but unversioned or unknown metadata never reaches schema writes', async () => {
  assert.equal((await upgradeConsumerSchema(harness({ version: '2' }).options)).beforeVersion, 2);
  assert.equal((await upgradeConsumerSchema(harness({ version: '3' }).options)).beforeVersion, 3);
  for (const version of ['', '0', '4']) {
    const h = harness({ version });
    await assert.rejects(upgradeConsumerSchema(h.options), { code: 'MYSQL_EXISTING_VERSIONED_DATABASE_REQUIRED' });
    assert.equal(h.migration(), false); assert.equal(h.events.at(-1)[0], 'lease-release');
  }
});
test('migration errors release database and file lease, and a busy running platform prevents all writes', async () => {
  const h = harness({ failMigration: true });
  await assert.rejects(upgradeConsumerSchema(h.options), /synthetic-secret/);
  assert.deepEqual(h.events.slice(-2).map(event => event[0]), ['database-close', 'lease-release']);
  const busy = harness({ leaseBusy: true });
  await assert.rejects(upgradeConsumerSchema(busy.options), /already-running/);
  assert.equal(busy.migration(), false); assert.deepEqual(busy.events, []);
});
