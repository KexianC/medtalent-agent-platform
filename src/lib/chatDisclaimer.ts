/** The fixed notice belongs below references, outside the reply and speech. */
export const CHAT_DISCLAIMER = "以上内容仅供健康科普参考，不构成诊断或治疗建议。";

const noticeHeads = [
  "以上内容仅供健康科普参考",
  "以上内容仅供健康参考",
  "以上内容仅供健康（科普）参考",
  "以上内容仅供健康(科普)参考",
];
// Match only known wording. In particular, do not remove general health advice,
// crisis guidance, or arbitrary sentences containing “诊断” or “治疗建议”.
const noticeCores = noticeHeads.flatMap((head) => [
  `${head}，不构成诊断或治疗建议`,
  `${head},不构成诊断或治疗建议`,
  head,
]).sort((left, right) => right.length - left.length);
const prefixes = new Set(noticeCores.flatMap((notice) => (
  Array.from({ length: notice.length }, (_, index) => notice.slice(0, index + 1))
)));

const startsSentence = (previous: string) => !previous || /[\s。！？.!?]/u.test(previous);
const startsCandidate = /[以#*_+\-0-9提温]/u;
const labels = ["", "提醒：", "提醒:", "提示：", "提示:", "温馨提示：", "温馨提示:", "温馨提醒：", "温馨提醒:"];
const openings = [...new Map(labels.flatMap((label) => ["", "**", "__"].flatMap((emphasis) => [
  { open: `${label}${emphasis}`, close: emphasis },
  { open: `${emphasis}${label}`, close: emphasis },
  ...(label && emphasis ? [{ open: `${label} ${emphasis}`, close: emphasis }] : []),
])).map((item) => [`${item.open}\0${item.close}`, item])).values()];

function inspectNotice(text: string, final: boolean): { removed: number; possible: boolean } {
  const markdown = /^(?:#{1,6}[ \t]+|[-+*][ \t]+|\d{1,3}[.)][ \t]+)/u.exec(text)?.[0] || "";
  const rest = text.slice(markdown.length);
  let possible = /^(?:#{1,6}|[-+*]|\d{1,3}[.)]?)[ \t]*$/u.test(text);
  for (const { open, close } of openings) {
    if (open.startsWith(rest)) possible = true;
    if (!rest.startsWith(open)) continue;
    const spaces = /^[ \t]*/u.exec(rest.slice(open.length))?.[0] || "";
    const bodyOffset = markdown.length + open.length + spaces.length;
    const body = text.slice(bodyOffset);
    if (prefixes.has(body) || !body) possible = true;
    for (const notice of noticeCores) {
      if (!body.startsWith(notice)) continue;
      let following = body.slice(notice.length);
      let removed = bodyOffset + notice.length;
      const hasPeriod = /^[。.]/u.test(following);
      if (hasPeriod) { following = following.slice(1); removed += 1; }
      if (close) {
        if (!following.startsWith(close)) {
          if (close.startsWith(following)) {
            possible = true;
            // A final incomplete Markdown closer must not make an otherwise
            // complete fixed notice speakable after Markdown is cleaned up.
            if (final) return { removed: removed + following.length, possible: false };
          }
          continue;
        }
        following = following.slice(close.length);
        removed += close.length;
        if (/^[。.]/u.test(following)) return { removed: removed + 1, possible: false };
        if (!following && !hasPeriod && !final) { possible = true; continue; }
        return { removed, possible: false };
      }
      if (hasPeriod || /^[ \t]*[\r\n]/u.test(following) || (final && /^[ \t]*$/u.test(following))) {
        return { removed, possible: false };
      }
      if (/^[ \t]*$/u.test(following)) possible = true;
    }
  }
  return { removed: 0, possible };
}

export type ChatDisclaimerParts = {
  body: string;
  disclaimer: string | null;
};

export type ChatDisclaimerFilter = {
  /** Returns safe incremental text immediately; only a possible notice suffix waits. */
  push: (delta: string) => string;
  /** Flush after successful completion only. Discard the instance on cancellation. */
  finish: () => string;
  readonly hasDisclaimer: boolean;
};

/**
 * Each reply needs its own filter. Feed its returned text to both the displayed
 * reply and the speech queue. Original surrounding whitespace is preserved;
 * the full-reply helpers below trim it when a notice was actually removed.
 */
export function createChatDisclaimerFilter(): ChatDisclaimerFilter {
  let pending = "";
  let previous = "";
  let found = false;
  let finished = false;
  let linePrefix = "";
  let quotedLine = false;
  let codeFence = "";

  const consume = (text: string) => {
    for (const character of text) {
      previous = character;
      if (character === "\n") {
        const fence = /^ {0,3}(`{3,}|~{3,})/u.exec(linePrefix)?.[1];
        if (fence && (!codeFence || (fence[0] === codeFence[0] && fence.length >= codeFence.length))) {
          codeFence = codeFence ? "" : fence;
        }
        linePrefix = "";
        quotedLine = false;
      } else {
        if (linePrefix.length < 16) linePrefix += character;
        if (/^ {0,3}>/u.test(linePrefix)) quotedLine = true;
      }
    }
  };

  const drain = (final: boolean) => {
    let output = "";
    let position = 0;
    while (position < pending.length) {
      if (!quotedLine && !codeFence && startsCandidate.test(pending[position]) && startsSentence(previous)) {
        const remaining = pending.slice(position);
        const { removed, possible } = inspectNotice(remaining, final);
        if (removed) {
          consume(remaining.slice(0, removed));
          position += removed;
          found = true;
          continue;
        }
        if (!final && possible) break;
      }
      const character = pending[position];
      output += character;
      consume(character);
      position += 1;
    }
    pending = pending.slice(position);
    return output;
  };

  return {
    push(delta) {
      if (finished || !delta) return "";
      pending += delta;
      return drain(false);
    },
    finish() {
      if (finished) return "";
      finished = true;
      return drain(true);
    },
    get hasDisclaimer() { return found; },
  };
}

/** Parse legacy saved replies without changing the saved record itself. */
export function splitChatDisclaimer(text: string): ChatDisclaimerParts {
  const filter = createChatDisclaimerFilter();
  const body = filter.push(text) + filter.finish();
  return {
    body: filter.hasDisclaimer ? body.trim() : body,
    disclaimer: filter.hasDisclaimer ? CHAT_DISCLAIMER : null,
  };
}

export function stripChatDisclaimer(text: string): string {
  return splitChatDisclaimer(text).body;
}
