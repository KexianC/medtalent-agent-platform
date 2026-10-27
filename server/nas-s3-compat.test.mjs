import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { readNasFile } from "./nas.mjs";

const s3Env = {
  NAS_S3_ENDPOINT: "https://minio.example.test",
  NAS_S3_REGION: "us-east-1",
  NAS_S3_BUCKET: "agent-knowledge",
  NAS_S3_PREFIX: "knowledge",
  NAS_S3_FORCE_PATH_STYLE: "true",
  NAS_S3_ACCESS_KEY_ID: "unit-test-access-key",
  NAS_S3_SECRET_ACCESS_KEY: "unit-test-secret-key",
};
const source = { transport: "s3", path: "sleep-agent" };
const modified = new Date("2026-09-03T02:00:00.000Z");
const file = {
  path: "sleep-agent/guide.txt",
  size: 4,
  etag: '"version-1"',
  modifiedAt: modified.toISOString(),
  signature: `s3:4:${modified.toISOString()}:"version-1"`,
};
const subsecondModified = new Date("2026-09-03T02:00:00.286Z");
const subsecondFile = {
  ...file,
  modifiedAt: subsecondModified.toISOString(),
  signature: `s3:4:${subsecondModified.toISOString()}:"version-1"`,
};

function minioConditionalAccessDenied(status) {
  return Object.assign(new Error("sensitive upstream detail"), {
    name: "AccessDenied",
    $metadata: { httpStatusCode: status },
  });
}

test("MinIO HTTP 400 AccessDenied on conditional GET retries once without conditions and verifies matching metadata", async () => {
  const commands = [];
  let destroyed = 0;
  const content = Buffer.from("safe");
  const result = await readNasFile(source, file, {
    env: s3Env,
    s3ClientFactory: () => ({
      async send(command) {
        commands.push(command);
        if (commands.length === 1) throw minioConditionalAccessDenied(400);
        return {
          ContentLength: content.length,
          ETag: file.etag,
          LastModified: modified,
          Body: Readable.from([content]),
        };
      },
      destroy() { destroyed += 1; },
    }),
  });

  assert.equal(result.toString(), "safe");
  assert.equal(commands.length, 2);
  assert.ok(commands.every((command) => command instanceof GetObjectCommand));
  assert.deepEqual(
    { Bucket: commands[1].input.Bucket, Key: commands[1].input.Key },
    { Bucket: commands[0].input.Bucket, Key: commands[0].input.Key },
  );
  assert.equal(commands[0].input.IfMatch, file.etag);
  assert.equal(commands[0].input.IfUnmodifiedSince.toISOString(), modified.toISOString());
  assert.equal(commands[1].input.IfMatch, undefined);
  assert.equal(commands[1].input.IfUnmodifiedSince, undefined);
  assert.equal(destroyed, 1);
});

test("MinIO unconditional compatibility retry still rejects changed object metadata", async () => {
  const commands = [];
  let bodyDestroyed = false;
  await assert.rejects(readNasFile(source, file, {
    env: s3Env,
    s3ClientFactory: () => ({
      async send(command) {
        commands.push(command);
        if (commands.length === 1) throw minioConditionalAccessDenied(400);
        return {
          ContentLength: file.size,
          ETag: '"version-2"',
          LastModified: modified,
          Body: {
            destroy() { bodyDestroyed = true; },
            async *[Symbol.asyncIterator]() { yield Buffer.from("evil"); },
          },
        };
      },
      destroy() {},
    }),
  }), { code: "NAS_FILE_CHANGED" });

  assert.equal(commands.length, 2);
  assert.equal(commands[1].input.IfMatch, undefined);
  assert.equal(commands[1].input.IfUnmodifiedSince, undefined);
  assert.equal(bodyDestroyed, true);
});

test("MinIO unconditional compatibility retry accepts LastModified truncated within the same UTC second", async () => {
  const commands = [];
  const content = Buffer.from("safe");
  const result = await readNasFile(source, subsecondFile, {
    env: s3Env,
    s3ClientFactory: () => ({
      async send(command) {
        commands.push(command);
        if (commands.length === 1) throw minioConditionalAccessDenied(400);
        return {
          ContentLength: content.length,
          ETag: subsecondFile.etag,
          LastModified: new Date("2026-09-03T02:00:00.000Z"),
          Body: Readable.from([content]),
        };
      },
      destroy() {},
    }),
  });

  assert.equal(result.toString(), "safe");
  assert.equal(commands.length, 2);
  assert.equal(commands[0].input.IfUnmodifiedSince.toISOString(), subsecondModified.toISOString());
  assert.equal(commands[1].input.IfMatch, undefined);
  assert.equal(commands[1].input.IfUnmodifiedSince, undefined);
});

test("MinIO unconditional compatibility retry rejects LastModified from an adjacent UTC second", async () => {
  const commands = [];
  let bodyDestroyed = false;
  await assert.rejects(readNasFile(source, subsecondFile, {
    env: s3Env,
    s3ClientFactory: () => ({
      async send(command) {
        commands.push(command);
        if (commands.length === 1) throw minioConditionalAccessDenied(400);
        return {
          ContentLength: subsecondFile.size,
          ETag: subsecondFile.etag,
          LastModified: new Date("2026-09-03T02:00:01.000Z"),
          Body: {
            destroy() { bodyDestroyed = true; },
            async *[Symbol.asyncIterator]() { yield Buffer.from("safe"); },
          },
        };
      },
      destroy() {},
    }),
  }), { code: "NAS_FILE_CHANGED" });

  assert.equal(commands.length, 2);
  assert.equal(bodyDestroyed, true);
});

test("real HTTP 403 AccessDenied never retries an unconditional S3 GET", async () => {
  const commands = [];
  await assert.rejects(readNasFile(source, file, {
    env: s3Env,
    s3ClientFactory: () => ({
      async send(command) {
        commands.push(command);
        throw minioConditionalAccessDenied(403);
      },
      destroy() {},
    }),
  }), (error) => {
    assert.equal(error.code, "NAS_AUTH_FAILED");
    assert.equal(error.message.includes("sensitive upstream detail"), false);
    return true;
  });

  assert.equal(commands.length, 1);
  assert.equal(commands[0].input.IfMatch, file.etag);
  assert.equal(commands[0].input.IfUnmodifiedSince.toISOString(), modified.toISOString());
});
