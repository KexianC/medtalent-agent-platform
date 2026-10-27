import { DatabaseSync } from "node:sqlite";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { hashPassword, passwordField } from "../server/auth.mjs";
import { acquirePlatformInstanceLeaseSync } from "../server/file-lease.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const usesMySql = (environment) => Object.prototype.hasOwnProperty.call(environment, "DATABASE_URL")
  && environment.DATABASE_URL !== "";

export async function resetSqliteAdmin({ environment = process.env } = {}) {
  if (usesMySql(environment)) {
    throw Object.assign(new Error("MySQL reset handler required."), { code: "MYSQL_RESET_HANDLER_REQUIRED" });
  }
  const password = passwordField(environment.RESET_ADMIN_PASSWORD, { name: "RESET_ADMIN_PASSWORD" });
  const username = environment.RESET_ADMIN_USERNAME || environment.ADMIN_USERNAME || "admin";
  const dataDir = path.resolve(environment.DATA_DIR || path.join(root, "data"));
  const databasePath = path.join(dataDir, "platform.sqlite");
  await fs.access(databasePath);
  const instanceLease = acquirePlatformInstanceLeaseSync(dataDir);
  let database;
  try {
    database = new DatabaseSync(databasePath, { timeout: 5000 });
    const user = database.prepare("SELECT id,role FROM users WHERE username=?").get(username);
    if (!user || user.role !== "admin") throw new Error("指定管理员不存在；脚本不会创建账号或升级普通成员权限。");
    instanceLease.assertOwned();
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("UPDATE users SET password_hash=?,active=1,updated_at=? WHERE id=?").run(hashPassword(password), new Date().toISOString(), user.id);
      database.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
      database.prepare("INSERT INTO audit(id,action,actor,target,created_at) VALUES(?,'user.password_reset','local-cli',?,?)").run(randomUUID(), user.id, new Date().toISOString());
      instanceLease.assertOwned();
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
    return { ok: true, code: "SQLITE_ADMIN_PASSWORD_RESET" };
  } finally {
    try { database?.close(); }
    finally { instanceLease.releaseSync(); }
  }
}

async function main() {
  if (usesMySql(process.env)) {
    const { resetMySqlAdmin } = await import("./reset-admin-mysql.mjs");
    process.stdout.write(`${JSON.stringify(await resetMySqlAdmin())}\n`);
    return;
  }
  await resetSqliteAdmin();
  console.log("管理员密码已更新，旧登录会话已撤销。请清除终端中的 RESET_ADMIN_PASSWORD 环境变量。");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (usesMySql(process.env)) {
      process.stderr.write(`${JSON.stringify({ ok: false, code: "MYSQL_ADMIN_RESET_FAILED" })}\n`);
    } else console.error(error?.message || "管理员密码重置失败。");
    process.exitCode = 1;
  });
}
