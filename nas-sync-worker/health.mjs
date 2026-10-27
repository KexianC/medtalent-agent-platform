import http from "node:http";

function healthState(runtime, now) {
  const reference = Date.parse(runtime.lastProgressAt || runtime.startedAt || "");
  const stalled = Boolean(runtime.running && Number.isFinite(reference) && now - reference > runtime.healthStallMs);
  const timedOut = runtime.lastError?.code === "S3_OPERATION_TIMEOUT" || Number(runtime.lastRun?.operationTimeouts || 0) > 0;
  return { stalled, timedOut, unhealthy: runtime.stopping || stalled || timedOut };
}

function availabilityState(runtime, now) {
  const health = healthState(runtime, now);
  const run = runtime.lastRun;
  const completedRunHealthy = Boolean(run && run.scanComplete === true && Number(run.failed) === 0);
  const degraded = runtime.running || Boolean(runtime.lastError) || !completedRunHealthy;
  const status = runtime.stopping
    ? "stopping"
    : health.stalled
      ? "stalled"
      : health.timedOut
        ? "timed_out"
        : degraded
          ? "degraded"
          : "ok";
  return { ...health, degraded, ready: !health.unhealthy && !degraded, status };
}

function publicStatus(runtime, now) {
  const run = runtime.lastRun;
  const availability = availabilityState(runtime, now);
  return {
    status: availability.status,
    startedAt: runtime.startedAt,
    running: runtime.running,
    lastRun: run ? {
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      dryRun: run.dryRun,
      scanComplete: run.scanComplete,
      deletionSafe: run.deletionSafe,
      scannedFiles: run.scannedFiles,
      eligibleFiles: run.eligibleFiles,
      uploaded: run.uploaded,
      deduplicated: run.deduplicated,
      skipped: run.skipped,
      verified: run.verified,
      deleted: run.deleted,
      retainedMissing: run.retainedMissing,
      deferred: run.deferred,
      failed: run.failed,
      operationTimeouts: run.operationTimeouts || 0,
      ignored: run.ignored,
      scanErrorCount: Array.isArray(run.scanErrors) ? run.scanErrors.length : 0,
    } : null,
    lastError: runtime.lastError ? { code: runtime.lastError.code || "SYNC_ERROR" } : null,
  };
}

export function startHealthServer(port, runtime, host = "127.0.0.1", options = {}) {
  const now = options.now || Date.now;
  const server = http.createServer((request, response) => {
    if (!["GET", "HEAD"].includes(request.method || "")) {
      response.writeHead(405, { Allow: "GET, HEAD", "Cache-Control": "no-store" }).end();
      return;
    }
    if (request.url !== "/healthz" && request.url !== "/readyz") {
      response.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end('{"error":"not_found"}');
      return;
    }
    const currentTime = now();
    const availability = availabilityState(runtime, currentTime);
    const statusCode = availability.unhealthy || (request.url === "/readyz" && !availability.ready) ? 503 : 200;
    const body = JSON.stringify(publicStatus(runtime, currentTime));
    response.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  });
  server.listen(port, host);
  return server;
}
