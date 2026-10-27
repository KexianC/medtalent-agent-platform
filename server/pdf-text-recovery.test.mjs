import test from "node:test";
import assert from "node:assert/strict";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFParse } from "pdf-parse";
import { parseDocument } from "./rag.mjs";
import { parseDocumentIsolated } from "./document-parser.mjs";
import { pdfTextFromOperators, PDF_LAYOUT_RECOVERED, PDF_LAYOUT_RECOVERED_MESSAGE, safeParseWarnings } from "./pdf-text-recovery.mjs";
import { publicDocument } from "./knowledge-service.mjs";

function makePdf(stream) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    '<< /Length '+Buffer.byteLength(stream)+' >>\nstream\n'+stream+'\nendstream',
  ];
  let output = "%PDF-1.4\n"; const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(output)); output += (i+1)+" 0 obj\n"+objects[i]+"\nendobj\n"; }
  const xref = Buffer.byteLength(output);
  output += "xref\n0 "+(objects.length+1)+"\n0000000000 65535 f \n";
  output += offsets.slice(1).map(offset => String(offset).padStart(10,"0")+" 00000 n \n").join("");
  output += "trailer\n<< /Size "+(objects.length+1)+" /Root 1 0 R >>\nstartxref\n"+xref+"\n%%EOF\n";
  return Buffer.from(output);
}
const outsideText = 'BT /F1 12 Tf 72 7000 Td (Recovered layout knowledge) Tj ET';

test("empty PDF.js text with valid out-of-view Unicode glyphs recovers with a mandatory review warning", async () => {
  const bytes = makePdf(outsideText), original = new PDFParse({data:new Uint8Array(bytes),isEvalSupported:false,enableXfa:false,verbosity:0});
  try { assert.equal((await original.getText({pageJoiner:""})).text.trim(), ""); } finally { await original.destroy(); }
  const warnings = [];
  assert.equal(await parseDocument(bytes,{name:"synthetic.pdf",onWarning:code=>warnings.push(code)}), "Recovered layout knowledge");
  assert.deepEqual(warnings,[PDF_LAYOUT_RECOVERED]);
});

test("ordinary PDF text never appends out-of-view glyphs or produces recovery warnings", async () => {
  const warnings=[];
  const text=await parseDocument(makePdf('BT /F1 12 Tf 72 700 Td (Visible knowledge) Tj ET\n'+outsideText),{name:"normal.pdf",onWarning:code=>warnings.push(code)});
  assert.match(text,/Visible knowledge/);assert.doesNotMatch(text,/Recovered/);assert.deepEqual(warnings,[]);
});

test("scan-only, invisible or tagged replacement text cannot be promoted by glyph recovery",async()=>{
  for(const stream of ['', 'BT /F1 12 Tf 3 Tr 72 7000 Td (Invisible must not recover) Tj ET', '/Span << /ActualText (Replacement) >> BDC '+outsideText+' EMC']){
    await assert.rejects(parseDocument(makePdf(stream),{name:"guard.pdf"}),{code:"PDF_OCR_REQUIRED"});
  }
});

test("operator recovery preserves save/restore, excludes transparent glyphs and enforces the existing text limit",()=>{
  const list={fnArray:[OPS.showText,OPS.save,OPS.setGState,OPS.showText,OPS.restore,OPS.showText],argsArray:[[[{unicode:"A"}]],[],[[["ca",0],["CA",0]]],[[{unicode:"hidden"}]],[],[[{unicode:"B"}]]]};
  assert.equal(pdfTextFromOperators(list,OPS).text,"AB");
  assert.throws(()=>pdfTextFromOperators(list,OPS,{maxCharacters:1}),{code:"DOCUMENT_TOO_COMPLEX"});
});

test("isolated parser keeps its string contract and only opt-in diagnostics returns safe warning codes",async()=>{
  const bytes=makePdf(outsideText);
  assert.equal(await parseDocumentIsolated(bytes,{name:"compatibility.pdf"}),"Recovered layout knowledge");
  assert.deepEqual(await parseDocumentIsolated(bytes,{name:"diagnostics.pdf"},{includeDiagnostics:true}),{text:"Recovered layout knowledge",parseWarnings:[PDF_LAYOUT_RECOVERED]});
  assert.deepEqual(await parseDocumentIsolated(Buffer.from("Ordinary knowledge"),{name:"ordinary.txt"},{includeDiagnostics:true}),{text:"Ordinary knowledge",parseWarnings:[]});
});

test("publicDocument only projects allowlisted parse warnings and never raw warning details",()=>{
  const secret="private-patient-and-source-path";
  const projected=publicDocument({status:"review",parseWarnings:[secret,PDF_LAYOUT_RECOVERED,PDF_LAYOUT_RECOVERED],warning:secret},{});
  assert.deepEqual(projected.parseWarnings,[PDF_LAYOUT_RECOVERED]);assert.equal(JSON.stringify(projected).includes(secret),false);
  assert.deepEqual(safeParseWarnings([secret]),[]);
});

test("recovered-layout NAS auto-publish and prior approval are revoked until a fresh human review",async t=>{
  const fs=await import("node:fs/promises"),os=await import("node:os"),path=await import("node:path");
  const {PlatformDatabase}=await import("./database.mjs"),{KnowledgeService}=await import("./knowledge-service.mjs"),{normalizeSource}=await import("./domain.mjs");
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"pdf-layout-review-test-"));
  const slug="layout-fixture",db=new PlatformDatabase({dataDir:directory,seedDoctors:[{slug,name:"合成资料审核",hospital:"",department:"科普",specialty:"健康知识"}]});
  const knowledge=new KnowledgeService(db,{env:{},fetchImpl:()=>assert.fail("must not request network")});
  t.after(async()=>{await knowledge.stop?.();await db.close();await fs.rm(directory,{recursive:true,force:true});});
  const source=normalizeSource({name:"合成来源",agentSlug:slug,transport:"webdav",path:"folder",autoPublish:true});await db.saveEntity("sources",source);
  const queued=await knowledge.storeDocument({agentSlug:slug,name:"layout.pdf",buffer:makePdf(outsideText),mimeType:"application/pdf",source:"nas",sourceId:source.id,sourcePath:"folder/layout.pdf",approved:source.autoPublish},"fixture");
  await db.patchEntity("documents",queued.document.id,{approved:true,approvedBy:"previous-reviewer",approvedAt:new Date().toISOString()});
  await knowledge.runOne();
  const document=await db.requireEntity("documents",queued.document.id);
  assert.equal(document.status,"review");assert.equal(document.approved,false);assert.equal(document.approvedBy,null);assert.equal(document.approvedAt,null);
  assert.deepEqual(document.parseWarnings,[PDF_LAYOUT_RECOVERED]);assert.equal(document.warning,PDF_LAYOUT_RECOVERED_MESSAGE);assert.ok(document.chunkCount>0);
  assert.deepEqual(knowledge.publicDocument(document).parseWarnings,[PDF_LAYOUT_RECOVERED]);
  assert.equal((await knowledge.search(slug,"Recovered layout knowledge")).citations.length,0);
  const normal=await knowledge.storeDocument({agentSlug:slug,name:"ordinary.txt",buffer:Buffer.from("Ordinary auto published knowledge"),mimeType:"text/plain",source:"nas",sourceId:source.id,sourcePath:"folder/ordinary.txt",approved:source.autoPublish},"fixture");
  await knowledge.runOne();const ordinary=await db.requireEntity("documents",normal.document.id);
  assert.equal(ordinary.status,"ready");assert.equal(ordinary.approved,true);assert.deepEqual(ordinary.parseWarnings,[]);
});
