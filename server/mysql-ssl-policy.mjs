import { isIP } from "node:net";

/** An omitted mode preserves the existing loopback-only exception to TLS. */
export function mysqlSslMode(environment = process.env) {
  const mode = environment.MYSQL_SSL_MODE;
  if (mode === undefined || mode === "") return undefined;
  if (mode === "required" || mode === "disabled") return mode;
  const error = new Error("MYSQL_SSL_MODE 必须为空、required 或 disabled。");
  error.code = "MYSQL_SSL_MODE_INVALID";
  throw error;
}

/** Shared by runtime validation, the application and all migration/backup tools. */
export function mysqlTlsEnabled(environment, hostname) {
  const mode = mysqlSslMode(environment);
  if (mode === "disabled") return false;
  if (mode === "required") return true;
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = host === "localhost" || host === "::1"
    || isIP(host) === 4 && host.startsWith("127.");
  const caFile = environment.MYSQL_SSL_CA_FILE;
  return !loopback || caFile !== undefined && caFile !== "";
}
