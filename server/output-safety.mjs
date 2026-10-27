const registeredCredentialRedactions = new Set();
export function registerCredentialRedactions(values = []) { for (const value of values) if (typeof value === "string" && value.length >= 8) registeredCredentialRedactions.add(value); }
export const SENSITIVE_ASSIGNMENT = /((?:password|passwd|pwd|secret(?:[\s_-]*access[\s_-]*key)?|access[\s_-]*key(?:[\s_-]*id)?|api[\s_-]*key|private[\s_-]*key|(?:(?:session|security|auth|refresh)[\s_-]*)?token|authorization|credential|x[\s_-]*amz[\s_-]*(?:security[\s_-]*token|signature)|signature|set[\s_-]*cookie|cookie)[\w-]*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}\]]+)/giu;
const EXPLICIT_CREDENTIAL_FIELDS = new Set([
  "ADMIN_PASSWORD", "ADMIN_TOKEN", "RESET_ADMIN_PASSWORD",
  "DATABASE_URL",
  "AI_API_KEY", "DEEPSEEK_API_KEY", "EMBEDDING_API_KEY", "DASHSCOPE_API_KEY",
  "NAS_WEBDAV_PASSWORD", "NAS_S3_ACCESS_KEY_ID", "NAS_S3_SECRET_ACCESS_KEY", "NAS_S3_SESSION_TOKEN",
]);

export function isUsableProviderCredential(value) {
  return typeof value === "string"
    && value.length >= 8
    && value.length <= 8192
    && value.trim() === value
    && /^[\x21-\x7e]+$/u.test(value);
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function credentialValues(env = process.env) {
  const values = Object.entries(env || {})
    .filter(([key, value]) => typeof value === "string" && value.length > 0
      && (EXPLICIT_CREDENTIAL_FIELDS.has(key)
        || (value.length >= 4 && /(?:password|passwd|pwd|secret|token|access[_-]?key|api[_-]?key)/i.test(key))))
    .map(([, value]) => value);
  if (typeof env?.NAS_WEBDAV_USERNAME === "string" && env.NAS_WEBDAV_USERNAME.length > 0) values.push(env.NAS_WEBDAV_USERNAME);
  if (typeof env?.DATABASE_URL === "string" && env.DATABASE_URL.length > 0) {
    try {
      const databaseUrl = new URL(env.DATABASE_URL);
      for (const value of [databaseUrl.username, databaseUrl.password]) {
        if (!value) continue;
        values.push(value);
        try { values.push(decodeURIComponent(value)); } catch { /* keep the encoded credential */ }
      }
    } catch { /* the complete malformed value is already included above */ }
  }
  // A shorter credential can be a prefix of a longer one. Replace longest
  // first so redacting the prefix cannot leave a sensitive suffix behind.
  return [...new Set([...values, ...registeredCredentialRedactions])].sort((left, right) => right.length - left.length);
}

export function collisionFreeMarker(secrets) {
  const used = new Set(secrets.flatMap((secret) => [...secret]));
  const candidates = ["⟦", "⟬", "〖", "〚", "◈", "※", "¤", "§", "¶", "�"];
  let delimiter = candidates.find((candidate) => !used.has(candidate));
  if (!delimiter) {
    for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint += 1) {
      const candidate = String.fromCodePoint(codePoint);
      if (!used.has(candidate)) { delimiter = candidate; break; }
    }
  }
  if (!delimiter) return "";
  const labelled = `${delimiter}已过滤${delimiter}`;
  return secrets.some((secret) => labelled.includes(secret)) ? delimiter : labelled;
}

export function safeOutputText(value, secrets = [], maxLength = 1000) {
  const protectedValues = [...new Set([...secrets, ...registeredCredentialRedactions].filter((secret) => typeof secret === "string" && secret.length > 0))]
    .sort((left, right) => right.length - left.length);
  const marker = collisionFreeMarker(protectedValues);
  let safe = String(value ?? "")
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu, marker)
    // Userinfo ends at the last @ in the URL authority; passwords may legally
    // contain an unescaped @ in legacy text even though it is ambiguous.
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/giu, (_match, prefix) => `${prefix}${marker}@`)
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/_=.~:-]+/giu, (_match, scheme) => `${scheme} ${marker}`)
    .replace(SENSITIVE_ASSIGNMENT, (_match, prefix) => `${prefix}${marker}`);
  // The marker contains a delimiter absent from every protected value, so a
  // replacement cannot create a new credential across the replacement edge.
  for (const secret of protectedValues) safe = safe.replace(new RegExp(escapeRegExp(secret), "gu"), marker);
  return safe.slice(0, maxLength);
}

export function safeOutputCode(value, secrets = [], fallback = "INTERNAL_ERROR") {
  const protectedValues = [...new Set(secrets.filter((secret) => typeof secret === "string" && secret.length > 0))];
  const valid = (candidate) => typeof candidate === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(candidate);
  const candidates = [value, fallback, "INTERNAL_ERROR", "SERVICE_FAILURE", "OUTPUT_FILTERED", "ERROR"]
    .filter((candidate, index, values) => valid(candidate) && values.indexOf(candidate) === index);
  return candidates.find((candidate) => !protectedValues.some((secret) => candidate.includes(secret))) || "";
}

export function publicTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}
