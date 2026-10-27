import { safeParseWarnings } from "./pdf-text-recovery.mjs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { KnowledgeError, MAX_DOCUMENT_BYTES } from "./rag.mjs";

export const DOCUMENT_PARSER_TIMEOUT_MS = 45_000;
export const DOCUMENT_PARSER_MAX_STDOUT_BYTES = 32 * 1024 * 1024;
export const DOCUMENT_PARSER_MAX_STDERR_BYTES = 64 * 1024;
const DOCUMENT_PARSER_MAX_HEAP_MIB = 640;
const MAX_HEADER_BYTES = 8 * 1024;
const DEFAULT_WORKER_FILE = fileURLToPath(new URL("./document-parser-worker.mjs", import.meta.url));

const PARSER_FAILURES = {
  INVALID_DOCUMENT: ["缺少或无法读取文档数据。", 400],
  EMPTY_DOCUMENT: ["文件为空，未生成知识片段。", 400],
  DOCUMENT_TOO_LARGE: ["单个文件不能超过 50 MB。", 413],
  UNSUPPORTED_DOCUMENT: ["仅支持 PDF、DOCX、TXT、Markdown、CSV、HTML 和 JSON 文件。", 415],
  INVALID_ENCODING: ["无法识别文件编码，请另存为 UTF-8 后上传。", 400],
  BINARY_DOCUMENT: ["文件包含二进制内容，请上传文本文件或受支持的文档。", 400],
  INVALID_PDF: ["PDF 文件格式无效。", 400],
  INVALID_DOCX: ["DOCX 文件格式无效或已损坏。", 400],
  ENCRYPTED_PDF: ["PDF 已加密，请移除密码后上传。", 400],
  PDF_OCR_REQUIRED: ["PDF 没有可提取的文字，可能是扫描件；请先 OCR 识别后再上传。", 400],
  DOCUMENT_TEXT_LIMIT: ["文档抽取内容超过安全字符上限，请拆分后上传。", 413],
  PDF_PAGE_LIMIT: ["PDF 超过 2,000 页，请拆分后上传。", 413],
  DOCX_EXPANDED_LIMIT: ["DOCX 解压后的内容超过 100 MB 限制。", 413],
  DOCUMENT_CHUNK_LIMIT: ["文档片段过多，请拆分后上传。", 413],
  DOCUMENT_TOO_COMPLEX: ["文档过于复杂或解析内容超出限制，请拆分后重试。", 413],
  DOCUMENT_PARSE_MEMORY_LIMIT: ["文档解析触发内存安全上限，请拆分后重试。", 413],
  DOCUMENT_PARSE_TIMEOUT: ["文档解析超时，请拆分或转换文件后重试。", 408],
  DOCUMENT_PARSE_OUTPUT_LIMIT: ["文档解析结果超出安全限制，请拆分文件后重试。", 413],
  DOCUMENT_PARSE_FAILED: ["文档解析失败，请检查文件是否损坏或转换为 TXT/DOCX 后重试。", 400],
};

function parserError(code) {
  const safeCode = Object.hasOwn(PARSER_FAILURES, code) ? code : "DOCUMENT_PARSE_FAILED";
  const [message, statusCode] = PARSER_FAILURES[safeCode];
  return new KnowledgeError(message, safeCode, statusCode);
}

function boundedOption(value, fallback, maximum) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function workerFilePath(value) {
  if (value instanceof URL) return fileURLToPath(value);
  return typeof value === "string" && value ? value : DEFAULT_WORKER_FILE;
}

export async function parseDocumentIsolated(buffer, { name = "", mimeType = "" } = {}, {
  includeDiagnostics = false,
  workerFile = DEFAULT_WORKER_FILE,
  timeoutMs = DOCUMENT_PARSER_TIMEOUT_MS,
  maxStdoutBytes = DOCUMENT_PARSER_MAX_STDOUT_BYTES,
  maxStderrBytes = DOCUMENT_PARSER_MAX_STDERR_BYTES,
} = {}) {
  if (!(buffer instanceof Uint8Array)) throw parserError("INVALID_DOCUMENT");
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (data.length > MAX_DOCUMENT_BYTES) throw parserError("DOCUMENT_TOO_LARGE");
  const header = Buffer.from(`${JSON.stringify({ name: String(name), mimeType: String(mimeType) })}\n`, "utf8");
  if (header.length > MAX_HEADER_BYTES) throw parserError("INVALID_DOCUMENT");

  const safeTimeoutMs = boundedOption(timeoutMs, DOCUMENT_PARSER_TIMEOUT_MS, 60_000);
  const safeStdoutLimit = boundedOption(maxStdoutBytes, DOCUMENT_PARSER_MAX_STDOUT_BYTES, DOCUMENT_PARSER_MAX_STDOUT_BYTES);
  const safeStderrLimit = boundedOption(maxStderrBytes, DOCUMENT_PARSER_MAX_STDERR_BYTES, DOCUMENT_PARSER_MAX_STDERR_BYTES);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, [`--max-old-space-size=${DOCUMENT_PARSER_MAX_HEAP_MIB}`, workerFilePath(workerFile)], {
        cwd: fileURLToPath(new URL(".", import.meta.url)),
        env: { NODE_ENV: "production" },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      reject(parserError("DOCUMENT_PARSE_FAILED"));
      return;
    }

    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let memoryLimit = false;
    let stderrTail = "";
    let terminalError = null;
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const terminate = (error) => {
      terminalError ||= error;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => terminate(parserError("DOCUMENT_PARSE_TIMEOUT")), safeTimeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > safeStdoutLimit) {
        terminate(parserError("DOCUMENT_PARSE_OUTPUT_LIMIT"));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      const probe = stderrTail + chunk.toString("utf8");
      if (/Reached heap limit|Allocation failed.*heap out of memory|Fatal process out of memory/i.test(probe)) memoryLimit = true;
      stderrTail = probe.slice(-256);
      if (stderrBytes > safeStderrLimit) terminate(parserError("DOCUMENT_PARSE_OUTPUT_LIMIT"));
    });
    child.on("error", () => finish(reject, parserError("DOCUMENT_PARSE_FAILED")));
    child.on("close", (code, signal) => {
      if (terminalError) {
        finish(reject, terminalError);
        return;
      }
      if (code !== 0 || signal) {
        finish(reject, parserError(memoryLimit ? "DOCUMENT_PARSE_MEMORY_LIMIT" : "DOCUMENT_PARSE_FAILED"));
        return;
      }
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8"));
      } catch {
        finish(reject, parserError("DOCUMENT_PARSE_FAILED"));
        return;
      }
      if (payload?.ok === true && typeof payload.text === "string") {
        finish(resolve, includeDiagnostics === true ? { text: payload.text, parseWarnings: safeParseWarnings(payload.parseWarnings) } : payload.text);
        return;
      }
      finish(reject, parserError(payload?.code));
    });
    child.stdin.on("error", () => {});
    child.stdin.write(header);
    child.stdin.end(data);
  });
}
