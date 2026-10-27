import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeConfigError, validateRuntimeConfig } from "./runtime-config.mjs";

const urlFields = ["AI_API_URL", "AI_API_BASE", "DEEPSEEK_API_BASE", "EMBEDDING_API_URL"];

test("runtime validation permits an unconfigured development platform without models or NAS", () => {
  assert.equal(validateRuntimeConfig({}), undefined);
  assert.equal(validateRuntimeConfig({ PUBLIC_URL: "", EMBEDDING_API_URL: "", AI_API_URL: "", SESSION_HOURS: "8", PORT: "8788" }), undefined);
});

test("embedding protocol is explicit and limited to the two supported wire formats", () => {
  for (const value of [undefined, "", "openai", "dashscope"]) assert.doesNotThrow(() => validateRuntimeConfig({ EMBEDDING_API_PROTOCOL: value }));
  for (const value of ["OpenAI", "DASHSCOPE", "native", " openai", "dashscope ", 1, null, false, [], {}]) {
    assert.throws(() => validateRuntimeConfig({ EMBEDDING_API_PROTOCOL: value }), { code: "INVALID_RUNTIME_CONFIG", field: "EMBEDDING_API_PROTOCOL" });
  }
});

test("runtime numeric values require finite decimal integers inside their allowed bounds", () => {
  for (const value of ["1", "72", 8, " 24 "]) assert.doesNotThrow(() => validateRuntimeConfig({ SESSION_HOURS: value }));
  for (const value of ["1", "65535", 8788]) assert.doesNotThrow(() => validateRuntimeConfig({ PORT: value }));
  for (const value of ["", " ", "0", "73", "8.5", "Infinity", "NaN", "8hours", "0x10", "1e1", Infinity, NaN, 1.5, true, null, [], {}]) {
    assert.throws(() => validateRuntimeConfig({ SESSION_HOURS: value }), { code: "INVALID_RUNTIME_CONFIG", field: "SESSION_HOURS" });
  }
  for (const value of ["", "0", "65536", "-1", "1.5", "NaN", "Infinity", "http", false, []]) {
    assert.throws(() => validateRuntimeConfig({ PORT: value }), { code: "INVALID_RUNTIME_CONFIG", field: "PORT" });
  }
  for (const value of [undefined, "", "1", "256", "16384", 1024, " 256 "]) assert.doesNotThrow(() => validateRuntimeConfig({ EMBEDDING_DIMENSIONS: value }));
  for (const value of ["0", "16385", "1.5", "256d", false, null, []]) {
    assert.throws(() => validateRuntimeConfig({ EMBEDDING_DIMENSIONS: value }), { code: "INVALID_RUNTIME_CONFIG", field: "EMBEDDING_DIMENSIONS" });
  }
  for (const value of [undefined, "", "1", "20", 12, " 20 "]) assert.doesNotThrow(() => validateRuntimeConfig({ EMBEDDING_BATCH_SIZE: value }));
  for (const value of ["0", "21", "256", "1.5", "20items", false, null, []]) {
    assert.throws(() => validateRuntimeConfig({ EMBEDDING_BATCH_SIZE: value }), { code: "INVALID_RUNTIME_CONFIG", field: "EMBEDDING_BATCH_SIZE" });
  }
  for (const value of [undefined, "", "0", "1", "5", 2, " 0 "]) assert.doesNotThrow(() => validateRuntimeConfig({ EMBEDDING_MAX_RETRIES: value }));
  for (const value of ["6", "-1", "1.5", "2times", false, null, []]) {
    assert.throws(() => validateRuntimeConfig({ EMBEDDING_MAX_RETRIES: value }), { code: "INVALID_RUNTIME_CONFIG", field: "EMBEDDING_MAX_RETRIES" });
  }
  for (const value of [undefined, "", "64", "450", "16000", 900, " 450 "]) assert.doesNotThrow(() => validateRuntimeConfig({ EMBEDDING_SEGMENT_CHARACTERS: value }));
  for (const value of ["63", "16001", "0", "450.5", "450chars", false, null, []]) {
    assert.throws(() => validateRuntimeConfig({ EMBEDDING_SEGMENT_CHARACTERS: value }), { code: "INVALID_RUNTIME_CONFIG", field: "EMBEDDING_SEGMENT_CHARACTERS" });
  }
});

test("PUBLIC_URL accepts only a root HTTP(S) origin and requires HTTPS in production", () => {
  for (const value of ["http://localhost:8788", "http://127.0.0.1:8788/", "http://[::1]:8788/", "https://agents.example.test", "https://agents.example.test/"]) {
    assert.doesNotThrow(() => validateRuntimeConfig({ PUBLIC_URL: value }));
  }
  for (const value of ["http://host/path", "https://host/?tenant=1", "https://host/?", "https://host/#", "https://host/./", "https://host/a/../", "https://user:pass@host", "https://@host", "https://host\\path", " /path", "/relative", "//host", "https:host", "ftp://host", " ", null]) {
    assert.throws(() => validateRuntimeConfig({ PUBLIC_URL: value }), { field: "PUBLIC_URL" }, String(value));
  }
  for (const value of [undefined, "", "http://localhost", "http://agents.example.test"]) {
    assert.throws(() => validateRuntimeConfig({ NODE_ENV: "production", PUBLIC_URL: value }), { field: "PUBLIC_URL" });
  }
  assert.doesNotThrow(() => validateRuntimeConfig({ NODE_ENV: "production", PUBLIC_URL: "https://agents.example.test" }));
});

test("provider endpoints allow private/self-hosted HTTP(S) paths and queries but no userinfo or fragment", () => {
  for (const field of urlFields) {
    for (const value of ["http://127.0.0.1:11434/v1", "http://192.168.1.8:8080/embeddings", "http://llm.internal:9000/api?version=1", "https://models.example.test/v1/chat/completions"]) {
      assert.doesNotThrow(() => validateRuntimeConfig({ [field]: value }), field);
    }
    for (const value of ["relative", "/v1", "//models.test/v1", "https:models.test", "ftp://models.test", "https://user:secret@models.test/v1", "http://@models.test", "https://models.test/#fragment", "https://models.test/#", "https://models.test:99999/v1", " https://models.test", "https://models.test\n", null, {}]) {
      assert.throws(() => validateRuntimeConfig({ [field]: value }), { code: "INVALID_RUNTIME_CONFIG", field }, field);
    }
  }
});

test("remote MySQL configuration requires a strict URL and a CA certificate path", () => {
  const remote = "mysql://app-user:p%23ssword@db.example.test:3306/platform";
  assert.doesNotThrow(() => validateRuntimeConfig({ DATABASE_URL: remote, MYSQL_SSL_CA_FILE: "/run/secrets/mysql-ca.pem" }));
  assert.doesNotThrow(() => validateRuntimeConfig({ DATABASE_URL: "mysql://app-user:password@127.0.0.1:3306/platform" }));
  assert.throws(() => validateRuntimeConfig({ DATABASE_URL: remote }), { field: "MYSQL_SSL_CA_FILE" });
  assert.throws(() => validateRuntimeConfig({ NODE_ENV: "production", PUBLIC_URL: "https://agents.example.test", DATABASE_URL: remote, MYSQL_SSL_CA_FILE: "relative.pem" }), { field: "MYSQL_SSL_CA_FILE" });
  for (const value of ["postgres://user:password@db.example.test/platform", "mysql://db.example.test/platform", "mysql://user:password@db.example.test/", "mysql://user:password@db.example.test/one/two", "mysql://user:password@db.example.test/platform?ssl=false", "mysql://user:password@db.example.test/platform#fragment", " mysql://user:password@db.example.test/platform"] ) {
    assert.throws(() => validateRuntimeConfig({ DATABASE_URL: value, MYSQL_SSL_CA_FILE: "/run/secrets/mysql-ca.pem" }), { field: "DATABASE_URL" }, value);
  }
});

test("MySQL SSL mode is explicit, strict and supports authorized plaintext without a CA", () => {
  const remote = "mysql://app-user:password@db.example.test/platform";
  const production = { NODE_ENV: "production", PUBLIC_URL: "https://agents.example.test" };
  assert.doesNotThrow(() => validateRuntimeConfig({
    ...production, DATABASE_URL: remote, MYSQL_SSL_MODE: "disabled",
  }));
  assert.doesNotThrow(() => validateRuntimeConfig({
    ...production, DATABASE_URL: remote, MYSQL_SSL_MODE: "disabled", MYSQL_SSL_CA_FILE: "unused-relative.pem",
  }));
  for (const mode of [undefined, "", "required"]) {
    assert.throws(() => validateRuntimeConfig({ DATABASE_URL: remote, MYSQL_SSL_MODE: mode }),
      { field: "MYSQL_SSL_CA_FILE" });
    assert.doesNotThrow(() => validateRuntimeConfig({
      ...production, DATABASE_URL: remote, MYSQL_SSL_MODE: mode, MYSQL_SSL_CA_FILE: "/run/secrets/mysql-ca.pem",
    }));
  }
  for (const hostname of ["localhost", "127.0.0.2", "[::1]"]) {
    const url = `mysql://app-user:password@${hostname}/platform`;
    assert.doesNotThrow(() => validateRuntimeConfig({ DATABASE_URL: url }));
    assert.throws(() => validateRuntimeConfig({ DATABASE_URL: url, MYSQL_SSL_MODE: "required" }),
      { field: "MYSQL_SSL_CA_FILE" });
  }
  for (const mode of ["Disabled", "disabled ", " disabled", "false", "0", false, null, 0, {}, []]) {
    for (const DATABASE_URL of [undefined, remote]) {
      assert.throws(() => validateRuntimeConfig({ DATABASE_URL, MYSQL_SSL_MODE: mode }),
        { code: "INVALID_RUNTIME_CONFIG", field: "MYSQL_SSL_MODE" });
    }
  }
});

test("external provider credentials reject short, malformed or unbounded values", () => {
  for (const field of ["AI_API_KEY", "DEEPSEEK_API_KEY", "EMBEDDING_API_KEY", "DASHSCOPE_API_KEY"]) {
    for (const value of ["test-key", "provider-key-123", "0.123456"]) {
      assert.doesNotThrow(() => validateRuntimeConfig({ [field]: value }), field);
    }
    for (const value of ["a", "abc", " test-key", "test-key ", "test\nkey", "中文供应商密钥", 12345678, {}, "x".repeat(8193)]) {
      assert.throws(() => validateRuntimeConfig({ [field]: value }), { code: "INVALID_RUNTIME_CONFIG", field }, field);
    }
  }
});

test("configuration errors identify the field without echoing URLs, credentials or key values", () => {
  const env = { AI_API_URL: "https://unique-user:ultra-private-secret@models.invalid/v1", AI_API_KEY: "highly-sensitive-api-key", NAS_WEBDAV_PASSWORD: "nas-password" };
  let error;
  try { validateRuntimeConfig(env); } catch (caught) { error = caught; }
  assert.ok(error instanceof Error);
  assert.ok(error instanceof RuntimeConfigError);
  assert.match(error.message, /AI_API_URL/);
  assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`, /unique-user|ultra-private-secret|models\.invalid|highly-sensitive-api-key|nas-password/);
});

test("validation is read-only and does not coerce or mutate the supplied environment", () => {
  const env = Object.freeze({ PORT: "8788", SESSION_HOURS: "8", PUBLIC_URL: "https://agents.example.test", AI_API_URL: "http://localhost:11434/v1" });
  const before = JSON.stringify(env);
  assert.doesNotThrow(() => validateRuntimeConfig(env));
  assert.equal(JSON.stringify(env), before);
});
