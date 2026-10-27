export class NasPathValidationError extends Error {
  constructor(message = "NAS 相对路径不安全。") {
    super(message);
    this.name = "NasPathValidationError";
    this.code = "INVALID_NAS_PATH";
  }
}

function invalid(message) { throw new NasPathValidationError(message); }

function validateSegmentText(segment) {
  if (!segment || segment === "." || segment === ".." || /[\\/:?#\u0000-\u001f\u007f]/u.test(segment)) invalid("NAS 路径包含不允许的目录或字符。");
  if (/[. ]$/u.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)) invalid("NAS 路径包含不安全的文件名。");
}

export function normalizeNasPathSegment(segment) {
  if (typeof segment !== "string" || segment.length > 1024) invalid("NAS 路径片段格式无效。");
  validateSegmentText(segment);
  let decoded = segment;
  for (let depth = 0; depth < 8 && /%[0-9a-f]{2}/iu.test(decoded); depth += 1) {
    try { decoded = decodeURIComponent(decoded); }
    catch { invalid("NAS 路径编码无效。"); }
    validateSegmentText(decoded);
  }
  if (/%[0-9a-f]{2}/iu.test(decoded)) invalid("NAS 路径编码层级过深。");
  return segment;
}

export function normalizeNasRelativePath(value, { allowEmpty = true, maxLength = 4096 } = {}) {
  if (typeof value !== "string" || value.length > maxLength) invalid("NAS 路径必须是预配置根目录下的相对路径。");
  if (value.startsWith("/") || value.startsWith("\\") || /^[a-z]:/iu.test(value)) invalid("NAS 路径不能是绝对路径。");
  const clean = value.endsWith("/") ? value.slice(0, -1) : value;
  if (!clean) {
    if (allowEmpty) return "";
    invalid("NAS 来源必须配置非空的安全相对目录。");
  }
  return clean.split("/").map(normalizeNasPathSegment).join("/");
}

// Reject overlaps even for one agent: duplicate readers would race indexing and
// deleteMissing decisions. NFC + case folding is intentionally conservative
// across S3, WebDAV and mounts whose case/Unicode semantics can differ.
export function nasRelativeScopesOverlap(left, right) {
  const comparable = (value) => value.normalize("NFC").toLowerCase();
  const a = comparable(left);
  const b = comparable(right);
  return !a || !b || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
