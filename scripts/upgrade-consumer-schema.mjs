import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MySQLPlatformDatabase, MYSQL_SCHEMA_VERSION } from '../server/mysql-database.mjs';
import { acquirePlatformInstanceLeaseSync } from '../server/file-lease.mjs';
import { createMySqlPool, mysqlOptionsFromEnvironment, OpsError, publicFailure } from './mysql-ops-common.mjs';

// An explicit schema write, never a preflight: no application, auth bootstrap,
// doctor seeding, job recovery, knowledge worker or provider is constructed.
export async function upgradeConsumerSchema({ environment = process.env, pool: injectedPool,
  databaseFactory = options => new MySQLPlatformDatabase(options), acquireLease = acquirePlatformInstanceLeaseSync } = {}) {
  const options = mysqlOptionsFromEnvironment(environment);
  if (!environment.DATA_DIR || !String(environment.DATA_DIR).trim()) throw new OpsError('DATA_DIR_REQUIRED');
  const dataDir = path.resolve(environment.DATA_DIR);
  const lease = acquireLease(dataDir);
  let database;
  let pool;
  try {
    pool = injectedPool || createMySqlPool(environment).pool;
    database = databaseFactory({ pool, ownsPool: !injectedPool, dataDir, lockNamespace: options.database,
      writeGuard: () => lease.assertOwned() });
    await database.acquireInstanceLock(0);
    await database.assertSupportedServer();
    const applied = await database._rows('SELECT version,name,checksum FROM schema_migrations ORDER BY version');
    const meta = await database._get("SELECT value FROM meta WHERE `key`='schema_version'");
    if (!applied.length || !Array.from({length:MYSQL_SCHEMA_VERSION},(_,i)=>String(i+1)).includes(meta?.value)) throw new OpsError('MYSQL_EXISTING_VERSIONED_DATABASE_REQUIRED');
    const beforeVersion = Number(meta.value);
    lease.assertOwned();
    await database.runMigrations();
    lease.assertOwned();
    return { ok: true, code: 'MYSQL_CONSUMER_SCHEMA_UPGRADED', beforeVersion, schemaVersion: MYSQL_SCHEMA_VERSION,
      applicationStarted: false, recoveryRun: false, providerRequests: 0, dataTablesDropped: false };
  } finally {
    try {
      if (database) await database.close();
      else if (pool && !injectedPool) await pool.end();
    } finally { await lease.release(); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || !['--apply-consumer-v2','--apply-schema'].includes(process.argv[2])) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: 'EXPLICIT_SCHEMA_UPGRADE_FLAG_REQUIRED', schemaWrites: 0 })}\n`);
    process.exitCode = 2;
  } else upgradeConsumerSchema().then(report => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch(error => { process.stderr.write(`${JSON.stringify(publicFailure(error, 'MYSQL_CONSUMER_SCHEMA_UPGRADE_FAILED'))}\n`); process.exitCode = 1; });
}
