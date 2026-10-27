import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { KnowledgeService } from "./knowledge-service.mjs";

test("NAS admin status redacts legacy credential-bearing errors and allow-lists run statistics", async () => {
  const source = {
    id: "source-safe-id", name: "安全映射", agentSlug: "safe-agent", transport: "s3",
    path: "https://legacy-user:legacy-path-password@nas.example.invalid/share",
    enabled: true, autoPublish: false, deleteMissing: false, intervalMinutes: 5, revision: 1,
    lastStatus: "failed", lastError: "NAS_S3_SECRET_ACCESS_KEY=legacy-secret password=old-password Bearer bearer-token",
    syncFailureOrder: [{ path: "private.txt", signature: "not-public" }],
  };
  const database = {
    dataDir: os.tmpdir(),
    listEntities(table) { return table === "sources" ? [source] : []; },
    listSyncRuns() {
      return [{
        id: "run-safe-id", sourceId: source.id, jobId: "job-safe-id", status: "failed",
        startedAt: "2026-09-04T00:00:00.000Z", finishedAt: null,
        error: "authorization: Basic abc123 NAS_S3_ACCESS_KEY_ID=current-access",
        stats: {
          scanned: 7, failed: 1, complete: false,
          warning: "credential=current-secret",
          errors: [{ path: "current-access/private.txt", error: "password=historical-password" }],
          credentials: { secretAccessKey: "must-never-be-projected" },
          arbitraryPrivatePayload: "must-never-be-projected-either",
        },
      }];
    },
  };
  const service = new KnowledgeService(database, { env: {
    NAS_S3_ENDPOINT: "https://minio.example.invalid", NAS_S3_BUCKET: "agent-knowledge",
    NAS_S3_ACCESS_KEY_ID: "current-access", NAS_S3_SECRET_ACCESS_KEY: "current-secret",
  } });

  const status = await service.nasStatus();
  const serialized = JSON.stringify(status);
  for (const secret of ["legacy-secret", "old-password", "bearer-token", "abc123", "current-access",
    "current-secret", "historical-password", "legacy-user", "legacy-path-password",
    "must-never-be-projected", "must-never-be-projected-either"]) {
    assert.equal(serialized.includes(secret), false, `status leaked ${secret}`);
  }
  assert.equal(status.sources[0].syncFailureCount, 1);
  assert.equal(status.runs[0].stats.scanned, 7);
  assert.equal(status.runs[0].stats.failed, 1);
  assert.equal(status.runs[0].stats.complete, false);
  assert.equal(Object.hasOwn(status.runs[0].stats, "credentials"), false);
  assert.equal(status.sources[0].path, "[invalid legacy path]");
  assert.equal(status.sources[0].scopeIssue.code, "NAS_SOURCE_SCOPE_INVALID");
  assert.match(status.sources[0].lastError, /服务端日志/);
  assert.match(status.runs[0].error, /服务端日志/);
});
