import { loadWorkerConfig } from "./config.mjs";
import { createS3ObjectStore } from "./s3-store.mjs";
import { loadAndValidateState, runSyncOnce, sanitizeError } from "./sync.mjs";
import { startHealthServer } from "./health.mjs";
import { installShutdownHandlers } from "./lifecycle.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseFlags(argv) {
  const allowed = new Set(["--once", "--dry-run", "--help"]);
  const unknown = argv.filter((arg) => !allowed.has(arg));
  if (unknown.length) throw new Error(`未知参数：${unknown.join(", ")}`);
  return {
    once: argv.includes("--once") ? true : undefined,
    dryRun: argv.includes("--dry-run") ? true : undefined,
    help: argv.includes("--help"),
  };
}

function sleep(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(done, milliseconds);
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function prepareWorker(config, { createObjectStore = createS3ObjectStore } = {}) {
  const state = await loadAndValidateState(config);
  const store = config.dryRun ? null : await createObjectStore(config);
  return { state, store };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const flags = parseFlags(argv);
  if (flags.help) {
  console.log("用法：node nas-sync-worker/index.mjs [--once] [--dry-run]");
  console.log("配置见 docs/NAS_MINIO_SYNC.md；凭据仅从 NAS_S3_* 环境变量读取。");
  return;
  }
  const config = await loadWorkerConfig(env, flags);
  const controller = new AbortController();
  const startedAt = new Date().toISOString();
  const runtime = {
    startedAt,
    lastProgressAt: startedAt,
    healthStallMs: config.healthStallMs,
    running: false,
    stopping: false,
    lastRun: null,
    lastError: null,
  };
  let store;
  let healthServer;
  const removeShutdownHandlers = installShutdownHandlers(runtime, controller);

  try {
    const prepared = await prepareWorker(config);
    store = prepared.store;
    let state = prepared.state;
    if (!config.once) healthServer = startHealthServer(config.healthPort, runtime, config.healthHost);
    runtime.running = true;
    runtime.lastProgressAt = new Date().toISOString();
    await store?.checkBucket?.({ signal: controller.signal });
    runtime.running = false;
    do {
      runtime.running = true;
      runtime.lastProgressAt = new Date().toISOString();
      runtime.lastError = null;
      try {
        const result = await runSyncOnce(config, store, {
          state,
          signal: controller.signal,
          onProgress: () => { runtime.lastProgressAt = new Date().toISOString(); },
          sleep: (milliseconds) => sleep(milliseconds, controller.signal),
        });
        state = result.state;
        runtime.lastRun = result.summary;
        if (result.summary.operationTimeouts > 0) runtime.lastError = { code: "S3_OPERATION_TIMEOUT" };
        console.log(JSON.stringify({ event: "nas_minio_sync_completed", ...result.summary }));
      } catch (error) {
        runtime.lastError = sanitizeError(error);
        console.error(JSON.stringify({ event: "nas_minio_sync_failed", error: runtime.lastError }));
        if (config.once) process.exitCode = 1;
      } finally {
        runtime.running = false;
      }
      if (!config.once && !controller.signal.aborted) await sleep(config.intervalMs, controller.signal);
    } while (!config.once && !controller.signal.aborted);
  } finally {
    removeShutdownHandlers();
    store?.destroy?.();
    if (healthServer) await new Promise((resolve) => healthServer.close(resolve));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: "nas_minio_sync_start_failed", error: sanitizeError(error) }));
    process.exitCode = 1;
  });
}
