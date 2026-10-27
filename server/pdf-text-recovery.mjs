export const PDF_LAYOUT_RECOVERED = "PDF_LAYOUT_RECOVERED";
export const PDF_LAYOUT_RECOVERED_MESSAGE = "PDF 页面布局异常，已恢复原生文字；可能包含页外或未正常呈现的内容，必须逐页人工核对后再审核。";
export function safeParseWarnings(value) {
  return Array.isArray(value) && value.includes(PDF_LAYOUT_RECOVERED) ? [PDF_LAYOUT_RECOVERED] : [];
}
export class PdfLayoutError extends Error {
  constructor() { super("提取的文本超过 500 万字符，请拆分文档。"); this.code = "DOCUMENT_TOO_COMPLEX"; this.statusCode = 413; }
}

// PDF.js excludes out-of-view text in getTextContent. Only recover an otherwise
// empty document, from its decoded font Unicode glyphs; never interpret PDF bytes
// ourselves. Tagged/optional content is declined because its semantics may hide
// text or supply a replacement. The caller must force a new human review.
export function pdfTextFromOperators(list, ops, { maxCharacters = 5_000_000 } = {}) {
  const parts = []; let length = 0, mode = 0, fillAlpha = 1, strokeAlpha = 1;
  const states = [];
  const append = (text) => { if (!text) return; length += text.length; if (length > maxCharacters) throw new PdfLayoutError(); parts.push(text); };
  const newline = () => { if (parts.length && !parts[parts.length - 1].endsWith("\n")) append("\n"); };
  for (let i = 0; i < list.fnArray.length; i++) {
    const op = list.fnArray[i], args = list.argsArray[i] || [];
    if (op === ops.beginMarkedContent || op === ops.beginMarkedContentProps) return { text: "", declined: true };
    if (op === ops.save) states.push({ mode, fillAlpha, strokeAlpha });
    else if (op === ops.restore) { const state = states.pop(); if (state) ({ mode, fillAlpha, strokeAlpha } = state); }
    else if (op === ops.setTextRenderingMode) mode = Number(args[0]);
    else if (op === ops.setGState) for (const [key, value] of args[0] || []) { if (key === "ca") fillAlpha = Number(value); if (key === "CA") strokeAlpha = Number(value); }
    else if (op === ops.beginText || op === ops.endText || op === ops.nextLine || op === ops.nextLineShowText || op === ops.nextLineSetSpacingShowText || ((op === ops.moveText || op === ops.setLeadingMoveText) && args[1] !== 0)) newline();
    if (![ops.showText, ops.showSpacedText, ops.nextLineShowText, ops.nextLineSetSpacingShowText].includes(op)) continue;
    const fill = [0, 2, 4, 6].includes(mode) && fillAlpha > 0;
    const stroke = [1, 2, 5, 6].includes(mode) && strokeAlpha > 0;
    if (!fill && !stroke) continue;
    const glyphs = args.find(Array.isArray);
    if (!glyphs) continue;
    for (const glyph of glyphs) {
      if (glyph && typeof glyph === "object" && typeof glyph.unicode === "string") append(glyph.unicode);
    }
  }
  return { text: parts.join(""), declined: false };
}

export async function recoverEmptyPdfLayoutText(document, { maxCharacters = 5_000_000 } = {}) {
  const { OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pages = []; let length = 0;
  for (let number = 1; number <= document.numPages; number++) {
    const page = await document.getPage(number);
    try {
      const result = pdfTextFromOperators(await page.getOperatorList(), OPS, { maxCharacters: maxCharacters - length });
      if (result.declined) return "";
      length += result.text.length + (pages.length ? 2 : 0);
      if (length > maxCharacters) throw new PdfLayoutError();
      pages.push(result.text);
    } finally { page.cleanup(); }
  }
  return pages.join("\n\n");
}
