import assert from "node:assert/strict";
import test from "node:test";
import { credentialValues, safeOutputText } from "./output-safety.mjs";

test("database URL credentials and non-HTTP userinfo are redacted", () => {
  const env = { DATABASE_URL: "mysql://service-user:p%23ssword@db.example.test:3306/platform" };
  const secrets = credentialValues(env);
  const output = safeOutputText(
    `connect ${env.DATABASE_URL}; user service-user; password p#ssword; alternate mysql://other:credential@db.example.test/sample`,
    secrets,
  );

  assert.doesNotMatch(output, /service-user|p%23ssword|p#ssword|other:credential/u);
  assert.match(output, /mysql:\/\//u);
  assert.match(output, /已过滤/u);
});

test("a malformed database URL is still treated as a complete secret", () => {
  const env = { DATABASE_URL: "not-a-valid-database-url" };
  assert.equal(safeOutputText(`failure: ${env.DATABASE_URL}`, credentialValues(env)).includes(env.DATABASE_URL), false);
});
