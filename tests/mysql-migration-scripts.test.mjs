import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PlatformDatabase } from "../server/database.mjs";
import {
  MYSQL_SCHEMA_MIGRATION_COUNT,
  MYSQL_SCHEMA_MIGRATION_SHA256,
  MYSQL_SCHEMA_VERSION,
} from "../server/mysql-database.mjs";
import { createBackup } from "../scripts/backup.mjs";
import { resetSqliteAdmin } from "../scripts/reset-admin.mjs";
import { importSqliteTables } from "../scripts/migrate-sqlite-to-mysql.mjs";
import { importMySqlLogicalBackup } from "../scripts/restore-mysql-backup.mjs";
import { verifyLocalMySqlBackup } from "../scripts/verify-local-mysql-backup.mjs";
import {
  BUSINESS_TABLES,
  OpsError,
  assertTargetDatabaseEmpty,
  compareSnapshots,
  digestFile,
  inspectMySqlLogicalBackup,
  inspectSqliteSnapshot,
  mysqlOptionsFromEnvironment,
  publicFailure,
  normalizedImportRow,
  runPostCommitVerification,
  sqliteImportRows,
  snapshotIsMigrationReady,
  verifyBlobDirectory,
} from "../scripts/mysql-ops-common.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
const timestamp = "2026-09-08T00:00:00.000Z";
// Keep cleanup below the operator's writable mount rather than deleting its root.
const temporaryRoot = path.join(project, ".mysql-migration-test-tmp", "run");
await fs.mkdir(temporaryRoot, { recursive: true });
test.after(async () => { await fs.rm(temporaryRoot, { recursive: true, force: true }); });

async function fixture(t, { seedRows } = {}) {
  const directory = await fs.mkdtemp(path.join(temporaryRoot, "fixture-"));
  const dataDirectory = path.join(directory, "data");
  const backupDirectory = path.join(directory, "backups");
  const database = new PlatformDatabase({ dataDir: dataDirectory, seedDoctors: [] });
  const agentSlug = "migration-agent";
  const documentId = randomUUID();
  const chunkId = randomUUID();
  const storageKey = `${randomUUID()}.bin`;
  const blob = Buffer.from("synthetic migration fixture", "utf8");
  const checksum = createHash("sha256").update(blob).digest("hex");
  database.sqlite.prepare(`INSERT INTO agents(rowid,slug,draft,published,status,version,created_at,updated_at,published_at)
    VALUES(7,?,?,?,?,?,?,?,?)`).run(agentSlug, JSON.stringify({ slug: agentSlug }), JSON.stringify({ slug: agentSlug }),
    "published", 1, timestamp, timestamp, timestamp);
  const document = {
    id: documentId,
    agentSlug,
    storageKey,
    name: "fixture.txt",
    size: blob.length,
    checksum,
    status: "ready",
    approved: true,
    chunkCount: 1,
    embeddingMode: "vector",
    revision: 1,
  };
  database.sqlite.prepare("INSERT INTO documents(rowid,id,agent_slug,payload) VALUES(11,?,?,?)")
    .run(documentId, agentSlug, JSON.stringify(document));
  database.sqlite.prepare(`INSERT INTO chunks(rowid,id,document_id,agent_slug,position,text,embedding,embedding_model)
    VALUES(13,?,?,?,?,?,?,?)`).run(chunkId, documentId, agentSlug, 0, "fixture", JSON.stringify([1, 0]), "fixture-model");
  database.sqlite.prepare(`INSERT INTO audit(rowid,id,action,actor,target,details,created_at)
    VALUES(42,?,?,?,?,?,?)`).run(randomUUID(), "fixture.created", "test", null, JSON.stringify({ ok: true }), timestamp);
  await fs.mkdir(path.join(dataDirectory, "uploads"), { recursive: true });
  await fs.writeFile(path.join(dataDirectory, "uploads", storageKey), blob);
  await seedRows?.(database.sqlite, agentSlug);
  database.close();
  const backup = await createBackup({ env: { DATA_DIR: dataDirectory, BACKUP_DIR: backupDirectory } });
  t.after(async () => {
    if (path.dirname(directory) === path.resolve(temporaryRoot)
      && path.basename(directory).startsWith("fixture-")) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  return { directory, dataDirectory, sourceDirectory: backup.destination, storageKey };
}

async function logicalBackupFixture(t, options) {
  const f = await fixture(t, options);
  const sqlite = inspectSqliteSnapshot(f.sourceDirectory);
  const destination = path.join(f.directory, "mysql-logical-backup");
  const mysqlDirectory = path.join(destination, "mysql");
  const uploadDirectory = path.join(destination, "uploads");
  await fs.mkdir(mysqlDirectory, { recursive: true });
  await fs.mkdir(uploadDirectory);
  const database = new DatabaseSync(sqlite.internal.databasePath, { readOnly: true });
  const files = {};
  try {
    for (const spec of BUSINESS_TABLES) {
      const filename = path.join(mysqlDirectory, `${spec.name}.ndjson`);
      const rows = [...sqliteImportRows(database, spec)].map((row) => normalizedImportRow(spec, row));
      await fs.writeFile(filename, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
      files[spec.name] = {
        file: `mysql/${spec.name}.ndjson`,
        sha256: await digestFile(filename),
        rows: rows.length,
      };
    }
  } finally { database.close(); }
  await fs.copyFile(path.join(sqlite.internal.uploadDirectory, f.storageKey), path.join(uploadDirectory, f.storageKey));
  const blobs = await verifyBlobDirectory(uploadDirectory, sqlite.internal.blobReferences);
  const manifest = {
    version: 2,
    completed: true,
    restorable: true,
    backend: "mysql",
    kind: "logical-export-v1",
    createdAt: timestamp,
    aggregateSha256: sqlite.report.aggregateSha256,
    schemaMigrationCount: MYSQL_SCHEMA_MIGRATION_COUNT,
    schemaMigrationsSha256: MYSQL_SCHEMA_MIGRATION_SHA256,
    runtimeSchemaValidated: true,
    runtimeSchemaVersion: MYSQL_SCHEMA_VERSION,
    dataSchemaVersion: sqlite.report.dataSchemaVersion,
    jsonInvalid: sqlite.report.jsonInvalid,
    invariants: sqlite.report.invariants,
    activity: sqlite.report.activity,
    vectors: sqlite.report.vectors,
    tables: sqlite.report.tables,
    files,
    blobs,
  };
  await fs.writeFile(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { ...f, logicalDirectory: destination };
}

test("remote MySQL TLS is fail-closed and overrides cannot replace identity or TLS", async (t) => {
  const directory = await fs.mkdtemp(path.join(temporaryRoot, "tls-"));
  const caFile = path.join(directory, "ca.pem");
  await fs.writeFile(caFile, "synthetic-ca");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  assert.throws(() => mysqlOptionsFromEnvironment({ DATABASE_URL: "mysql://operator:secret@db.example.test/platform" }),
    { code: "MYSQL_TLS_REQUIRED" });
  const options = mysqlOptionsFromEnvironment({
    DATABASE_URL: "mysql://operator:secret@db.example.test/platform",
    MYSQL_SSL_CA_FILE: caFile,
    MYSQL_SSL_SERVERNAME: "attacker.example.test",
  }, {
    host: "attacker.example.test",
    user: "attacker",
    password: "attacker",
    database: "attacker",
    ssl: { rejectUnauthorized: false, servername: "attacker.example.test" },
    multipleStatements: true,
  });
  assert.equal(options.host, "db.example.test");
  assert.equal(options.user, "operator");
  assert.equal(options.password, "secret");
  assert.equal(options.database, "platform");
  assert.equal(options.ssl.servername, "db.example.test");
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.equal(options.multipleStatements, false);
});

test("MySQL operations require an explicit disabled mode to omit remote TLS", () => {
  const DATABASE_URL = "mysql://operator:secret@db.example.test/platform";
  for (const mode of [undefined, "", "required"]) {
    assert.throws(() => mysqlOptionsFromEnvironment({ DATABASE_URL, MYSQL_SSL_MODE: mode }),
      { code: "MYSQL_TLS_REQUIRED" });
  }
  const options = mysqlOptionsFromEnvironment({
    DATABASE_URL, MYSQL_SSL_MODE: "disabled", MYSQL_SSL_CA_FILE: "missing-certificate.pem",
  }, { ssl: { rejectUnauthorized: false }, host: "attacker.example.test" });
  assert.equal(options.ssl, undefined);
  assert.equal(options.host, "db.example.test");
  for (const hostname of ["localhost", "127.0.0.2", "[::1]"]) {
    const url = `mysql://operator:secret@${hostname}/platform`;
    const local = mysqlOptionsFromEnvironment({ DATABASE_URL: url });
    assert.equal(local.ssl, undefined);
    assert.equal(local.host, hostname.replace(/^\[|\]$/g, ""));
    assert.throws(() => mysqlOptionsFromEnvironment({ DATABASE_URL: url, MYSQL_SSL_MODE: "required" }),
      { code: "MYSQL_TLS_REQUIRED" });
  }
  for (const mode of ["Disabled", "disabled ", " disabled", "false", "0", false, null, 0, {}, []]) {
    assert.throws(() => mysqlOptionsFromEnvironment({ DATABASE_URL, MYSQL_SSL_MODE: mode }),
      { code: "MYSQL_SSL_MODE_INVALID" });
  }
});

test("nonempty MySQL target is refused without destructive SQL", async () => {
  const statements = [];
  const executor = {
    query: async (sql) => {
      statements.push(sql);
      return [[{ table_name: "agents" }]];
    },
  };
  await assert.rejects(assertTargetDatabaseEmpty(executor), { code: "MYSQL_TARGET_NOT_EMPTY" });
  assert.equal(statements.some((sql) => /\b(?:DELETE|DROP|TRUNCATE)\b/iu.test(sql)), false);
});

test("SQLite snapshot verifier covers canonical rows, rowid-to-seq, JSON, vectors, activity and blobs", async (t) => {
  const f = await fixture(t);
  const source = inspectSqliteSnapshot(f.sourceDirectory, { expectedEmbeddingDimensions: 2 });
  const blobs = await verifyBlobDirectory(source.internal.uploadDirectory, source.internal.blobReferences);
  assert.equal(snapshotIsMigrationReady(source.report, blobs), true);
  assert.equal(source.report.databaseForeignKeyViolations, 0);
  assert.equal(source.report.jsonInvalid, 0);
  assert.equal(source.report.tables.agents.seqMin, "7");
  assert.equal(source.report.tables.documents.seqMin, "11");
  assert.equal(source.report.tables.chunks.seqMin, "13");
  assert.equal(source.report.tables.audit.seqMin, "42");
  assert.equal(source.report.vectors.dimensions["2"], 1);
  assert.deepEqual(source.report.activity, { activeJobs: 0, runningSyncRuns: 0, autoPublishSources: 0 });
  assert.equal(blobs.verified, true);

  const target = structuredClone(source.report);
  target.backend = "MySQL";
  target.runtimeSchemaValidated = true;
  target.runtimeSchemaVersion = MYSQL_SCHEMA_VERSION;
  target.schemaMigrationCount = MYSQL_SCHEMA_MIGRATION_COUNT;
  target.schemaMigrationsSha256 = "a".repeat(64);
  const matched = compareSnapshots(source.report, target, blobs, blobs);
  assert.equal(matched.verified, true);
  target.tables.audit.seqSha256 = "b".repeat(64);
  assert.equal(compareSnapshots(source.report, target, blobs, blobs).verified, false);
});

test("importer sends every SQLite rowid as the explicit MySQL seq", async (t) => {
  const f = await fixture(t);
  const source = inspectSqliteSnapshot(f.sourceDirectory);
  const database = new DatabaseSync(source.internal.databasePath, { readOnly: true });
  const calls = [];
  const connection = {
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      if (/^UPDATE meta/u.test(sql)) return [{ affectedRows: 1 }];
      return [{ affectedRows: 1 }];
    },
  };
  try { await importSqliteTables(connection, database); } finally { database.close(); }
  const auditInsert = calls.find((call) => /^INSERT INTO `audit`/u.test(call.sql));
  assert.ok(auditInsert);
  assert.equal(auditInsert.parameters[0], "42");
  assert.equal(calls.some((call) => /\b(?:DELETE|DROP|TRUNCATE)\b/iu.test(call.sql)), false);
});

test("active work and blob drift independently fail the migration-ready gate", async (t) => {
  const f = await fixture(t);
  const initial = inspectSqliteSnapshot(f.sourceDirectory);
  const goodBlobs = await verifyBlobDirectory(initial.internal.uploadDirectory, initial.internal.blobReferences);
  const database = new DatabaseSync(initial.internal.databasePath);
  database.prepare(`INSERT INTO jobs(id,type,status,payload,result,error,progress,attempts,max_attempts,run_after,created_at)
    VALUES(?,?,?, ?,NULL,NULL,0,0,3,?,?)`).run(randomUUID(), "fixture", "queued", "{}", timestamp, timestamp);
  database.close();
  const active = inspectSqliteSnapshot(f.sourceDirectory);
  assert.equal(active.report.activity.activeJobs, 1);
  assert.equal(snapshotIsMigrationReady(active.report, goodBlobs), false);

  await fs.writeFile(path.join(active.internal.uploadDirectory, f.storageKey), "changed");
  const badBlobs = await verifyBlobDirectory(active.internal.uploadDirectory, active.internal.blobReferences);
  assert.equal(badBlobs.verified, false);
  assert.equal(snapshotIsMigrationReady(initial.report, badBlobs), false);
});

test("SQLite inventory rejects an unknown legacy table", async (t) => {
  const f = await fixture(t);
  const database = new DatabaseSync(path.join(f.sourceDirectory, "platform.sqlite"));
  database.exec("CREATE TABLE legacy_business_data(id TEXT PRIMARY KEY,value TEXT)");
  database.close();
  assert.throws(() => inspectSqliteSnapshot(f.sourceDirectory), { code: "SQLITE_SCHEMA_UNKNOWN_TABLE" });
});

test("SQLite inventory rejects an extra column on a known table", async (t) => {
  const f = await fixture(t);
  const database = new DatabaseSync(path.join(f.sourceDirectory, "platform.sqlite"));
  database.exec("ALTER TABLE agents ADD COLUMN legacy_note TEXT");
  database.close();
  assert.throws(() => inspectSqliteSnapshot(f.sourceDirectory), { code: "SQLITE_SCHEMA_COLUMNS_MISMATCH" });
});

test("SQLite inventory rejects triggers but permits ordinary indexes", async (t) => {
  const indexed = await fixture(t);
  let database = new DatabaseSync(path.join(indexed.sourceDirectory, "platform.sqlite"));
  database.exec("CREATE INDEX extra_agents_status ON agents(status)");
  database.close();
  assert.equal(inspectSqliteSnapshot(indexed.sourceDirectory).report.schemaInventory.validated, true);

  const triggered = await fixture(t);
  database = new DatabaseSync(path.join(triggered.sourceDirectory, "platform.sqlite"));
  database.exec(`CREATE TRIGGER legacy_audit_trigger AFTER INSERT ON audit
    BEGIN SELECT 1; END`);
  database.close();
  assert.throws(() => inspectSqliteSnapshot(triggered.sourceDirectory), { code: "SQLITE_SCHEMA_FORBIDDEN_OBJECT" });
});

test("logical backup restore drill validates the complete manifest and replays explicit seq values", async (t) => {
  const f = await logicalBackupFixture(t);
  const backup = await inspectMySqlLogicalBackup(f.logicalDirectory);
  const blobs = await verifyBlobDirectory(backup.internal.uploadDirectory, backup.internal.blobReferences);
  assert.equal(snapshotIsMigrationReady(backup.report, blobs), true);
  const calls = [];
  const connection = {
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [{ affectedRows: 1 }];
    },
  };
  await importMySqlLogicalBackup(connection, backup.internal);
  const auditInsert = calls.find((call) => /^INSERT INTO `audit`/u.test(call.sql));
  assert.ok(auditInsert);
  assert.equal(auditInsert.parameters[0], "42");
  assert.equal(calls.some((call) => /\b(?:DELETE|DROP|TRUNCATE)\b/iu.test(call.sql)), false);

  await fs.appendFile(path.join(f.logicalDirectory, "mysql", "audit.ndjson"), "{}\n");
  await assert.rejects(inspectMySqlLogicalBackup(f.logicalDirectory), { code: "MYSQL_BACKUP_FILE_HASH_MISMATCH" });
});

function seedConsumerRows(database, agentSlug, { reverse = false, brokenReference } = {}) {
  if (brokenReference) database.exec("PRAGMA foreign_keys=OFF");
  for (const user of ["consumer-a", "consumer-b"]) database.prepare("INSERT INTO consumer_users VALUES(?,?,?,?,?,?)")
    .run(user, "wx1234567890abcdef", `${user}-openid`, "合成用户", timestamp, timestamp);
  database.prepare("INSERT INTO agents(slug,draft,published,status,version,created_at,updated_at,published_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("other-migration-agent", JSON.stringify({ slug: "other-migration-agent" }), JSON.stringify({ slug: "other-migration-agent" }), "published", 1, timestamp, timestamp, timestamp);
  const rows = [
    ["consumer-a", "other-migration-agent", "privacy", JSON.stringify({ saveChat: true }), 2, timestamp],
    ["consumer-b", agentSlug, "profile-name", JSON.stringify("合成资料"), 3, timestamp],
    ["consumer-a", agentSlug, "health-records", JSON.stringify([]), 4, timestamp],
    ["consumer-a", agentSlug, "favorites", JSON.stringify([]), 5, timestamp],
  ];
  if (brokenReference === "document-user") rows[0][0] = "missing-consumer";
  if (brokenReference === "document-agent") rows[0][1] = "missing-agent";
  for (const row of reverse ? rows.toReversed() : rows) database.prepare("INSERT INTO consumer_documents VALUES(?,?,?,?,?,?)").run(...row);
  database.prepare("INSERT INTO consumer_sessions VALUES(?,?,?,?)").run("a".repeat(64), brokenReference === "session-user" ? "missing-consumer" : "consumer-a", timestamp, timestamp);
  // Anonymous sessions and pending requests deliberately have no user FK.
  database.prepare("INSERT INTO consumer_sessions VALUES(?,?,?,?)").run("b".repeat(64), null, timestamp, timestamp);
  database.prepare("INSERT INTO consumer_login_requests VALUES(?,?,?,?,?,?,?,?)").run("c".repeat(32), "a".repeat(64), "d".repeat(64), "complete", brokenReference === "request-user" ? "missing-consumer" : "consumer-a", "/", timestamp, timestamp);
  database.prepare("INSERT INTO consumer_login_requests VALUES(?,?,?,?,?,?,?,?)").run("e".repeat(32), "b".repeat(64), "f".repeat(64), "pending", null, "/", timestamp, timestamp);
}

test("multi-user multi-doctor consumer documents have stable full-primary ordering regardless of insertion order", async t => {
  const summaries = [];
  for (const reverse of [false, true]) {
    const f = await logicalBackupFixture(t, { seedRows: (database, agentSlug) => seedConsumerRows(database, agentSlug, { reverse }) });
    const inspected = await inspectMySqlLogicalBackup(f.logicalDirectory);
    assert.equal(inspected.report.invariants.foreignKeyViolations, 0);
    assert.equal((await verifyLocalMySqlBackup(f.logicalDirectory)).ok, true);
    summaries.push(inspected.report.tables.consumer_documents);
    const documents = (await fs.readFile(path.join(f.logicalDirectory, "mysql/consumer_documents.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(documents.map(row => [row.user_id, row.agent_slug, row.section]), [
      ["consumer-a", "migration-agent", "favorites"],
      ["consumer-a", "migration-agent", "health-records"],
      ["consumer-a", "other-migration-agent", "privacy"],
      ["consumer-b", "migration-agent", "profile-name"],
    ]);
    const writes = [];
    await importMySqlLogicalBackup({ execute: async (sql, parameters) => { writes.push({ sql, parameters }); return [{ affectedRows: 1 }]; } }, inspected.internal);
    const imported = writes.filter(call => /^INSERT INTO `consumer_documents`/u.test(call.sql)).flatMap(call => call.parameters);
    assert.equal(imported.length, 4 * 6);
    assert.deepEqual(imported, documents.flatMap(row => [row.user_id, row.agent_slug, row.section, row.value_json, row.revision, row.updated_at]));
  }
  assert.deepEqual(summaries[0], summaries[1]);
});

test("pure logical-backup verification rejects each orphan consumer foreign key before any restore write", async t => {
  for (const brokenReference of ["session-user", "request-user", "document-user", "document-agent"]) {
    const f = await logicalBackupFixture(t, { seedRows: (database, agentSlug) => seedConsumerRows(database, agentSlug, { brokenReference }) });
    const inspected = await inspectMySqlLogicalBackup(f.logicalDirectory);
    assert.equal(inspected.report.invariants.foreignKeyViolations, 1, brokenReference);
    assert.equal(inspected.report.databaseForeignKeyViolations, 1, brokenReference);
    await assert.rejects(verifyLocalMySqlBackup(f.logicalDirectory), { code: "MYSQL_BACKUP_NOT_RESTORABLE" });
  }
});

test("SQLite entry points refuse every nonempty DATABASE_URL instead of falling back", async () => {
  await assert.rejects(createBackup({ env: { DATABASE_URL: " " } }), { code: "MYSQL_BACKUP_HANDLER_REQUIRED" });
  await assert.rejects(resetSqliteAdmin({ environment: { DATABASE_URL: " ", RESET_ADMIN_PASSWORD: "not-used" } }),
    { code: "MYSQL_RESET_HANDLER_REQUIRED" });
});

test("public failure payloads never print credentials, business content, or filesystem paths", () => {
  const secret = "never-print-this-password";
  const sensitivePath = "D:\\private\\patient-record.txt";
  const output = JSON.stringify(publicFailure(new Error(`${secret} patient payload ${sensitivePath}`),
    "MYSQL_VERIFICATION_FAILED"));
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes("patient payload"), false);
  assert.equal(output.includes(sensitivePath), false);
  assert.deepEqual(JSON.parse(output), { ok: false, code: "MYSQL_VERIFICATION_FAILED" });
  assert.deepEqual(publicFailure(new OpsError("DATABASE_URL_INVALID"), "FALLBACK"),
    { ok: false, code: "DATABASE_URL_INVALID" });
});

test("ACK plus any post-commit verification failure requires the read-only verifier", async () => {
  for (const [operation, code] of [
    ["import", "MYSQL_IMPORT_POST_COMMIT_VERIFICATION_REQUIRED"],
    ["restore", "MYSQL_RESTORE_POST_COMMIT_VERIFICATION_REQUIRED"],
  ]) {
    const verificationCause = new Error("internal post-commit database, lease, or blob detail");
    await assert.rejects(
      runPostCommitVerification({ operation, commitAcknowledgement: "acknowledged" }, async () => {
        throw verificationCause;
      }),
      (error) => {
        assert.equal(error.code, code);
        assert.equal(error.cause, verificationCause);
        assert.deepEqual(publicFailure(error, "FALLBACK"), { ok: false, code });
        assert.equal(JSON.stringify(publicFailure(error, "FALLBACK")).includes(verificationCause.message), false);
        return true;
      },
    );
  }
});

test("unknown COMMIT acknowledgement keeps its outcome-unknown code and both internal causes", async () => {
  for (const [operation, code] of [
    ["import", "MYSQL_IMPORT_COMMIT_OUTCOME_UNKNOWN"],
    ["restore", "MYSQL_RESTORE_COMMIT_OUTCOME_UNKNOWN"],
  ]) {
    const commitCause = new Error("internal COMMIT transport detail");
    const verificationCause = new Error("internal follow-up verification detail");
    await assert.rejects(
      runPostCommitVerification({ operation, commitAcknowledgement: "unknown", commitCause }, async () => {
        throw verificationCause;
      }),
      (error) => {
        assert.equal(error.code, code);
        assert.equal(error.cause instanceof AggregateError, true);
        assert.deepEqual(error.cause.errors, [commitCause, verificationCause]);
        assert.deepEqual(publicFailure(error, "FALLBACK"), { ok: false, code });
        return true;
      },
    );
  }
});

test("OpsError exposes only its fixed code", () => {
  const error = new OpsError("FIXED_CODE");
  assert.equal(error.message, "FIXED_CODE");
});
