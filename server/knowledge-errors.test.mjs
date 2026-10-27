import test from "node:test";
import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import JSZip from "jszip";
import {extractLargeDocxText} from "./docx-text.mjs";
import {parseDocumentIsolated} from "./document-parser.mjs";
import {classifyKnowledgeError,knowledgeFailureRecord} from "./knowledge-errors.mjs";
const WORD="http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const xml=body=>'<?xml version="1.0"?><w:document xmlns:w="'+WORD+'"><w:body>'+body+'</w:body></w:document>';
async function docx(main) {
  const zip=new JSZip();
  zip.file("[Content_Types].xml",'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels",'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml",main);
  return await zip.generateAsync({type:"nodebuffer",compression:"DEFLATE"});
}
test("safe taxonomy maps historical parser failures and retains existing healthy documents",()=>{
  for(const [message,code] of [
    ["文档抽取内容超过200万字符，请拆分后上传。","DOCUMENT_TEXT_LIMIT"],
    ["提取的文本超过 500 万字符，请拆分文档。","DOCUMENT_TEXT_LIMIT"],
    ["PDF 超过 2,000 页，请拆分后上传。","PDF_PAGE_LIMIT"],
    ["DOCX 解压后的内容超过 100 MB 限制。","DOCX_EXPANDED_LIMIT"],
    ["文档处理在服务中断后已达到最大重试次数，请检查文件后手动重试。","JOB_RETRY_EXHAUSTED"],
    ["PDF 没有可提取的文字，可能是扫描件；请先 OCR 识别后再上传。","PDF_OCR_REQUIRED"],
  ])assert.equal(classifyKnowledgeError({status:"error",error:message}).code,code);
  assert.equal(classifyKnowledgeError({status:"review",error:"stale"}),null);
  assert.equal(classifyKnowledgeError({status:"ready",errorCode:"DOCUMENT_PARSE_FAILED"}),null);
  assert.equal(classifyKnowledgeError(null),null);
});
test("persisted and displayed failures never expose upstream text, paths, patient data or arbitrary codes",()=>{
  const secret="private-patient-and-token=/server/private/source";
  const err=Object.assign(new Error(secret),{code:"UPSTREAM_"+secret});
  const classified=classifyKnowledgeError(err),record=knowledgeFailureRecord(err);
  assert.equal(classified.code,"DOCUMENT_PARSE_FAILED");
  assert.equal(record.errorCode,"DOCUMENT_PARSE_FAILED");
  assert.equal(JSON.stringify({classified,record}).includes(secret),false);
  assert.equal(classifyKnowledgeError({code:"DOCUMENT_PARSE_MEMORY_LIMIT",message:secret}).retryable,false);
  assert.deepEqual(classifyKnowledgeError({code:"PDF_OCR_REQUIRED",message:secret}).recoveryActions,["download","ocr"]);
});
test("text-only OOXML extraction preserves entities, paragraphs, tables, tabs and the active revision",()=>{
  const body='<w:p><w:r><w:t>A &amp; B &lt; C &#x4e2d;&#25991;</w:t><w:tab/><w:t>Tail</w:t><w:br/><w:t>Line</w:t></w:r><w:del><w:r><w:t>Deleted must stay hidden</w:t></w:r></w:del></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
  const text=extractLargeDocxText(Buffer.from(xml(body)));
  assert.match(text,/A & B < C 中文\tTail\nLine\n\n/);
  assert.match(text,/Cell\n\n\t/);
  assert.doesNotMatch(text,/Deleted/);
  assert.equal(extractLargeDocxText(Buffer.from('<x:document xmlns:x="'+WORD+'"><x:body><x:p><x:r><x:t>Alias</x:t></x:r></x:p></x:body></x:document>')).trim(),"Alias");
});
test("OOXML extraction rejects external/custom entities, malformed XML and unbounded nesting",()=>{
  assert.throws(()=>extractLargeDocxText(Buffer.from('<!DOCTYPE w:document [<!ENTITY secret SYSTEM "file:///never-read">]>'+xml('<w:p><w:r><w:t>&secret;</w:t></w:r></w:p>'))),{code:"INVALID_DOCX"});
  assert.throws(()=>extractLargeDocxText(Buffer.from(xml('<w:p><w:r><w:t>&unknown;</w:t></w:r></w:p>'))),{code:"INVALID_DOCX"});
  assert.throws(()=>extractLargeDocxText(Buffer.from(xml('<w:p><w:r><w:t>broken</w:r></w:p>'))),{code:"INVALID_DOCX"});
  assert.throws(()=>extractLargeDocxText(Buffer.from(xml('<w:p>'.repeat(260)+'<w:r><w:t>deep</w:t></w:r>'+'</w:p>'.repeat(260)))),{code:"DOCUMENT_TOO_COMPLEX"});
  assert.throws(()=>extractLargeDocxText(Buffer.from(xml('<w:p><w:r><w:t>too long</w:t></w:r></w:p>')),{maxCharacters:3}),{code:"DOCUMENT_TOO_COMPLEX"});
});
test("large XML DOCX parses inside the unchanged isolated worker without constructing a DOM",async()=>{
  const expected="Bounded large XML knowledge",padding='<w:r><w:rPr><w:b/></w:rPr></w:r>'.repeat(280000);
  const main=xml('<w:p>'+padding+'<w:r><w:t>'+expected+'</w:t></w:r></w:p>');
  assert.ok(Buffer.byteLength(main)>8*1024*1024);
  const bytes=await docx(main);
  const text=await parseDocumentIsolated(bytes,{name:"large-xml.docx"});
  assert.equal(text,expected);
});
test("isolated parser preserves safe limit reasons and does not echo worker stderr",async()=>{
  await assert.rejects(parseDocumentIsolated(Buffer.from("A".repeat(5_000_001)),{name:"text-limit.txt"}),{code:"DOCUMENT_TEXT_LIMIT"});
  const worker=fileURLToPath(new URL("./fixtures/document-parser-test-worker.mjs",import.meta.url));
  await assert.rejects(parseDocumentIsolated(Buffer.from("safe"),{name:"memory-limit.txt"},{workerFile:worker}),error=>error.code==="DOCUMENT_PARSE_MEMORY_LIMIT"&&!error.message.includes("private-source"));
  assert.equal(await parseDocumentIsolated(Buffer.from("next parse is healthy"),{name:"next.txt"}),"next parse is healthy");
});

test("ingest persists a safe failure code and a corrected revision returns only to review",async t=>{
  const fs=await import("node:fs/promises"),os=await import("node:os"),path=await import("node:path");
  const {PlatformDatabase}=await import("./database.mjs"),{KnowledgeService}=await import("./knowledge-service.mjs");
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"knowledge-taxonomy-test-"));
  const db=new PlatformDatabase({dataDir:directory,seedDoctors:[{slug:"taxonomy-fixture",name:"合成知识测试",hospital:"",department:"科普",specialty:"健康知识"}]});
  const knowledge=new KnowledgeService(db,{env:{}});
  t.after(async()=>{await knowledge.stop?.();await db.close();await fs.rm(directory,{recursive:true,force:true});});
  const secret="private-body-must-not-be-logged";
  const queued=await knowledge.storeDocument({agentSlug:"taxonomy-fixture",name:"broken.pdf",buffer:Buffer.from(secret),mimeType:"application/pdf",approved:false},"fixture");
  await knowledge.runOne();
  const failed=await db.requireEntity("documents",queued.document.id);
  assert.equal(failed.status,"error");
  assert.equal(failed.errorCode,"INVALID_PDF");
  assert.equal(JSON.stringify(failed).includes(secret),false);
  assert.equal(knowledge.publicDocument(failed).errorCode,"INVALID_PDF");
  const corrected=await knowledge.storeDocument({agentSlug:"taxonomy-fixture",name:"corrected.txt",buffer:Buffer.from("Synthetic corrected knowledge"),mimeType:"text/plain",approved:false,existing:failed},"fixture");
  await knowledge.runOne();
  const reviewed=await db.requireEntity("documents",corrected.document.id);
  assert.equal(reviewed.id,failed.id);
  assert.equal(reviewed.revision,failed.revision+1);
  assert.equal(reviewed.status,"review");
  assert.equal(reviewed.approved,false);
  assert.equal(reviewed.errorCode,null);
  assert.equal(reviewed.error,null);
  assert.ok(reviewed.chunkCount>0);
});
