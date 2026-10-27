import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { parseDocumentIsolated } from "./document-parser.mjs";
import { KnowledgeError } from "./rag.mjs";

const fixtureWorker = fileURLToPath(new URL("./fixtures/document-parser-test-worker.mjs", import.meta.url));

function makePdf(text) {
  const escaped = text.replace(/[\\()]/g, (character) => `\\${character}`);
  const stream = `BT /F1 12 Tf 72 700 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

test("isolated parser returns ordinary document text", async () => {
  const text = await parseDocumentIsolated(Buffer.from("睡眠管理\r\n规律作息"), { name: "睡眠.txt" });
  assert.equal(text, "睡眠管理\n规律作息");
  assert.match(await parseDocumentIsolated(makePdf("Healthy sleep knowledge"), { name: "guide.pdf" }), /Healthy sleep knowledge/);
});

test("isolated parser maps damaged documents to safe KnowledgeError", async () => {
  await assert.rejects(
    parseDocumentIsolated(Buffer.from("not a PDF"), { name: "broken.pdf" }),
    (error) => error instanceof KnowledgeError
      && error.code === "INVALID_PDF"
      && !error.message.includes("not a PDF"),
  );
});

test("isolated parser enforces bounded output and timeout", async () => {
  await assert.rejects(
    parseDocumentIsolated(Buffer.from("content"), { name: "overflow.txt" }, { workerFile: fixtureWorker, maxStdoutBytes: 128 }),
    { name: "KnowledgeError", code: "DOCUMENT_PARSE_OUTPUT_LIMIT" },
  );
  await assert.rejects(
    parseDocumentIsolated(Buffer.from("content"), { name: "stderr-overflow.txt" }, { workerFile: fixtureWorker, maxStderrBytes: 128 }),
    { name: "KnowledgeError", code: "DOCUMENT_PARSE_OUTPUT_LIMIT" },
  );
  await assert.rejects(
    parseDocumentIsolated(Buffer.from("content"), { name: "timeout.txt" }, { workerFile: fixtureWorker, timeoutMs: 100 }),
    { name: "KnowledgeError", code: "DOCUMENT_PARSE_TIMEOUT" },
  );
});

test("isolated parser gives the worker a capped heap and no inherited server secret", async () => {
  const previous = process.env.PARSER_TEST_SECRET;
  process.env.PARSER_TEST_SECRET = "must-not-cross-process-boundary";
  try {
    const result = await parseDocumentIsolated(Buffer.from("content"), { name: "probe.txt" }, { workerFile: fixtureWorker });
    const [environment, heap, execArguments] = result.split(":");
    assert.equal(environment, "clean");
    assert.match(execArguments, /--max-old-space-size=640/);
    assert.ok(Number(heap) >= 640 && Number(heap) <= 896, `unexpected total V8 heap limit: ${heap} MiB`);
  } finally {
    if (previous === undefined) delete process.env.PARSER_TEST_SECRET;
    else process.env.PARSER_TEST_SECRET = previous;
  }
});

test("a parser worker crash becomes a safe error and does not break the next parse", async () => {
  await assert.rejects(
    parseDocumentIsolated(Buffer.from("content"), { name: "crash.txt" }, { workerFile: fixtureWorker }),
    { name: "KnowledgeError", code: "DOCUMENT_PARSE_FAILED" },
  );
  assert.equal(await parseDocumentIsolated(Buffer.from("后续任务正常"), { name: "next.txt" }), "后续任务正常");
});
