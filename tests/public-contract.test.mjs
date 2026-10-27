import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parsePublicDirectory, parsePublicDoctorDetail, parsePublishedContent } from "../src/hooks/useDoctorDirectory.ts";
import { parseChatRetrieval, readChatStream, stripChatCitationDetails } from "../src/lib/chatStream.ts";

test("published directory keeps a successful empty response empty", () => {
  assert.deepEqual(parsePublicDirectory([]), []);
  assert.throws(() => parsePublicDirectory({ doctors: [] }), /目录格式/);
  assert.throws(() => parsePublicDirectory([{}]), /资料不完整/);
});

test("new agents retain their identity without invented qualifications or bundled fallback", () => {
  const doctor = parsePublicDoctorDetail({ slug: "new-agent", name: "新知识助手", welcomeMessage: "自定义开场", version: 4, systemPrompt: "not-public", content: [] });
  assert.equal(doctor.slug, "new-agent");
  assert.equal(doctor.name, "新知识助手");
  assert.equal(doctor.hospital, "");
  assert.equal(doctor.title, "");
  assert.equal(doctor.welcomeMessage, "自定义开场");
  assert.equal(doctor.version, 4);
  assert.equal("systemPrompt" in doctor, false);
  assert.deepEqual(doctor.content, []);
});

test("only public content types and published status reach the content UI", () => {
  const content = parsePublishedContent([
    { id: "article-1", type: "article", title: "文章", body: "完整正文", status: "published" },
    { id: "faq-1", type: "faq", title: "问题", body: "完整回答", status: "published" },
    { id: "service-1", type: "service", title: "服务", body: "完整服务说明", status: "published" },
    { id: "notice-1", type: "notice", title: "公告", body: "完整公告", status: "published" },
    { id: "draft", type: "article", title: "草稿", body: "不应显示", status: "draft" },
    { id: "unknown", type: "internal", title: "内部配置", body: "不应显示" },
  ]);
  assert.equal(content.length, 4);
  assert.equal(content[0].body, "完整正文");
  assert.equal(content[1].body, "完整回答");
});

test("chat metadata validates citations and keeps explicit no-retrieval mode", () => {
  assert.deepEqual(parseChatRetrieval({ citations: [], retrievalMode: "none" }), { citations: [], retrievalMode: "none" });
  assert.deepEqual(parseChatRetrieval({ citations: [{ title: " 资料标题 ", text: "不应进入用户状态", documentId: "private-id", score: 0.9, chunkIndex: 3 }, { title: "资料标题", text: "另一个命中片段" }, null], retrievalMode: "hybrid" }), { citations: [{ title: "资料标题" }], retrievalMode: "hybrid" });
  assert.deepEqual(parseChatRetrieval({ citations: [{ documentId: "missing-title" }, { title: "  " }], retrievalMode: "invented" }), { citations: [] });
  assert.deepEqual(parseChatRetrieval(undefined), {});
});

test("legacy browser chat records drop citation excerpts before being stored again", () => {
  const legacy = { citations: [{ title: "旧资料", text: "历史原文", documentId: "doc-1", score: 0.8, chunkIndex: 1 }], retrievalMode: "lexical" };
  const sanitized = stripChatCitationDetails(legacy);
  assert.notEqual(sanitized, legacy);
  assert.deepEqual(sanitized, { citations: [{ title: "旧资料" }], retrievalMode: "lexical" });
  assert.equal(stripChatCitationDetails(sanitized), sanitized);
});

test("NDJSON reads Chinese text across byte boundaries and keeps only citation titles on done", async () => {
  const citation = { documentId: "doc-1", title: "知识文档", text: "原文片段", score: 0.73, chunkIndex: 2 };
  const body = [
    { type: "meta", model: "configured-model" },
    { type: "delta", text: "你好，" },
    { type: "delta", text: "这是回复。" },
    { type: "done", citations: [citation], retrievalMode: "hybrid" },
  ].map((event) => JSON.stringify(event)).join("\n");
  const bytes = new TextEncoder().encode(body);
  const response = new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7));
    controller.close();
  } }));
  const events = [];
  for await (const event of readChatStream(response)) events.push(event);
  assert.equal(events.filter((event) => event.type === "delta").map((event) => event.text).join(""), "你好，这是回复。");
  assert.deepEqual(events.at(-1).citations, [{ title: "知识文档" }]);
  assert.equal(JSON.stringify(events.at(-1).citations).includes("原文片段"), false);
  assert.equal(events.at(-1).retrievalMode, "hybrid");
});

test("user citation panel is closed by default and renders titles only", async () => {
  const source = await readFile(new URL("../src/pages/DoctorApp.tsx", import.meta.url), "utf8");
  const start = source.indexOf("function MessageCitations");
  const end = source.indexOf("\nfunction AssessmentSheet", start);
  assert.ok(start >= 0 && end > start);
  const component = source.slice(start, end);
  assert.match(component, /<details className="journey-citations">/u);
  assert.match(component, /<li[^>]*>.*citation\.title.*<\/li>/u);
  assert.doesNotMatch(component, /<details[^>]+\bopen(?:=|\s|>)/u);
  assert.doesNotMatch(component, /citation\.(?:text|documentId|score|chunkIndex)|文档片段/u);
});

test("result metadata is supported while invalid citations do not leak into event types", async () => {
  const events = [];
  for await (const event of readChatStream(new Response('{"type":"result","reply":"全文","citations":"invalid"}\n{"type":"done","retrievalMode":"none"}'))) events.push(event);
  assert.equal(events[0].type, "result");
  assert.equal(events[0].reply, "全文");
  assert.equal(events[0].citations, undefined);
  assert.equal(events[1].retrievalMode, "none");
});

test("malformed chat stream reports an error instead of silently producing a reply", async () => {
  await assert.rejects(async () => {
    for await (const event of readChatStream(new Response("not json\n"))) void event;
  }, /格式无效/);
});
