import { safeParseWarnings } from "./pdf-text-recovery.mjs";
import { classifyKnowledgeError } from "./knowledge-errors.mjs";
import { stdin, stdout } from "node:process";
import { MAX_DOCUMENT_BYTES, KnowledgeError, parseDocument } from "./rag.mjs";

const MAX_HEADER_BYTES = 8 * 1024;

async function readRequest() {
  const chunks = [];
  let total = 0;
  for await (const chunk of stdin) {
    total += chunk.length;
    if (total > MAX_DOCUMENT_BYTES + MAX_HEADER_BYTES + 1) {
      throw new KnowledgeError("单个文件不能超过 50 MB。", "DOCUMENT_TOO_LARGE", 413);
    }
    chunks.push(chunk);
  }
  const request = Buffer.concat(chunks, total);
  const separator = request.indexOf(0x0a);
  if (separator < 0 || separator > MAX_HEADER_BYTES) throw new KnowledgeError("文档解析请求无效。", "INVALID_DOCUMENT");
  let metadata;
  try {
    metadata = JSON.parse(request.subarray(0, separator).toString("utf8"));
  } catch {
    throw new KnowledgeError("文档解析请求无效。", "INVALID_DOCUMENT");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new KnowledgeError("文档解析请求无效。", "INVALID_DOCUMENT");
  return {
    buffer: request.subarray(separator + 1),
    name: typeof metadata.name === "string" ? metadata.name : "",
    mimeType: typeof metadata.mimeType === "string" ? metadata.mimeType : "",
  };
}

async function writeResponse(payload) {
  const output = JSON.stringify(payload);
  await new Promise((resolve, reject) => stdout.write(output, (error) => error ? reject(error) : resolve()));
}

try {
  const request = await readRequest();
  const parseWarnings = [];
  const text = await parseDocument(request.buffer, { name: request.name, mimeType: request.mimeType, onWarning: code => parseWarnings.push(code) });
  await writeResponse({ ok: true, text, parseWarnings: safeParseWarnings(parseWarnings) });
} catch (error) {
  const code = error instanceof KnowledgeError ? (classifyKnowledgeError(error)?.code || "DOCUMENT_PARSE_FAILED") : "DOCUMENT_PARSE_FAILED";
  await writeResponse({ ok: false, code }).catch(() => {});
}
