const DEFINITIONS = {
  INVALID_DOCUMENT: ["文档数据不可用", "缺少或无法读取文档数据。", "检查原件是否可读取，保留原件后重新上传。", ["download", "convert"], false],
  EMPTY_DOCUMENT: ["未提取到有效文字", "文件中没有可提取的文字。", "原件可能没有正文或仅包含图片；先核对原件，再转换或进行文字识别。", ["download", "convert"], false],
  DOCUMENT_TOO_LARGE: ["文件超过大小限制", "单个文件不能超过 50 MB。", "保持50 MiB限制；请拆分原件后逐份上传。", ["download", "split"], false],
  UNSUPPORTED_DOCUMENT: ["文件格式不受支持", "仅支持 PDF、DOCX、TXT、Markdown、CSV、HTML 和 JSON 文件。", "请将原件人工转换为受支持格式；旧DOC不能直接当作DOCX。", ["download", "convert"], false],
  INVALID_ENCODING: ["文本编码无法识别", "无法识别文件编码，请另存为 UTF-8 后上传。", "请使用文本编辑器检查并另存为UTF-8，保留原件。", ["download", "convert"], false],
  BINARY_DOCUMENT: ["文本文件包含二进制数据", "文件包含二进制内容，请上传文本文件或受支持的文档。", "核对实际格式，使用对应软件另存为受支持文件。", ["download", "convert"], false],
  INVALID_PDF: ["PDF格式无效", "PDF 文件格式无效。", "使用PDF阅读器核对并重新导出；不要仅修改扩展名。", ["download", "convert"], false],
  INVALID_DOCX: ["DOCX结构无效", "DOCX 文件格式无效或已损坏。", "核对实际文件格式并用办公软件重新另存为DOCX；原件保持不变。", ["download", "convert"], false],
  ENCRYPTED_PDF: ["PDF需要解密", "PDF 已加密，请移除密码后上传。", "由有权人员解除文档密码后另存副本，平台不尝试破解密码。", ["download", "unlock"], false],
  PDF_OCR_REQUIRED: ["PDF未提取到文字", "PDF 没有可提取的文字，可能是扫描件；请先 OCR 识别后再上传。", "可进行文字识别并人工核对，再另存为待审核资料；识别成功不等于审核通过。", ["download", "ocr"], false],
  DOCUMENT_TOO_COMPLEX: ["文档触发解析安全上限", "文档过于复杂或解析内容超出限制，请拆分后重试。", "保持解析安全上限，拆分或重新导出后再处理。", ["download", "split", "convert"], false],
  DOCUMENT_TEXT_LIMIT: ["提取文字超过安全上限", "文档抽取内容超过安全字符上限，请拆分后上传。", "请按章节拆分；平台不直接扩大字符或片段上限。", ["download", "split"], false],
  PDF_PAGE_LIMIT: ["PDF页数超过安全上限", "PDF 超过 2,000 页，请拆分后上传。", "请拆分为不超过2000页的资料，并分别人工核对。", ["download", "split"], false],
  DOCX_EXPANDED_LIMIT: ["DOCX解压内容超过安全上限", "DOCX 解压后的内容超过 100 MB 限制。", "请拆分或通过办公软件移除无关嵌入附件后另存副本；保留原件。", ["download", "split", "convert"], false],
  DOCUMENT_CHUNK_LIMIT: ["文档片段超过安全上限", "文档片段过多，请拆分后上传。", "请拆分资料；单文档3000片段上限保持不变。", ["download", "split"], false],
  DOCUMENT_PARSE_MEMORY_LIMIT: ["解析触发内存安全上限", "文档解析触发内存安全上限，请拆分后重试。", "请拆分或转换原件；平台不提高隔离进程内存上限。", ["download", "split", "convert"], false],
  DOCUMENT_PARSE_TIMEOUT: ["文档解析超时", "文档解析超时，请拆分或转换文件后重试。", "先检查或拆分原件，再手动重试；不反复自动处理同一超时文件。", ["download", "split", "convert"], false],
  DOCUMENT_PARSE_OUTPUT_LIMIT: ["解析输出超过安全上限", "文档解析结果超出安全限制，请拆分文件后重试。", "请拆分原件后重新处理，平台保持输出和内存限制。", ["download", "split"], false],
  DOCUMENT_PARSE_FAILED: ["文档解析未完成", "文档解析失败，请检查文件是否损坏或转换为 TXT/DOCX 后重试。", "具体格式原因尚未确认；检查原件或人工转换后再处理，不直接认定文件损坏。", ["download", "convert"], false],
  JOB_RETRY_EXHAUSTED: ["中断任务已耗尽重试次数", "文档处理在服务中断后已达到最大重试次数，请检查文件后手动重试。", "服务中断不等于文件损坏；检查原件与运行状态后可明确手动重试。", ["download", "retry_after_fix"], true],
  KNOWLEDGE_SOURCE_UNAVAILABLE: ["资料来源暂不可用", "资料来源当前不可用，请核对来源授权与状态。", "核对当前来源、授权和版本；不要切换医生归属或自动批准。", ["check_source"], false],
};
export const KNOWLEDGE_ERROR_CODES = Object.freeze(Object.keys(DEFINITIONS));
const has = key => Object.prototype.hasOwnProperty.call(DEFINITIONS, key);
const LEGACY = [
  [/文档处理在服务中断后已达到最大重试次数|任务已达到最大重试次数/, "JOB_RETRY_EXHAUSTED"],
  [/DOCX 解压后的内容超过 100 MB|DOCX.*解压.*超过.*100.*MB/, "DOCX_EXPANDED_LIMIT"],
  [/PDF 超过 2,000 页|PDF.*超过.*2000.*页/, "PDF_PAGE_LIMIT"],
  [/文档抽取内容超过200万字符|提取的文本超过 500 万字符|文档抽取内容超过安全字符上限/, "DOCUMENT_TEXT_LIMIT"],
  [/文档片段过多/, "DOCUMENT_CHUNK_LIMIT"],
  [/PDF 没有可提取的文字|文档中没有可检索文字.*OCR/, "PDF_OCR_REQUIRED"],
  [/PDF 已加密/, "ENCRYPTED_PDF"],
  [/DOCX.*格式无效|DOCX.*损坏|DOCX.*不支持的压缩内容/, "INVALID_DOCX"],
  [/PDF 文件格式无效/, "INVALID_PDF"],
  [/文件为空|文件中没有可提取的文字/, "EMPTY_DOCUMENT"],
  [/无法识别文件编码|UTF-16 编码不完整/, "INVALID_ENCODING"],
  [/文件包含二进制内容/, "BINARY_DOCUMENT"],
  [/仅支持 PDF、DOCX|支持 PDF、DOCX、TXT/, "UNSUPPORTED_DOCUMENT"],
  [/单个文件不能超过 ?50 ?MB|文件超过50 MB/, "DOCUMENT_TOO_LARGE"],
  [/文档解析触发内存安全上限/, "DOCUMENT_PARSE_MEMORY_LIMIT"],
  [/文档解析超时/, "DOCUMENT_PARSE_TIMEOUT"],
  [/文档解析结果超出安全限制/, "DOCUMENT_PARSE_OUTPUT_LIMIT"],
  [/文档过于复杂|DOCX 压缩包过于复杂/, "DOCUMENT_TOO_COMPLEX"],
];
const SOURCE_CODES = new Set(["SOURCE_CHANGED", "SOURCE_NOT_FOUND", "NAS_DOCUMENT_SOURCE_INVALID", "NAS_SOURCE_UNAVAILABLE"]);
function details(code) {
  const [label, message, suggestion, recoveryActions, retryable] = DEFINITIONS[code];
  return { code, label, message, suggestion, recoveryActions: [...recoveryActions], retryable };
}
/** Never returns exception text, document titles, source paths or arbitrary upstream error codes. */
export function classifyKnowledgeError(input) {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input === "object" && ["queued", "processing", "review", "ready", "deleted"].includes(input.status)) return null;
  const code = typeof input === "object" ? (input.errorCode || input.code) : null;
  const raw = typeof input === "string" ? input : typeof input.error === "string" ? input.error : typeof input.message === "string" ? input.message : "";
  if (!code && !raw && input.status !== "error") return null;
  // Specific legacy limits refine the older generic DOCUMENT_TOO_COMPLEX code.
  const legacy = LEGACY.find(([pattern]) => pattern.test(raw))?.[1];
  if (legacy && (!has(code) || ["DOCUMENT_TOO_COMPLEX", "DOCUMENT_PARSE_FAILED"].includes(code))) return details(legacy);
  if (has(code)) return details(code);
  if (SOURCE_CODES.has(code)) return details("KNOWLEDGE_SOURCE_UNAVAILABLE");
  return details(legacy || "DOCUMENT_PARSE_FAILED");
}
export function knowledgeFailureRecord(error) {
  const failure = classifyKnowledgeError(error) || details("DOCUMENT_PARSE_FAILED");
  return { errorCode: failure.code, error: failure.message };
}
