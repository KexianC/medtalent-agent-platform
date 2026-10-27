import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword, passwordField } from "../server/auth.mjs";
import { validateMySqlRuntimeSchema } from "../server/mysql-database.mjs";
import { acquirePlatformInstanceLeaseSync } from "../server/file-lease.mjs";
import {
  OpsError,
  acquireNamedLock,
  createMySqlPool,
  mysqlLockNames,
  publicFailure,
  releaseNamedLock,
} from "./mysql-ops-common.mjs";

function requiredDataDirectory(environment) {
  const value = String(environment.DATA_DIR || "").trim();
  if (!value) throw new OpsError("DATA_DIR_REQUIRED");
  return path.resolve(value);
}

export async function resetMySqlAdmin({ environment = process.env } = {}) {
  const password = passwordField(environment.RESET_ADMIN_PASSWORD, { name: "RESET_ADMIN_PASSWORD" });
  const username = environment.RESET_ADMIN_USERNAME || environment.ADMIN_USERNAME || "admin";
  const dataDirectory = requiredDataDirectory(environment);
  const { pool, databaseName } = createMySqlPool(environment);
  let platformLease;
  let connection;
  let lockHeld = false;
  let transactionStarted = false;
  try {
    platformLease = acquirePlatformInstanceLeaseSync(dataDirectory);
    connection = await pool.getConnection();
    await connection.query("SET NAMES utf8mb4 COLLATE utf8mb4_bin");
    await acquireNamedLock(connection, mysqlLockNames(databaseName).instance);
    lockHeld = true;
    await validateMySqlRuntimeSchema(connection);
    await connection.query("SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    await connection.query("START TRANSACTION");
    transactionStarted = true;
    const [guards] = await connection.query("SELECT name FROM transaction_guards WHERE name='platform-write' FOR UPDATE");
    if (guards.length !== 1) throw new OpsError("MYSQL_RUNTIME_SCHEMA_INVALID");
    const [users] = await connection.execute("SELECT id,role FROM users WHERE username=? FOR UPDATE", [username]);
    const user = users[0];
    if (!user || user.role !== "admin") throw new OpsError("RESET_ADMIN_TARGET_INVALID");
    const timestamp = new Date().toISOString();
    await connection.execute("UPDATE users SET password_hash=?,active=1,updated_at=? WHERE id=?",
      [hashPassword(password), timestamp, user.id]);
    const [sessions] = await connection.execute("DELETE FROM sessions WHERE user_id=?", [user.id]);
    await connection.execute(`INSERT INTO audit(id,action,actor,target,details,created_at)
      VALUES(?,'user.password_reset','local-cli',?,NULL,?)`, [randomUUID(), user.id, timestamp]);
    await connection.query("COMMIT");
    transactionStarted = false;
    return {
      ok: true,
      code: "MYSQL_ADMIN_PASSWORD_RESET",
      sessionsRevoked: Number(sessions.affectedRows || 0),
    };
  } finally {
    if (transactionStarted) {
      try { await connection.query("ROLLBACK"); } catch { /* preserve reset failure */ }
    }
    if (lockHeld) await releaseNamedLock(connection, mysqlLockNames(databaseName).instance);
    connection?.release();
    try { await pool.end(); } finally { platformLease?.releaseSync(); }
  }
}

async function main() {
  process.stdout.write(`${JSON.stringify(await resetMySqlAdmin())}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(publicFailure(error, "MYSQL_ADMIN_RESET_FAILED"))}\n`);
    process.exitCode = 1;
  });
}
