import path from "node:path";
import { NodeHttpHandler } from "@smithy/node-http-handler";

const CONTENT_TYPES = new Map([
  [".pdf", "application/pdf"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".txt", "text/plain; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".markdown", "text/markdown; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);

function cleanEtag(value) {
  return String(value || "").replace(/^"|"$/g, "");
}

function isNotFound(error) {
  return error?.name === "NotFound" || error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404;
}

function isTransportTimeout(error) {
  return error?.name === "TimeoutError" || ["ETIMEDOUT", "ESOCKETTIMEDOUT", "ECONNABORTED"].includes(error?.code);
}

function operationError(code, message) {
  return Object.assign(new Error(message), { code });
}

export async function createS3ObjectStore(config) {
  let sdk;
  try { sdk = await import("@aws-sdk/client-s3"); } catch {
    throw new Error("缺少 @aws-sdk/client-s3，请先在项目根目录执行 npm ci。");
  }
  const { S3Client, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, DeleteObjectCommand } = sdk;
  const credentials = {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
  };
  const requestHandler = new NodeHttpHandler({
    connectionTimeout: config.connectionTimeoutMs,
    requestTimeout: config.requestTimeoutMs,
    socketTimeout: config.socketTimeoutMs,
    throwOnRequestTimeout: true,
  });
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials,
    maxAttempts: 1,
    requestHandler,
  });

  async function sendWithDeadline(command, externalSignal) {
    if (externalSignal?.aborted) throw operationError("OPERATION_ABORTED", "S3 操作因进程退出而取消。");
    const controller = new AbortController();
    let terminalCode = "";
    let rejectDeadline;
    const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
    const terminate = (code, message) => {
      if (terminalCode) return;
      terminalCode = code;
      rejectDeadline(operationError(code, message));
      controller.abort();
    };
    const timeout = setTimeout(
      () => terminate("S3_OPERATION_TIMEOUT", "S3 操作超过 deadline。"),
      config.operationTimeoutMs,
    );
    timeout.unref?.();
    const abort = () => terminate("OPERATION_ABORTED", "S3 操作因进程退出而取消。");
    externalSignal?.addEventListener("abort", abort, { once: true });
    // Close the narrow race between the initial check and listener registration.
    if (externalSignal?.aborted) abort();
    try {
      return await Promise.race([client.send(command, { abortSignal: controller.signal }), deadline]);
    } catch (error) {
      if (terminalCode && error?.code !== terminalCode) {
        throw terminalCode === "S3_OPERATION_TIMEOUT"
          ? operationError(terminalCode, "S3 操作超过 deadline。")
          : operationError(terminalCode, "S3 操作因进程退出而取消。");
      }
      if (isTransportTimeout(error)) throw operationError("S3_OPERATION_TIMEOUT", "S3 传输超时。");
      throw error;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abort);
    }
  }

  return {
    async checkBucket(options = {}) {
      await sendWithDeadline(new HeadBucketCommand({ Bucket: config.bucket }), options.signal);
    },
    async head(key, options = {}) {
      try {
        const response = await sendWithDeadline(new HeadObjectCommand({ Bucket: config.bucket, Key: key }), options.signal);
        return {
          size: Number(response.ContentLength || 0),
          sha256: String(response.Metadata?.sha256 || ""),
          etag: cleanEtag(response.ETag),
          lastModified: response.LastModified?.toISOString?.() || "",
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async put({ key, body, size, sha256, mtimeMs }, options = {}) {
      const response = await sendWithDeadline(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentLength: size,
        ContentType: CONTENT_TYPES.get(path.extname(key).toLowerCase()) || "application/octet-stream",
        Metadata: {
          sha256,
          "source-size": String(size),
          "source-mtime-ms": String(Math.trunc(mtimeMs)),
          "sync-schema": "nas-agent-knowledge-v1",
        },
      }), options.signal);
      return { etag: cleanEtag(response.ETag) };
    },
    async remove(key, options = {}) {
      await sendWithDeadline(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }), options.signal);
    },
    destroy() {
      client.destroy();
      requestHandler.destroy?.();
    },
  };
}
