import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PlatformDatabase } from "./database.mjs";
import {
  MySQLPlatformDatabase,
  MySqlPlatformDatabase,
  MYSQL_SCHEMA_MIGRATION_COUNT,
  MYSQL_SCHEMA_MIGRATION_SHA256,
  MYSQL_SCHEMA_VERSION,
  MYSQL_WRITE_BATCH_MAX_BYTES,
  MYSQL_WRITE_BATCH_MAX_ROWS,
  createMySQLPlatformDatabase,
  mysqlConnectionOptions,
  mysqlSchemaMigrationsSha256,
  validateMySqlBackupSchemaSummary,
} from "./mysql-database.mjs";

function transactionHarness(executeImpl, { guardRows = [{ name: "platform-write" }] } = {}) {
  const events = [];
  const connection = {
    async query(sql, parameters) {
      events.push({ type: "query", sql, parameters });
      return [[], []];
    },
    async execute(sql, parameters) {
      events.push({ type: "execute", sql, parameters });
      if (sql.includes("transaction_guards") && sql.includes("FOR UPDATE")) {
        return [guardRows, []];
      }
      if (executeImpl) return executeImpl(sql, parameters);
      return [{ affectedRows: 1 }, []];
    },
    async beginTransaction() { events.push({ type: "begin" }); },
    async commit() { events.push({ type: "commit" }); },
    async rollback() { events.push({ type: "rollback" }); },
    async destroy() { events.push({ type: "destroy" }); },
    release() { events.push({ type: "release" }); },
  };
  const pool = {
    async getConnection() { events.push({ type: "getConnection" }); return connection; },
    async execute() { events.push({ type: "poolExecute" }); throw new Error("transaction escaped its connection"); },
  };
  return { events, connection, pool };
}

test("SQLite keeps synchronous behavior but safely settles, nests and queues async transactions", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-async-transaction-test-"));
  const database = new PlatformDatabase({ dataDir: directory });
  t.after(async () => {
    database.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("sqlite-async-transaction-test-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  assert.equal(database.transaction(() => 42), 42);

  let releaseOuter;
  let outerStarted;
  const outerGate = new Promise((resolve) => { releaseOuter = resolve; });
  const started = new Promise((resolve) => { outerStarted = resolve; });
  const outer = database.transaction(async () => {
    database.sqlite.prepare("INSERT INTO meta(key,value) VALUES('async_outer','1')").run();
    await database.transaction(async () => {
      await Promise.resolve();
      database.sqlite.prepare("INSERT INTO meta(key,value) VALUES('async_nested','1')").run();
    });
    outerStarted();
    await outerGate;
  });
  await started;
  let queuedRan = false;
  const queued = database.transaction(() => {
    queuedRan = true;
    database.sqlite.prepare("INSERT INTO meta(key,value) VALUES('async_queued','1')").run();
  });
  assert.equal(queuedRan, false);
  assert.throws(() => database.hasAnyUser(), (error) => error?.code === "SQLITE_TRANSACTION_BUSY");
  releaseOuter();
  await Promise.all([outer, queued]);
  assert.equal(queuedRan, true);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) total FROM meta WHERE key LIKE 'async_%'").get().total, 3);

  await assert.rejects(database.transaction(async () => {
    database.sqlite.prepare("INSERT INTO meta(key,value) VALUES('async_rollback','1')").run();
    await Promise.resolve();
    throw new Error("rollback marker");
  }), /rollback marker/);
  assert.equal(database.sqlite.prepare("SELECT 1 found FROM meta WHERE key='async_rollback'").get(), undefined);
});

test("MySQL URL parsing is fail-closed for credentials, URL syntax, TLS identity and unsafe overrides", () => {
  const remoteUrl = "mysql://test-user:test-password@db.example.test:3307/platform_test";
  assert.throws(() => mysqlConnectionOptions({ databaseUrl: remoteUrl, environment: {} }), /MYSQL_SSL_CA_FILE/);
  assert.throws(() => mysqlConnectionOptions({ databaseUrl: "mysql://test-user@localhost/platform_test", environment: {} }), /密码/);
  assert.throws(() => mysqlConnectionOptions({ databaseUrl: `${remoteUrl}?ssl=false`, environment: {} }), /查询参数或片段/);
  assert.throws(() => mysqlConnectionOptions({ databaseUrl: `${remoteUrl}#fragment`, environment: {} }), /查询参数或片段/);
  assert.throws(() => mysqlConnectionOptions({
    databaseUrl: "mysql://test-user:test%5Cpassword@localhost/platform_test", environment: {},
  }), /不允许的字符/);
  assert.throws(() => mysqlConnectionOptions({
    databaseUrl: "mysql://test-user:test-password@localhost/platform%0Atest", environment: {},
  }), /安全的单一数据库名/);

  const caFile = fileURLToPath(import.meta.url);
  const options = mysqlConnectionOptions({
    databaseUrl: remoteUrl,
    environment: { MYSQL_SSL_CA_FILE: caFile, MYSQL_SSL_SERVERNAME: "attacker.example.test" },
    connectionOptions: {
      host: "attacker.example.test", port: 1, user: "attacker", password: "attacker", database: "attacker",
      ssl: false, multipleStatements: true, charset: "utf8mb4_general_ci", connectionLimit: 4,
    },
  });
  assert.equal(options.host, "db.example.test");
  assert.equal(options.port, 3307);
  assert.equal(options.user, "test-user");
  assert.equal(options.password, "test-password");
  assert.equal(options.database, "platform_test");
  assert.equal(options.connectionLimit, 4);
  assert.equal(options.charset, "utf8mb4_bin");
  assert.equal(options.multipleStatements, false);
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.equal(options.ssl.servername, "db.example.test");
  assert.match(options.ssl.ca, /mysqlConnectionOptions/);

  for (const hostname of ["localhost", "127.0.0.2", "[::1]"]) {
    const local = mysqlConnectionOptions({
      databaseUrl: `mysql://test-user:test-password@${hostname}/platform_test`, environment: {},
    });
    assert.equal(local.ssl, undefined);
  }
});

test("exported MySQL backup schema summary is stable and fail-closed", () => {
  assert.equal(MYSQL_SCHEMA_VERSION, 3);
  assert.equal(MYSQL_SCHEMA_MIGRATION_COUNT, 3);
  assert.match(MYSQL_SCHEMA_MIGRATION_SHA256, /^[a-f\d]{64}$/);
  assert.equal(validateMySqlBackupSchemaSummary({
    count: MYSQL_SCHEMA_MIGRATION_COUNT,
    sha256: MYSQL_SCHEMA_MIGRATION_SHA256,
    version: MYSQL_SCHEMA_VERSION,
  }), true);
  assert.throws(() => validateMySqlBackupSchemaSummary({
    count: MYSQL_SCHEMA_MIGRATION_COUNT,
    sha256: "0".repeat(64),
    version: MYSQL_SCHEMA_VERSION,
  }), /schema migration 摘要/);
});

test("MySQL plaintext requires explicit disabled mode while required enforces TLS even on loopback", () => {
  const remoteUrl = "mysql://test-user:test-password@db.example.test/platform_test";
  for (const mode of [undefined, "", "required"]) {
    assert.throws(() => mysqlConnectionOptions({
      databaseUrl: remoteUrl, environment: { MYSQL_SSL_MODE: mode },
    }), /MYSQL_SSL_CA_FILE/);
  }
  assert.throws(() => mysqlConnectionOptions({
    databaseUrl: "mysql://test-user:test-password@127.0.0.1/platform_test",
    environment: { MYSQL_SSL_MODE: "required" },
  }), /MYSQL_SSL_CA_FILE/);

  const options = mysqlConnectionOptions({
    databaseUrl: remoteUrl,
    environment: { MYSQL_SSL_MODE: "disabled", MYSQL_SSL_CA_FILE: "missing-certificate.pem" },
    connectionOptions: { ssl: { rejectUnauthorized: false }, host: "attacker.example.test" },
  });
  assert.equal(options.ssl, undefined);
  assert.equal(options.host, "db.example.test");
  for (const mode of ["Disabled", "disabled ", " disabled", "false", "0", false, null, 0, {}, []]) {
    assert.throws(() => mysqlConnectionOptions({
      databaseUrl: remoteUrl,
      environment: { MYSQL_SSL_MODE: mode, MYSQL_SSL_CA_FILE: fileURLToPath(import.meta.url) },
    }), { code: "MYSQL_SSL_MODE_INVALID" });
  }
});

test("MySQL transactions pin one connection, await callbacks, flatten nesting and roll back failures", async () => {
  const harness = transactionHarness();
  let guardChecks = 0;
  const database = new MySQLPlatformDatabase({
    pool: harness.pool, dataDir: ".", writeGuard: async () => { guardChecks += 1; },
  });
  let releaseCallback;
  let callbackReached;
  const callbackReady = new Promise((resolve) => { callbackReached = resolve; });
  const callbackGate = new Promise((resolve) => { releaseCallback = resolve; });
  const transaction = database.transaction(async () => {
    await database._run("UPDATE sample SET value=?", [1]);
    const nested = await database.transaction(async () => {
      await database._run("UPDATE sample SET value=?", [2]);
      return "nested-result";
    });
    callbackReached();
    await callbackGate;
    return nested;
  });
  await callbackReady;
  assert.equal(harness.events.some((event) => event.type === "commit"), false);
  releaseCallback();
  assert.equal(await transaction, "nested-result");
  assert.equal(harness.events.filter((event) => event.type === "getConnection").length, 1);
  assert.equal(harness.events.filter((event) => event.type === "begin").length, 1);
  assert.equal(harness.events.filter((event) => event.type === "commit").length, 1);
  assert.equal(harness.events.filter((event) => event.type === "release").length, 1);
  assert.equal(harness.events.filter((event) => event.type === "poolExecute").length, 0);
  assert.equal(harness.events.filter((event) => event.type === "execute"
    && event.sql.includes("transaction_guards") && event.sql.includes("FOR UPDATE")).length, 1);
  assert.equal(guardChecks, 3);

  harness.events.length = 0;
  await assert.rejects(database.transaction(async () => {
    await database._run("UPDATE sample SET value=?", [3]);
    throw new Error("transaction failure marker");
  }), /transaction failure marker/);
  assert.equal(harness.events.filter((event) => event.type === "rollback").length, 1);
  assert.equal(harness.events.filter((event) => event.type === "commit").length, 0);
  assert.equal(harness.events.filter((event) => event.type === "release").length, 1);
});

test("a missing singleton transaction guard fails closed and rolls back before invoking the callback", async () => {
  const harness = transactionHarness(null, { guardRows: [] });
  const database = new MySQLPlatformDatabase({ pool: harness.pool, dataDir: "." });
  let invoked = false;
  await assert.rejects(database.transaction(async () => { invoked = true; }),
    (error) => error?.code === "MYSQL_RUNTIME_SCHEMA_INVALID");
  assert.equal(invoked, false);
  assert.equal(harness.events.filter((event) => event.type === "rollback").length, 1);
  assert.equal(harness.events.some((event) => event.type === "commit"), false);
  assert.equal(harness.events.filter((event) => event.type === "release").length, 1);
});

test("an uncertain COMMIT destroys its connection and permanently fail-stops the database", async () => {
  const harness = transactionHarness();
  let serverMayHaveCommitted = false;
  harness.connection.commit = async () => {
    harness.events.push({ type: "commit" });
    serverMayHaveCommitted = true;
    throw new Error("commit acknowledgement lost");
  };
  const compromised = [];
  const database = new MySQLPlatformDatabase({
    pool: harness.pool,
    dataDir: ".",
    onCompromised(error) { compromised.push(error); },
  });
  let commitError;
  await assert.rejects(database.transaction(async () => {
    await database._run("UPDATE sample SET value=?", [4]);
  }), (error) => {
    commitError = error;
    return error?.statusCode === 503 && error?.code === "MYSQL_COMMIT_OUTCOME_UNKNOWN"
      && /结果未知/.test(error.message) && /禁止盲目重试/.test(error.message);
  });
  assert.equal(serverMayHaveCommitted, true);
  assert.equal(harness.events.filter((event) => event.type === "commit").length, 1);
  assert.equal(harness.events.filter((event) => event.type === "rollback").length, 0);
  assert.equal(harness.events.filter((event) => event.type === "destroy").length, 1);
  assert.equal(harness.events.filter((event) => event.type === "release").length, 0);
  assert.deepEqual(compromised, [commitError]);

  await assert.rejects(database.transaction(async () => "must not run"), (error) => error === commitError);
  assert.equal(harness.events.filter((event) => event.type === "getConnection").length, 1);
  assert.equal(compromised.length, 1);
});

test("the outer transaction tail keeps queued work behind an unresolved COMMIT acknowledgement", { timeout: 2_000 }, async () => {
  const harness = transactionHarness();
  let commitReached;
  let releaseCommit;
  const commitStarted = new Promise((resolve) => { commitReached = resolve; });
  const commitGate = new Promise((resolve) => { releaseCommit = resolve; });
  harness.connection.commit = async () => {
    harness.events.push({ type: "commit" });
    commitReached();
    await commitGate;
    throw new Error("commit acknowledgement lost after server response delay");
  };
  const database = new MySQLPlatformDatabase({ pool: harness.pool, dataDir: "." });
  const first = database.transaction(async () => {
    await database._run("UPDATE sample SET value=?", [5]);
    return "first";
  });
  await commitStarted;

  let secondCallbackRan = false;
  const second = database.transaction(async () => {
    secondCallbackRan = true;
    return "second";
  });
  await Promise.resolve();
  assert.equal(secondCallbackRan, false);
  assert.equal(harness.events.filter((event) => event.type === "getConnection").length, 1);
  assert.equal(harness.events.filter((event) => event.type === "commit").length, 1);

  const outcomesPromise = Promise.allSettled([first, second]);
  releaseCommit();
  const [firstOutcome, secondOutcome] = await outcomesPromise;
  assert.equal(firstOutcome.status, "rejected");
  assert.equal(firstOutcome.reason?.code, "MYSQL_COMMIT_OUTCOME_UNKNOWN");
  assert.equal(secondOutcome.status, "rejected");
  assert.equal(secondOutcome.reason, firstOutcome.reason);
  assert.equal(secondCallbackRan, false);
  assert.equal(harness.events.filter((event) => event.type === "getConnection").length, 1);
  assert.equal(harness.events.filter((event) => event.type === "commit").length, 1);
});

test("close drains an active and queued outer transaction without deadlocking", { timeout: 2_000 }, async () => {
  const harness = transactionHarness();
  const database = new MySQLPlatformDatabase({ pool: harness.pool, dataDir: "." });
  let firstReached;
  let releaseFirst;
  const firstStarted = new Promise((resolve) => { firstReached = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = database.transaction(async () => {
    firstReached();
    await firstGate;
  });
  await firstStarted;
  let secondCallbackRan = false;
  const second = database.transaction(async () => { secondCallbackRan = true; });
  const outcomesPromise = Promise.allSettled([first, second]);
  const closing = database.close();
  releaseFirst();
  const [outcomes] = await Promise.all([outcomesPromise, closing]);

  assert.deepEqual(outcomes.map(({ status, reason }) => [status, reason?.code]), [
    ["rejected", "PLATFORM_DATA_CLOSED"],
    ["rejected", "PLATFORM_DATA_CLOSED"],
  ]);
  assert.equal(secondCallbackRan, false);
  assert.equal(harness.events.filter((event) => event.type === "getConnection").length, 1);
  assert.equal(harness.events.filter((event) => event.type === "rollback").length, 1);
  assert.equal(harness.events.filter((event) => event.type === "commit").length, 0);
  assert.equal(database.closed, true);
});

test("MySQL migrations acquire and release a DDL lock, persist a checksum, and validate the schema", async () => {
  const events = [];
  let appliedRows = [];
  let schemaMutations = 0;
  const schemaDefinitions = new Map();
  const schemaRows = (kind) => {
    if (kind === "tables") return [...schemaDefinitions].map(([table_name]) => ({
      table_name, engine: "InnoDB", table_collation: "utf8mb4_bin",
    }));
    if (kind === "columns") return [...schemaDefinitions].flatMap(([table_name, sql]) => {
      const body = sql.match(/\(([\s\S]*)\)\s*ENGINE=/i)?.[1] || "";
      let ordinal = 0;
      return body.split("\n").map((line) => line.trim()).flatMap((line) => {
        const match = /^`?([a-z_]+)`?\s+((?:bigint|int|tinyint|varchar|char|longtext|text)(?:\(\d+\))?(?:\s+unsigned)?)/i.exec(line);
        if (!match) return [];
        const defaultMatch = /\bDEFAULT\s+(?:'([^']*)'|([^\s,]+))/i.exec(line);
        let column_default = defaultMatch ? (defaultMatch[1] ?? defaultMatch[2]) : null;
        if (typeof column_default === "string" && column_default.toUpperCase() === "NULL") column_default = null;
        return [{
          table_name, column_name: match[1], ordinal_position: ++ordinal, column_type: match[2].toLowerCase(),
          is_nullable: /\bNOT NULL\b/i.test(line) ? "NO" : "YES", column_default,
          collation_name: /\bCOLLATE\s+([a-z\d_]+)/i.exec(line)?.[1]?.toLowerCase() || null,
          extra: /AUTO_INCREMENT/i.test(line) ? "auto_increment" : "", generation_expression: "",
        }];
      });
    });
    if (kind === "indexes") return [...schemaDefinitions].flatMap(([table_name, sql]) => {
      const rows = [];
      const add = (index_name, non_unique, columns) => columns.split(",").forEach((column, index) => rows.push({
        table_name, index_name, non_unique, seq_in_index: index + 1,
        column_name: column.trim().replace(/`/g, "").replace(/\(\d+\)$/, ""),
      }));
      for (const match of sql.matchAll(/PRIMARY\s+KEY\s*\(([^)]+)\)/gi)) add("PRIMARY", 0, match[1]);
      for (const match of sql.matchAll(/(?:^|,|\n)\s*(UNIQUE\s+)?KEY\s+`?([a-z_]+)`?\s*\(([^)]+)\)/gi)) {
        add(match[2], match[1] ? 0 : 1, match[3]);
      }
      return rows;
    });
    return [...schemaDefinitions].flatMap(([table_name, sql]) => sql.split("\n").flatMap((line) => {
      const rows = [];
      const foreignKey = /CONSTRAINT\s+`?([a-z_]+)`?\s+FOREIGN KEY\s*\(`?([a-z_]+)`?\)\s+REFERENCES\s+`?([a-z_]+)`?\s*\(`?([a-z_]+)`?\)/i.exec(line);
      const check = /CONSTRAINT\s+`?([a-z_]+)`?\s+CHECK\s*\((.*)\)\s*,?$/i.exec(line.trim());
      if (kind === "constraints" && /PRIMARY\s+KEY\s*\(/i.test(line)) {
        rows.push({ table_name, constraint_name: "PRIMARY", constraint_type: "PRIMARY KEY", enforced: "YES" });
      }
      if (kind === "constraints") for (const unique of line.matchAll(/UNIQUE\s+KEY\s+`?([a-z_]+)`?/gi)) {
        rows.push({ table_name, constraint_name: unique[1], constraint_type: "UNIQUE", enforced: "YES" });
      }
      if (kind === "constraints" && foreignKey) rows.push({ table_name, constraint_name: foreignKey[1], constraint_type: "FOREIGN KEY", enforced: "YES" });
      if (kind === "constraints" && check) rows.push({ table_name, constraint_name: check[1], constraint_type: "CHECK", enforced: "YES" });
      if (rows.length) return rows;
      if (kind === "keys" && foreignKey) return [{ table_name, constraint_name: foreignKey[1], column_name: foreignKey[2],
        ordinal_position: 1, referenced_table_schema: "platform_test",
        referenced_table_name: foreignKey[3], referenced_column_name: foreignKey[4] }];
      if (kind === "referential" && foreignKey) return [{ table_name, constraint_name: foreignKey[1],
        unique_constraint_schema: "platform_test", referenced_table_name: foreignKey[3],
        update_rule: "RESTRICT", delete_rule: "RESTRICT" }];
      if (kind === "checks" && check) return [{ table_name, constraint_name: check[1], enforced: "YES", check_clause: check[2] }];
      return [];
    }));
  };
  const connection = {
    async query(sql, parameters) {
      events.push({ type: "query", sql, parameters });
      if (sql.startsWith("SELECT DATABASE()")) return [[{ database_name: "platform_test" }], []];
      if (sql.startsWith("SELECT version,name,checksum")) return [appliedRows, []];
      if (sql.startsWith("SELECT value FROM meta")) return [[{ value: String(MYSQL_SCHEMA_VERSION) }], []];
      if (sql.includes("information_schema.tables")) return [schemaRows("tables"), []];
      if (sql.includes("information_schema.columns")) return [schemaRows("columns"), []];
      if (sql.includes("information_schema.statistics")) return [schemaRows("indexes"), []];
      if (sql.includes("information_schema.triggers")) return [[], []];
      if (sql.includes("information_schema.check_constraints")) return [schemaRows("checks"), []];
      if (sql.includes("information_schema.referential_constraints")) return [schemaRows("referential"), []];
      if (sql.includes("information_schema.key_column_usage")) return [schemaRows("keys"), []];
      if (sql.includes("information_schema.table_constraints")) return [schemaRows("constraints"), []];
      if (sql.includes("FROM transaction_guards")) return [[{ name: "platform-write" }], []];
      const create = /CREATE TABLE IF NOT EXISTS\s+`?([a-z_]+)`?/i.exec(sql);
      if (create) schemaDefinitions.set(create[1], sql);
      return [[], []];
    },
    async execute(sql, parameters) {
      events.push({ type: "execute", sql, parameters });
      if (sql.startsWith("SELECT GET_LOCK")) return [[{ acquired: 1 }], []];
      if (sql.startsWith("INSERT INTO schema_migrations")) {
        appliedRows.push({ version: parameters[0], name: parameters[1], checksum: parameters[2] });
      }
      if (sql.startsWith("SELECT RELEASE_LOCK")) return [[{ released: 1 }], []];
      return [{ affectedRows: 1 }, []];
    },
    release() { events.push({ type: "release" }); },
  };
  const pool = {
    async getConnection() { return connection; },
    async query(sql, parameters) { return await connection.query(sql, parameters); },
  };
  const database = new MySQLPlatformDatabase({ pool, dataDir: "." });
  await database.runMigrations({ testHooks: { beforeSchemaMutation: () => { schemaMutations += 1; } } });

  assert.equal(schemaMutations, 3);
  assert.equal(appliedRows.length, 3);
  assert.equal(appliedRows[0].version, 1);
  assert.equal(appliedRows[0].name, "initial-platform-schema");
  assert.match(appliedRows[0].checksum, /^[a-f\d]{64}$/);
  const inspectedSha256 = mysqlSchemaMigrationsSha256(appliedRows.map((row) => ({
    version: String(row.version),
    checksum: String(row.checksum),
  })));
  assert.equal(inspectedSha256, MYSQL_SCHEMA_MIGRATION_SHA256);
  assert.equal(validateMySqlBackupSchemaSummary({
    count: appliedRows.length,
    sha256: inspectedSha256,
    version: MYSQL_SCHEMA_VERSION,
  }), true);
  const ddl = events.filter((event) => event.type === "query").map((event) => event.sql).join("\n");
  assert.match(ddl, /ENGINE=InnoDB/);
  assert.match(ddl, /COLLATE=utf8mb4_bin/);
  assert.match(ddl, /seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT/);
  assert.equal(events.filter((event) => event.type === "execute" && event.sql.startsWith("SELECT GET_LOCK")).length, 1);
  assert.equal(events.filter((event) => event.type === "execute" && event.sql.startsWith("SELECT RELEASE_LOCK")).length, 1);
  assert.equal(events.at(-1).type, "release");

  events.length = 0;
  await database.runMigrations({ testHooks: { beforeSchemaMutation: () => { schemaMutations += 1; } } });
  assert.equal(schemaMutations, 3, "an applied migration must not replay its DDL");
  assert.equal(events.filter((event) => event.type === "execute" && event.sql.startsWith("SELECT RELEASE_LOCK")).length, 1);

  schemaDefinitions.set("unexpected_user_table", `CREATE TABLE unexpected_user_table (
    id VARCHAR(36) NOT NULL, PRIMARY KEY (id)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`);
  await assert.rejects(database.validateRuntimeSchema(), /不允许额外普通表：unexpected_user_table/);
  schemaDefinitions.delete("unexpected_user_table");

  appliedRows = [{ ...appliedRows[0], checksum: "0".repeat(64) }];
  events.length = 0;
  await assert.rejects(database.runMigrations(), /校验和不匹配/);
  assert.equal(events.filter((event) => event.type === "execute" && event.sql.startsWith("SELECT RELEASE_LOCK")).length, 1);
  assert.equal(events.at(-1).type, "release");
});

test("a refused migration lock aborts without schema mutation and still releases the connection", async () => {
  const events = [];
  const connection = {
    async query(sql) { events.push(sql); return [[], []]; },
    async execute(sql) {
      events.push(sql);
      if (sql.startsWith("SELECT GET_LOCK")) return [[{ acquired: 0 }], []];
      return [[{ released: 1 }], []];
    },
    release() { events.push("connection.release"); },
  };
  const database = new MySQLPlatformDatabase({ pool: { async getConnection() { return connection; } }, dataDir: "." });
  await assert.rejects(database.runMigrations(), (error) => error?.code === "DATABASE_MIGRATION_LOCKED");
  assert.equal(events.some((entry) => typeof entry === "string" && entry.includes("CREATE TABLE")), false);
  assert.equal(events.at(-1), "connection.release");
});

test("a non-empty unversioned target is rejected before any DDL is applied", async () => {
  const events = [];
  const connection = {
    async query(sql) {
      events.push(sql);
      if (sql.includes("information_schema.tables")) return [[{ table_name: "legacy_table" }], []];
      return [[], []];
    },
    async execute(sql) {
      events.push(sql);
      if (sql.startsWith("SELECT GET_LOCK")) return [[{ acquired: 1 }], []];
      if (sql.startsWith("SELECT RELEASE_LOCK")) return [[{ released: 1 }], []];
      return [{ affectedRows: 1 }, []];
    },
    release() { events.push("connection.release"); },
  };
  const database = new MySQLPlatformDatabase({ pool: { async getConnection() { return connection; } }, dataDir: "." });
  await assert.rejects(database.runMigrations(), /空目标数据库/);
  assert.equal(events.some((entry) => typeof entry === "string" && entry.startsWith("CREATE TABLE")), false);
  assert.equal(events.some((entry) => typeof entry === "string" && entry.startsWith("SELECT RELEASE_LOCK")), true);
  assert.equal(events.at(-1), "connection.release");
});

test("instance lock compromise becomes sticky and stops all subsequent database work", async () => {
  let compromised = 0;
  const database = new MySQLPlatformDatabase({
    pool: { async execute() { throw new Error("pool must not be reached after compromise"); } },
    dataDir: ".",
    onCompromised(error) { compromised += 1; assert.equal(error.code, "PLATFORM_INSTANCE_LOCK_LOST"); },
  });
  database.lockConnection = {
    async execute() { return [[{ owner: 71, connection_id: 72 }], []]; },
  };
  await database.verifyInstanceLock();
  await database.verifyInstanceLock();
  assert.equal(compromised, 1);
  assert.equal(database.lockError?.code, "PLATFORM_INSTANCE_LOCK_LOST");
  await assert.rejects(database.getAgent("demo"), (error) => error?.code === "PLATFORM_INSTANCE_LOCK_LOST");
  await assert.rejects(database.transaction(async () => {}), (error) => error?.code === "PLATFORM_INSTANCE_LOCK_LOST");
});

test("a transaction rechecks instance-lock ownership immediately before commit and rolls back when it was lost", async () => {
  const harness = transactionHarness();
  let checks = 0;
  const database = new MySQLPlatformDatabase({ pool: harness.pool, dataDir: "." });
  database.lockConnection = {
    async execute() {
      checks += 1;
      return checks === 1
        ? [[{ owner: 88, connection_id: 88 }], []]
        : [[{ owner: 99, connection_id: 88 }], []];
    },
  };
  await assert.rejects(database.transaction(async () => {
    await database._run("UPDATE sample SET value=?", [4]);
  }), (error) => error?.code === "PLATFORM_INSTANCE_LOCK_LOST");
  assert.equal(checks, 2);
  assert.equal(harness.events.filter((event) => event.type === "rollback").length, 1);
  assert.equal(harness.events.some((event) => event.type === "commit"), false);
  assert.equal(harness.events.filter((event) => event.type === "release").length, 1);
});

test("chunk replacement and CASE embedding updates use bounded multi-row batches with atomic row-count checks", async () => {
  const chunks = Array.from({ length: MYSQL_WRITE_BATCH_MAX_ROWS * 2 + 5 }, (_, index) => ({
    index, text: `chunk-${index}`,
  }));
  const vectors = chunks.map((_, index) => [index / 1000, 1]);
  const insertHarness = transactionHarness((sql) => [{ affectedRows: sql.startsWith("INSERT INTO chunks") ? 1 : 1 }, []]);
  const insertDatabase = new MySQLPlatformDatabase({ pool: insertHarness.pool, dataDir: "." });
  await insertDatabase.replaceChunks({ id: "document-1", agentSlug: "agent-1" }, chunks, vectors, "embedding-model");
  const inserts = insertHarness.events.filter((event) => event.type === "execute" && event.sql.startsWith("INSERT INTO chunks"));
  assert.deepEqual(inserts.map((event) => event.parameters.length / 7), [100, 100, 5]);
  assert.ok(inserts.every((event) => event.parameters.length <= MYSQL_WRITE_BATCH_MAX_ROWS * 7));
  assert.equal(insertHarness.events.filter((event) => event.type === "commit").length, 1);

  const rows = chunks.map((chunk, index) => ({
    id: `chunk-id-${index}`, document_id: "document-1", agent_slug: "agent-1", position: chunk.index, text: chunk.text,
  }));
  const updateHarness = transactionHarness((sql, parameters) => {
    if (sql.startsWith("UPDATE chunks")) return [{ affectedRows: parameters.length / 9 }, []];
    return [{ affectedRows: 1 }, []];
  });
  const updateDatabase = new MySQLPlatformDatabase({ pool: updateHarness.pool, dataDir: "." });
  assert.equal(await updateDatabase.updateChunkEmbeddings(rows, vectors, "embedding-model"), rows.length);
  const updates = updateHarness.events.filter((event) => event.type === "execute" && event.sql.startsWith("UPDATE chunks"));
  assert.deepEqual(updates.map((event) => event.parameters.length / 9), [100, 100, 5]);
  assert.ok(updates.every((event) => event.sql.includes("CASE id") && event.sql.includes("BINARY text=BINARY ?")));

  let updateNumber = 0;
  const changedHarness = transactionHarness((sql, parameters) => {
    if (!sql.startsWith("UPDATE chunks")) return [{ affectedRows: 1 }, []];
    updateNumber += 1;
    return [{ affectedRows: parameters.length / 9 - (updateNumber === 2 ? 1 : 0) }, []];
  });
  const changedDatabase = new MySQLPlatformDatabase({ pool: changedHarness.pool, dataDir: "." });
  await assert.rejects(changedDatabase.updateChunkEmbeddings(rows, vectors, "embedding-model"),
    (error) => error?.code === "DOCUMENT_CHANGED");
  assert.equal(changedHarness.events.filter((event) => event.type === "rollback").length, 1);
  assert.equal(changedHarness.events.some((event) => event.type === "commit"), false);

  const oversizedHarness = transactionHarness();
  const oversizedDatabase = new MySQLPlatformDatabase({ pool: oversizedHarness.pool, dataDir: "." });
  await assert.rejects(oversizedDatabase.replaceChunks({ id: "document-1", agentSlug: "agent-1" }, [{
    index: 0, text: "x".repeat(MYSQL_WRITE_BATCH_MAX_BYTES),
  }], null, null), (error) => error?.code === "MYSQL_BATCH_ITEM_TOO_LARGE");
  assert.equal(oversizedHarness.events.some((event) => event.type === "getConnection"), false);
});

test("claimJob uses the pinned transaction connection and FOR UPDATE SKIP LOCKED", async () => {
  let claimSql = "";
  const jobRow = {
    id: "job-1", type: "document.ingest", status: "running", payload: "{}", result: null, error: null,
    progress: 0, attempts: 1, max_attempts: 3, run_after: "2026-01-01T00:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z", started_at: "2026-01-01T00:00:00.000Z", finished_at: null,
  };
  const harness = transactionHarness((sql) => {
    if (sql.includes("attempts>=max_attempts")) return [[], []];
    if (sql.includes("FOR UPDATE SKIP LOCKED")) { claimSql = sql; return [[{ id: "job-1" }], []]; }
    if (sql.startsWith("SELECT * FROM jobs WHERE id=")) return [[jobRow], []];
    if (sql.startsWith("UPDATE jobs SET status='running'")) return [{ affectedRows: 1 }, []];
    return [[], []];
  });
  const database = new MySQLPlatformDatabase({ pool: harness.pool, dataDir: "." });
  const job = await database.claimJob();
  assert.equal(job.id, "job-1");
  assert.match(claimSql, /ORDER BY created_at,seq LIMIT 1 FOR UPDATE SKIP LOCKED/);
  assert.equal(harness.events.some((event) => event.type === "poolExecute"), false);
});

test("MySQL exposes the full SQLite repository surface and every corresponding method is async", () => {
  assert.equal(MySqlPlatformDatabase, MySQLPlatformDatabase);
  assert.equal(typeof createMySQLPlatformDatabase, "function");
  const sqliteMethods = Object.getOwnPropertyNames(PlatformDatabase.prototype).filter((name) => name !== "constructor");
  const missing = sqliteMethods.filter((name) => typeof MySQLPlatformDatabase.prototype[name] !== "function");
  const synchronous = sqliteMethods.filter((name) => MySQLPlatformDatabase.prototype[name]?.constructor.name !== "AsyncFunction");
  assert.deepEqual(missing, []);
  assert.deepEqual(synchronous, []);
  assert.equal(MySQLPlatformDatabase.prototype.updateChunkEmbeddings.length, 3);
  const database = new MySQLPlatformDatabase({ pool: {}, dataDir: "." });
  assert.equal(database.storageKind, "MySQL");
});
