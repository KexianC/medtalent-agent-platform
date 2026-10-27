import { collisionFreeMarker, safeOutputText, SENSITIVE_ASSIGNMENT } from "./output-safety.mjs";

// Only complete clauses are publishable. A Chinese comma gives the voice queue
// an early short phrase without treating a URL's dots or a credential's colon
// as a safe boundary.
const CLAUSE_BOUNDARY = /[，,。！？!?；;\n]/gu;
const FIELD_WORDS = [
  ["password"], ["passwd"], ["pwd"], ["secret"], ["secret", "access", "key"],
  ["access", "key"], ["access", "key", "id"], ["api", "key"], ["private", "key"],
  ["token"], ["session", "token"], ["security", "token"], ["auth", "token"], ["refresh", "token"],
  ["authorization"], ["credential"], ["x", "amz", "security", "token"], ["x", "amz", "signature"],
  ["signature"], ["set", "cookie"], ["cookie"],
];
const fullField = FIELD_WORDS.map((words) => words.join("[\\s_-]*")).join("|");
const fieldTail = new RegExp(`(?:${fullField})[\\w-]*["']?\\s*(?:[:=]\\s*)?$`, "iu");
const partialFieldTail = new RegExp(`(?:${[...new Set(FIELD_WORDS.flatMap((words) =>
  words.slice(1).flatMap((word, index) => Array.from({ length: word.length }, (_unused, length) =>
    `${words.slice(0, index + 1).join("[\\s_-]*")}[\\s_-]*${word.slice(0, length)}`))))].join("|")})$`, "iu");

function protectedRepresentations(secrets) {
  return [...new Set(secrets.filter((value) => typeof value === "string" && value).flatMap((value) => {
    let encoded = value;
    try { encoded = encodeURIComponent(value); } catch { /* Preserve malformed UTF-16 literally and through JSON escapes. */ }
    const unicode = value.split("").map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    const bytes = Buffer.from(value, "utf8");
    return [value, encoded, encoded.replace(/%[A-F0-9]{2}/gu, (part) => part.toLowerCase()),
      JSON.stringify(value).slice(1, -1), unicode, unicode.toUpperCase().replace(/\\U/gu, "\\u"),
      bytes.toString("base64"), bytes.toString("base64url")];
  }))].sort((left, right) => right.length - left.length);
}

const canonicalEscapes = (value) => value.replace(/%[a-f0-9]{2}/giu, (part) => part.toUpperCase())
  .replace(/\\u[a-f0-9]{4}/giu, (part) => `\\u${part.slice(2).toLowerCase()}`);

function closingQuote(text, start) {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") { index += 1; continue; }
    if (text[index] === quote) return index + 1;
  }
  return -1;
}

/**
 * A fail-closed, clause-based transducer. Unresolved lexical constructs remain
 * private until closed; ordinary clauses need no provider [DONE] to be emitted.
 * The caller bounds total provider bytes/characters, including withheld text.
 */
export function createSafeReplyStream(secrets = []) {
  const protectedValues = protectedRepresentations(secrets);
  const comparableValues = [...new Set(protectedValues.map(canonicalEscapes))];
  const marker = collisionFreeMarker(protectedValues);
  let pending = "";
  let finished = false;

  function inspect() {
    const spans = [];
    let unresolved = pending.length;
    const hold = (start) => { unresolved = Math.min(unresolved, start); };
    const protect = (start, end, redact = true) => { spans.push({ start, end, redact }); };

    const privateStart = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/gu;
    let match;
    while ((match = privateStart.exec(pending))) {
      const endPattern = /-----END [A-Z0-9 ]*PRIVATE KEY-----/gu;
      endPattern.lastIndex = privateStart.lastIndex;
      const end = endPattern.exec(pending);
      if (!end) { hold(match.index); break; }
      protect(match.index, endPattern.lastIndex);
      privateStart.lastIndex = endPattern.lastIndex;
    }

    const assignments = new RegExp(SENSITIVE_ASSIGNMENT.source, SENSITIVE_ASSIGNMENT.flags);
    while ((match = assignments.exec(pending))) {
      const valueStart = match.index + match[1].length;
      let end;
      if (pending[valueStart] === '"' || pending[valueStart] === "'") {
        end = closingQuote(pending, valueStart);
        if (end < 0) { hold(match.index); break; }
      } else {
        end = valueStart;
        while (end < pending.length && !/[\s,;&}\]]/u.test(pending[end])) end += 1;
        if (end === pending.length) { hold(match.index); break; }
      }
      protect(match.index, end);
      assignments.lastIndex = end;
    }

    for (const pattern of [fieldTail, partialFieldTail, /\b(?:Basic|Bearer)\s*$/iu]) {
      const tail = pattern.exec(pending);
      if (tail) hold(tail.index);
    }

    const auth = /\b(?:Basic|Bearer)\s+[A-Za-z0-9+/_=.~:-]+/giu;
    while ((match = auth.exec(pending))) {
      if (auth.lastIndex === pending.length) hold(match.index);
      else protect(match.index, auth.lastIndex);
    }

    // Do not release any part of an unfinished URL authority: legacy userinfo
    // can contain punctuation and more than one @ before the actual host.
    const authority = /[a-z][a-z0-9+.-]*:\/\/[^\s/?#]*/giu;
    while ((match = authority.exec(pending))) {
      if (authority.lastIndex === pending.length) hold(match.index);
      else protect(match.index, authority.lastIndex, false);
    }

    const comparableText = canonicalEscapes(pending);
    for (const secret of comparableValues) {
      let start = comparableText.indexOf(secret);
      while (start >= 0) {
        protect(start, start + secret.length);
        start = comparableText.indexOf(secret, start + 1);
      }
      // A credential may itself contain a clause separator. Retain its suffix
      // prefix even when the current frame appears to finish a sentence.
      for (let size = Math.min(pending.length, secret.length - 1); size > 0; size -= 1) {
        if (comparableText.endsWith(secret.slice(0, size))) {
          hold(pending.length - size);
          break;
        }
      }
    }
    return { spans, unresolved };
  }

  function render(end, spans) {
    const redactions = spans.filter((span) => span.redact && span.start < end && span.end <= end)
      .sort((left, right) => left.start - right.start || right.end - left.end);
    let text = "";
    let cursor = 0;
    for (const span of redactions) {
      if (span.end <= cursor) continue;
      if (span.start >= cursor) text += pending.slice(cursor, span.start) + marker;
      cursor = span.end;
    }
    text += pending.slice(cursor, end);
    return safeOutputText(text, protectedValues, Infinity);
  }

  return {
    hasFollowingTextWithin(maxCharacters) {
      if (!marker || maxCharacters <= 0) return false;
      const { unresolved } = inspect();
      return [...pending.slice(0, unresolved)].slice(0, maxCharacters)
        .some((character) => !/[，、；：\s]/u.test(character));
    },
    push(delta) {
      if (finished) throw new Error("OUTPUT_STREAM_FINISHED");
      pending += delta;
      const { spans, unresolved } = inspect();
      const available = Math.min(unresolved, pending.trimEnd().length);
      let boundary = 0;
      for (const match of pending.matchAll(CLAUSE_BOUNDARY)) {
        const end = match.index + match[0].length;
        if (end > available) break;
        if (!spans.some((span) => span.start < end && span.end > end)) boundary = end;
      }
      if (!boundary) return "";
      const output = render(boundary, spans);
      pending = pending.slice(boundary);
      return output;
    },
    finish() {
      if (finished) return "";
      finished = true;
      const { spans, unresolved } = inspect();
      // Missing key terminators, open quotes, and dangling credential prefixes
      // are discarded, never released merely because the provider said DONE.
      if (unresolved < pending.length) spans.push({ start: unresolved, end: pending.length, redact: true });
      const output = render(pending.length, spans);
      pending = "";
      return output;
    },
  };
}
