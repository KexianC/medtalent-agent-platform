import { listBuilderReviewers, submitBuilderReview } from "./agent-builder.mjs";
import { registerAgentBuilderRoutes } from "./agent-builder-routes.mjs";
import { doctorProfiles } from "../src/data/doctorProfiles.ts";
import { getSpecialtyRecordConfig } from "../src/lib/specialtyRecords.ts";
import { getServiceWorkflow } from "../src/lib/servicePlans.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { PlatformDatabase } from "./database.mjs";
import { normalizeAgent, normalizeContent } from "./domain.mjs";
import { normalizeAgentBuilder, BUILTIN_AGENT_TEMPLATES, instantiateTemplateDraft, instantiateAgentTemplate, copyAgentDraft, listAgentTemplates, saveAgentAsTemplate, updateAgentTemplate, getBuilderReadiness, saveBuilderQualification, saveBuilderEvaluation, saveBuilderReview, storeBuilderEvaluationRun, recordBuilderMutation, assertBuilderPublishable } from "./agent-builder.mjs";
import { createPlatformApp } from "./app.mjs";
const seed = { slug: "legacy-one", name: "旧健康助手", hospital: "机构甲", department: "专业科普", specialty: "健康资料解释", config: { model: "unit-model" } };
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-builder-test-"));
  return dir;
}
async function dbFixture(t) {
  const dir = await directory(t);
  const db = new PlatformDatabase({ dataDir: dir, seedDoctors: [seed] });
  t.after(async () => { await db.close(); if (path.dirname(dir) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith("agent-builder-test-")) await fs.rm(dir, { recursive: true, force: true }); });
  return db;
}
const instantiate = (db, slug = "builder-one") => instantiateAgentTemplate(db, "general-health", { slug, name: "新健康助手" }, "author");
test("builder schema preserves legacy and rejects unsafe shapes, duplicates, invalid limits", () => {
  assert.equal(normalizeAgentBuilder(undefined), undefined);
  const old = normalizeAgent(seed);
  assert.equal("builder" in old, false);
  assert.deepEqual(normalizeAgent(old), old);
  for (const bad of [
    null, { schemaVersion: 2 }, { schemaVersion: 1, secret: "x" },
    { schemaVersion: 1, components: [{ id: "__proto__", enabled: true, order: 0 }] },
    { schemaVersion: 1, components: [{ id: "chat", enabled: true, order: 0 }, { id: "chat", enabled: true, order: 1 }] },
    { schemaVersion: 1, components: [{ id: "home", enabled: false, order: 0 }] },
    { schemaVersion: 1, recordFields: [{ key: "constructor", label: "错误" }] },
    { schemaVersion: 1, recordFields: [{ key: "value", label: "值", min: 10, max: 1 }] },
    { schemaVersion: 1, recordFields: [{ key: "value", label: "值", step: 0 }] },
    { schemaVersion: 1, voice: { enabled: "true" } },
    { schemaVersion: 1, servicePlans: [{ id: "plan", title: "计划", steps: Array.from({ length: 17 }, (_, i) => ({ id: "step" + i, title: "步骤" })) }] },
  ]) assert.throws(() => normalizeAgentBuilder(bad));
  const managed = normalizeAgent({ ...seed, builder: { schemaVersion: 1, requiresReview: false } });
  assert.equal(managed.builder.requiresReview, true);
  assert.equal(normalizeAgent({ builder: { ...managed.builder, requiresReview: false } }, managed).builder.requiresReview, true);
  assert.throws(() => normalizeAgent({ builder: null }, managed), { code: "INVALID_BUILDER_CONFIG" });
});
test("four reusable neutral templates fill parameters and create only private drafts", async t => {
  const db = await dbFixture(t);
  assert.equal(BUILTIN_AGENT_TEMPLATES.length, 4);
  for (const [index, template] of BUILTIN_AGENT_TEMPLATES.entries()) {
    const draft = instantiateTemplateDraft(template, { slug: "template-" + index, name: "新专科助手", hospital: "已授权机构", department: "目标科室", specialty: "目标专业" });
    assert.ok(draft.config.systemPrompt.includes("目标专业"));
    assert.ok(!JSON.stringify(draft).includes("{{"));
    assert.equal(draft.builder.requiresReview, true);
    assert.equal(draft.portrait, undefined);
    const created = await instantiateAgentTemplate(db, template.id, { slug: "created-" + index, name: "新专科助手" }, "author");
    assert.equal(created.status, "draft");
    assert.equal(await db.getAgent(created.slug, true), null);
    assert.equal((await db.listEntities("documents", created.slug)).length, 0);
    assert.equal((await db.listEntities("sources", created.slug)).length, 0);
  }
  const old = await db.getAgent("legacy-one", true);
  assert.equal(old.name, seed.name);
  assert.equal(old.builder, undefined);
});
test("copy defaults to configuration isolation; explicitly authorized content receives new IDs and draft status", async t => {
  const db = await dbFixture(t);
  const body = normalizeContent({ agentSlug: seed.slug, title: "授权文章", body: "文章正文", status: "published" });
  await db.saveEntity("content", body);
  await db.saveEntity("documents", { id: "private-knowledge", agentSlug: seed.slug, approved: true, revision: 1 });
  await db.saveEntity("sources", { id: "private-source", agentSlug: seed.slug, path: "private", enabled: true });
  const copied = await copyAgentDraft(db, seed.slug, { slug: "copy-one", name: "复制助手" }, "author");
  assert.equal(copied.status, "draft");
  assert.equal(copied.builder.requiresReview, true);
  for (const table of ["content", "documents", "sources"]) assert.equal((await db.listEntities(table, copied.slug)).length, 0);
  await assert.rejects(copyAgentDraft(db, seed.slug, { slug: "copy-bad", name: "未授权", copyContent: true }, "author"), { code: "CONTENT_AUTHORIZATION_REQUIRED" });
  assert.equal(await db.getAgent("copy-bad"), null);
  const withContent = await copyAgentDraft(db, seed.slug, { slug: "copy-two", name: "授权副本", copyContent: true, contentAuthorized: true }, "author");
  const copies = await db.listEntities("content", withContent.slug);
  assert.equal(copies.length, 1);
  assert.notEqual(copies[0].id, body.id);
  assert.equal(copies[0].agentSlug, withContent.slug);
  assert.equal(copies[0].status, "draft");
  assert.equal(copies[0].publishedAt, null);
  assert.equal((await db.requireEntity("content", body.id)).status, "published");
  for (const table of ["documents", "sources"]) assert.equal((await db.listEntities(table, withContent.slug)).length, 0);
});
test("copy and template instantiation roll back all mutations on content/audit failure", async t => {
  const db = await dbFixture(t);
  await db.saveEntity("content", normalizeContent({ agentSlug: seed.slug, title: "文章", body: "正文" }));
  const original = db.saveEntity.bind(db);
  db.saveEntity = (table, record) => { if (record.agentSlug === "copy-fail") throw new Error("fixture content failure"); return original(table, record); };
  await assert.rejects(copyAgentDraft(db, seed.slug, { slug: "copy-fail", name: "失败副本", copyContent: true, contentAuthorized: true }, "author"), /fixture content failure/);
  assert.equal(await db.getAgent("copy-fail"), null);
  assert.equal(await db.getMeta("agent-builder.governance.copy-fail"), null);
  db.saveEntity = original;
  const audit = db.audit.bind(db);
  db.audit = (action, ...rest) => { if (action === "agent.template_instantiate") throw new Error("fixture audit failure"); return audit(action, ...rest); };
  await assert.rejects(instantiate(db, "create-fail"), /fixture audit failure/);
  assert.equal(await db.getAgent("create-fail"), null);
  assert.equal(await db.getMeta("agent-builder.governance.create-fail"), null);
});
test("saved template parameterizes identity, excludes content and supports custom CRUD only", async t => {
  const db = await dbFixture(t);
  const source = await db.requireAgent(seed.slug);
  await db.saveAgent(normalizeAgent({ intro: "旧健康助手在机构甲进行专业科普，方向健康资料解释。", config: { systemPrompt: "你是旧健康助手，来自机构甲，专业科普，健康资料解释。" }, builder: { schemaVersion: 1, recordFields: [{ key: "weight", label: "旧健康助手记录" }], servicePlans: [{ id: "visit", title: "机构甲就医准备", steps: [{ id: "prepare", title: "专业科普整理", description: "健康资料解释" }] }], assessments: [{ id: "reflection", title: "旧健康助手自评", questions: [{ id: "qone", text: "机构甲随访记录是否已备齐？", options: [{ label: "未备齐", value: 0 }, { label: "已备齐", value: 1 }] }] }] } }, source), "author");
  const custom = await saveAgentAsTemplate(db, { agentSlug: seed.slug, name: "复用模板", description: "模板说明" }, "author");
  assert.equal(custom.builtIn, false);
  assert.equal(custom.parameters.find(parameter => parameter.key === "name").defaultValue, "健康科普助手");
  assert.equal(custom.parameters.find(parameter => parameter.key === "hospital").defaultValue, "");
  assert.equal(custom.agentSnapshot.portrait, undefined);
  assert.deepEqual(custom.agentSnapshot.articles, []);
  const draft = instantiateTemplateDraft(custom, { slug: "custom-target", name: "乙助手", hospital: "机构乙", department: "目标科室", specialty: "目标方向" });
  assert.match(draft.config.systemPrompt, /乙助手.*机构乙.*目标科室.*目标方向/);
  assert.ok(!draft.config.systemPrompt.includes("旧健康助手"));
  assert.ok(!draft.config.systemPrompt.includes("机构甲"));
  assert.equal(draft.builder.recordFields[0].label, "乙助手记录");
  assert.equal(draft.builder.recordFields[0].key, "weight");
  assert.equal(draft.builder.servicePlans[0].title, "机构乙就医准备");
  assert.equal(draft.builder.servicePlans[0].steps[0].title, "目标科室整理");
  assert.equal(draft.builder.servicePlans[0].steps[0].description, "目标方向");
  assert.equal(draft.builder.assessments[0].title, "乙助手自评");
  assert.equal(draft.builder.assessments[0].questions[0].text, "机构乙随访记录是否已备齐？");
  assert.equal(draft.config.model, "unit-model");
  const updated = await updateAgentTemplate(db, custom.id, { name: "修改模板" }, "author");
  assert.equal(updated.version, 2);
  await assert.rejects(updateAgentTemplate(db, "general-health", { name: "错误" }, "author"), { code: "BUILTIN_TEMPLATE_IMMUTABLE" });
  await assert.rejects(updateAgentTemplate(db, custom.id, { agentSnapshot: {} }, "author"), { code: "INVALID_BUILDER_INPUT" });
  await updateAgentTemplate(db, custom.id, undefined, "author", true);
  assert.equal((await listAgentTemplates(db)).length, 4);
});
const runCases = () => Array.from({ length: 3 }, (_, index) => ({ id: "case-" + index, prompt: "问题" + index, expected: "可核验科普", answer: "服务端实际运行的回答" + index, model: "unit-model", ranAt: new Date().toISOString(), pass: null }));
async function qualified(db, slug) {
  return saveBuilderQualification(db, slug, { status: "verified", reference: "测试材料路径：qualifications/fixture.pdf", authorizationReference: "测试授权路径：authorizations/fixture.pdf" }, "verifier");
}
test("new builder gates require real answer records, qualification and an independent hash-bound review", async t => {
  const db = await dbFixture(t);
  await instantiate(db);
  assert.equal((await getBuilderReadiness(db, seed.slug)).ready, true);
  await assert.rejects(assertBuilderPublishable(db, "builder-one"), { code: "BUILDER_NOT_READY" });
  await assert.rejects(saveBuilderQualification(db, "builder-one", { status: "verified", reference: "材料" }, "verifier"), { code: "INVALID_INPUT" });
  const state = await qualified(db, "builder-one");
  await assert.rejects(saveBuilderEvaluation(db, "builder-one", { draftHash: state.draftHash, cases: runCases().map(({ id }) => ({ id, pass: true })) }, "author"), { code: "EVALUATION_RUN_REQUIRED" });
  await storeBuilderEvaluationRun(db, "builder-one", state.draftHash, runCases(), "author");
  const scores = runCases().map(({ id }) => ({ id, pass: true, note: "人工已对照答案" }));
  await saveBuilderEvaluation(db, "builder-one", { draftHash: state.draftHash, cases: scores }, "author");
  await assert.rejects(saveBuilderReview(db, "builder-one", { draftHash: state.draftHash, status: "approved", note: "" }, "author"), { code: "INDEPENDENT_REVIEW_REQUIRED" });
  const ready = await saveBuilderReview(db, "builder-one", { draftHash: state.draftHash, status: "approved", note: "独立复核通过" }, "reviewer");
  assert.equal(ready.ready, true);
  await assertBuilderPublishable(db, "builder-one");
  const existing = await db.requireAgent("builder-one");
  await db.saveAgent(normalizeAgent({ intro: "修改简介使审核失效" }, existing), "another-author");
  await recordBuilderMutation(db, "builder-one", "another-author");
  const changed = await getBuilderReadiness(db, "builder-one");
  assert.notEqual(changed.draftHash, state.draftHash);
  assert.equal(changed.ready, false);
  await assert.rejects(saveBuilderReview(db, "builder-one", { draftHash: state.draftHash, status: "approved" }, "reviewer"), { code: "STALE_DRAFT" });
});
test("draft hash binds own content and knowledge revisions but ignores another agent's data", async t => {
  const db = await dbFixture(t);
  await instantiate(db);
  const baseline = (await getBuilderReadiness(db, "builder-one")).draftHash;
  await db.saveEntity("content", normalizeContent({ agentSlug: seed.slug, title: "其他智能体内容", body: "不应改变hash" }));
  assert.equal((await getBuilderReadiness(db, "builder-one")).draftHash, baseline);
  await db.saveEntity("content", normalizeContent({ agentSlug: "builder-one", title: "本智能体内容", body: "草稿内容" }));
  const withContent = (await getBuilderReadiness(db, "builder-one")).draftHash;
  assert.notEqual(withContent, baseline);
  await db.saveEntity("documents", { id: "own-doc", agentSlug: "builder-one", revision: 1, approved: true, status: "ready", updatedAt: "2026-10-23T00:00:00Z" });
  const withKnowledge = (await getBuilderReadiness(db, "builder-one")).draftHash;
  assert.notEqual(withKnowledge, withContent);
  await db.patchEntity("documents", "own-doc", { revision: 2 });
  assert.notEqual((await getBuilderReadiness(db, "builder-one")).draftHash, withKnowledge);
});
async function httpFixture(t, { configured = true } = {}) {
  const dir = await directory(t);
  let calls = 0;
  const platform = await createPlatformApp({ dataDir: dir, seedDoctors: [seed], env: configured ? { AI_API_KEY: "synthetic-builder-test-key", AI_API_URL: "https://model.invalid/v1", AI_MODEL: "builder-test-model" } : {}, startWorker: false, disableRateLimits: true,
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: "这是一段仅供测试的健康科普回答；具体情况请咨询医生。" } }] }), { headers: { "Content-Type": "application/json" } }); } });
  const server = await new Promise(resolve => { const instance = platform.app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await platform.close(); if (path.dirname(dir) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith("agent-builder-test-")) await fs.rm(dir, { recursive: true, force: true }); });
  const base = "http://127.0.0.1:" + server.address().port;
  const request = async (method, url, body, cookie) => {
    const response = await fetch(base + url, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const login = await request("POST", "/api/auth/login", { username: "admin", password: "dev-admin-password" });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  return { ...platform, request, cookie, calls: () => calls, api: (method, url, body) => request(method, url, body, cookie) };
}
test("HTTP private full preview, template and mutation routes enforce viewer/editor/admin roles", async t => {
  const f = await httpFixture(t);
  assert.equal((await f.request("GET", "/api/admin/templates")).status, 401);
  const created = await f.api("POST", "/api/admin/templates/general-health/instantiate", { slug: "private-builder", name: "草稿助手" });
  assert.equal(created.status, 201);
  assert.equal((await f.request("GET", "/api/doctors/private-builder")).status, 404);
  assert.equal((await f.request("GET", "/api/admin/agents/private-builder/preview")).status, 401);
  const content = await f.database.saveEntity("content", normalizeContent({ agentSlug: "private-builder", title: "草稿全文", body: "未发布的实际正文" }));
  const preview = await f.api("GET", "/api/admin/agents/private-builder/preview");
  assert.equal(preview.status, 200);
  assert.equal(preview.data.preview, true);
  assert.equal(preview.data.contents.find(item => item.id === content.id).body, "未发布的实际正文");
  assert.equal(preview.data.agent.builder.schemaVersion, 1);
  assert.match(preview.data.draftHash, /^[a-f0-9]{64}$/);
  assert.equal(preview.headers.get("cache-control"), "no-store");
  for (const role of ["viewer", "editor"]) {
    const username = "builder-" + role;
    assert.equal((await f.api("POST", "/api/admin/users", { username, role, password: "synthetic-safe-password" })).status, 201);
    const login = await f.request("POST", "/api/auth/login", { username, password: "synthetic-safe-password" });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal((await f.request("GET", "/api/admin/agents/private-builder/preview", undefined, cookie)).status, 200);
    assert.equal((await f.request("POST", "/api/admin/agents/private-builder/qualification", { status: "verified", reference: "fixture", authorizationReference: "fixture" }, cookie)).status, 403);
    assert.equal((await f.request("POST", "/api/admin/agents/private-builder/review", { draftHash: preview.data.draftHash, status: "approved" }, cookie)).status, 403);
    if (role === "viewer") {
      assert.equal((await f.request("POST", "/api/admin/agents/private-builder/copy", { slug: "viewer-copy", name: "错误" }, cookie)).status, 403);
      assert.equal((await f.request("POST", "/api/admin/templates", { agentSlug: "private-builder", name: "错误" }, cookie)).status, 403);
      assert.equal((await f.request("POST", "/api/admin/agents/private-builder/evaluation/run", { draftHash: preview.data.draftHash, cases: [] }, cookie)).status, 403);
    }
  }
  assert.equal((await f.api("POST", "/api/admin/agents/private-builder/publish")).status, 409);
  assert.equal((await f.request("GET", "/api/doctors/private-builder")).status, 404);
});
test("HTTP evaluation runs actual server questions then accepts manual scores and independent review", async t => {
  const f = await httpFixture(t);
  await f.api("POST", "/api/admin/templates/general-health/instantiate", { slug: "evaluation-one", name: "评测助手" });
  await f.api("POST", "/api/admin/agents/evaluation-one/qualification", { status: "verified", reference: "测试资质", authorizationReference: "测试授权" });
  const readiness = await f.api("GET", "/api/admin/agents/evaluation-one/readiness");
  const cases = Array.from({ length: 3 }, (_, i) => ({ id: "case-" + i, prompt: ["如何准备复诊资料？", "日常记录应该包含什么？", "如何辨别健康信息？"][i], expected: "提供有限的健康科普并提示就医边界" }));
  assert.equal((await f.api("POST", "/api/admin/agents/evaluation-one/evaluation", { draftHash: readiness.data.draftHash, cases: cases.map(item => ({ id: item.id, pass: true })) })).status, 409);
  const run = await f.api("POST", "/api/admin/agents/evaluation-one/evaluation/run", { draftHash: readiness.data.draftHash, cases });
  assert.equal(run.status, 200, JSON.stringify(run.data));
  assert.equal(f.calls(), 3);
  assert.ok(run.data.evaluation.cases.every(item => item.answer && item.ranAt && item.pass === null));
  const score = await f.api("POST", "/api/admin/agents/evaluation-one/evaluation", { draftHash: readiness.data.draftHash, cases: cases.map(item => ({ id: item.id, pass: true, note: "人工对照已通过" })) });
  assert.equal(score.status, 200);
  const selfReview = await f.api("POST", "/api/admin/agents/evaluation-one/review", { draftHash: readiness.data.draftHash, status: "approved" });
  assert.equal(selfReview.data.code, "INDEPENDENT_REVIEW_REQUIRED");
  await f.api("POST", "/api/admin/users", { username: "independent-admin", role: "admin", password: "synthetic-safe-password" });
  const reviewer = await f.request("POST", "/api/auth/login", { username: "independent-admin", password: "synthetic-safe-password" });
  const reviewed = await f.request("POST", "/api/admin/agents/evaluation-one/review", { draftHash: readiness.data.draftHash, status: "approved", note: "独立复核" }, reviewer.headers.get("set-cookie").split(";")[0]);
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.data.ready, true);
  assert.equal((await f.api("POST", "/api/admin/agents/evaluation-one/publish")).status, 200);
  assert.equal((await f.request("GET", "/api/doctors/evaluation-one")).status, 200);
});
test("HTTP missing model configuration never fabricates successful evaluation", async t => {
  const f = await httpFixture(t, { configured: false });
  await f.api("POST", "/api/admin/templates/general-health/instantiate", { slug: "unconfigured-one", name: "无模型助手" });
  const readiness = await f.api("GET", "/api/admin/agents/unconfigured-one/readiness");
  const run = await f.api("POST", "/api/admin/agents/unconfigured-one/evaluation/run", { draftHash: readiness.data.draftHash, cases: Array.from({ length: 3 }, (_, i) => ({ id: "case-" + i, prompt: "一般健康问题" + i, expected: "科普" })) });
  assert.equal(run.status, 503);
  assert.equal(run.data.code, "AI_NOT_CONFIGURED");
  assert.equal(f.calls(), 0);
  const after = await f.api("GET", "/api/admin/agents/unconfigured-one/readiness");
  assert.equal(after.data.evaluation.cases.length, 0);
  assert.equal(after.data.ready, false);
});

test("rollback to a legacy snapshot retains managed review requirement and records the restoring author", async t => {
  const db = await dbFixture(t);
  const old = await db.requireAgent(seed.slug);
  await db.saveAgent(normalizeAgent({ builder: { schemaVersion: 1 } }, old), "first-editor");
  await recordBuilderMutation(db, seed.slug, "first-editor");
  await db.rollbackAgent(seed.slug, 1, "restoring-editor");
  await recordBuilderMutation(db, seed.slug, "restoring-editor");
  const state = await getBuilderReadiness(db, seed.slug);
  assert.equal(state.required, true);
  assert.equal(state.lastModifiedBy, "restoring-editor");
  await assert.rejects(saveBuilderReview(db, seed.slug, { draftHash: state.draftHash, status: "approved" }, "restoring-editor"), { code: "INDEPENDENT_REVIEW_REQUIRED" });
});

test("legacy copies preserve nine specialty fields, original service worksheets, Tang voice and Yu wellness", async t => {
  const db = await dbFixture(t);
  const slugs = ["fu-junfen", "chen-zhiling", "gong-wenbo", "chen-jinbiao", "wu-yuqin", "lin-jinfang", "luo-jun", "yu-weihua", "zhou-yong"];
  for (const sourceSlug of [...slugs, "tang-jinsong", "yu-wen"]) {
    const definition = doctorProfiles.find(profile => profile.slug === sourceSlug);
    const source = await db.createAgent(normalizeAgent(definition), "fixture", true);
    const copied = await copyAgentDraft(db, sourceSlug, { slug: "copy-" + sourceSlug, name: "新授权科普助手" }, "author");
    assert.equal(copied.status, "draft");
    assert.equal(copied.builder.requiresReview, true);
    assert.equal(copied.config.maxTokens, source.config.maxTokens);
    assert.deepEqual(copied.services, source.services);
    assert.deepEqual(copied.builder.servicePlans.map(plan => plan.title), source.services);
    for (const plan of copied.builder.servicePlans) assert.deepEqual(plan.steps.map(step => step.title), getServiceWorkflow(sourceSlug, plan.title).steps);
    if (slugs.includes(sourceSlug)) assert.deepEqual(copied.builder.recordFields, getSpecialtyRecordConfig(sourceSlug).fields.map(({ key, label, unit, min, max, step }) => ({ key, label, unit, min, max, step })));
    if (sourceSlug === "tang-jinsong") {
      assert.equal(copied.builder.voice.enabled, true);
      assert.ok(copied.builder.components.some(item => item.id === "voice" && item.enabled));
      assert.deepEqual(copied.builder.recordFields.map(field => field.key), ["sleepDurationMinutes", "sleepLatencyMinutes", "nightAwakenings", "moodScore", "anxietyScore", "energyScore", "daytimeImpactScore"]);
    }
    if (sourceSlug === "yu-wen") {
      assert.ok(copied.builder.components.some(item => item.id === "wellness" && item.enabled));
      assert.ok(copied.builder.components.some(item => item.id === "assessments" && item.enabled));
      assert.deepEqual(copied.builder.assessments.map(scale => scale.id), ["gad7", "phq2"]);
      assert.equal(copied.builder.assessments[0].questions.length, 7);
      assert.equal(copied.builder.assessments[1].questions.length, 2);
      assert.equal(copied.builder.assessments[0].questions.reduce((total, question) => total + Math.max(...question.options.map(option => option.value)), 0), 21);
    }
    for (const table of ["content", "documents", "sources"]) assert.equal((await db.listEntities(table, copied.slug)).length, 0);
    assert.equal((await db.getAgent(sourceSlug, true)).builder, undefined);
  }
  const saved = await saveAgentAsTemplate(db, { agentSlug: "fu-junfen", name: "儿童记录复用" }, "author");
  const fromTemplate = instantiateTemplateDraft(saved, { slug: "new-specialty", name: "新专科助手", hospital: "", department: "儿童科普", specialty: "血糖与生长记录" });
  assert.deepEqual(fromTemplate.builder.recordFields.map(field => field.key), ["fastingGlucose", "postMealGlucose", "heightCm", "weightKg"]);
  assert.equal(fromTemplate.builder.servicePlans.length, 4);
});
test("service names must be unique even when plan IDs differ", () => {
  assert.throws(() => normalizeAgentBuilder({ schemaVersion: 1, servicePlans: [
    { id: "plan-one", title: "同名服务", steps: [{ id: "one", title: "第一步骤" }] },
    { id: "plan-two", title: "同名服务", steps: [{ id: "two", title: "另一不同步骤" }] },
  ] }), /服务名称标识不能重复/);
});

test("private preview and evaluation capture one transactional snapshot and release it before provider calls", async t => {
  const db = await dbFixture(t);
  await instantiate(db, "snapshot-one");
  await db.saveEntity("content", normalizeContent({ agentSlug: "snapshot-one", title: "实际草稿", body: "同一事务内捕获的正文" }));
  let transactionId = 0;
  let activeTransaction = 0;
  let providerCalls = 0;
  const reads = [];
  const database = new Proxy(db, {
    get(target, property) {
      if (property === "transaction") return callback => target.transaction(async () => {
        const previous = activeTransaction;
        activeTransaction = ++transactionId;
        try { return await callback(); } finally { activeTransaction = previous; }
      });
      if (["requireAgent", "getMeta", "listEntities"].includes(property)) return (...args) => {
        assert.ok(activeTransaction > 0, String(property) + " escaped its snapshot transaction");
        reads.push({ operation: property, transaction: activeTransaction, args });
        return target[property](...args);
      };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const handlers = new Map();
  const app = Object.fromEntries(["get", "post", "put", "delete"].map(method => [method, (url, ...middleware) => handlers.set(method + " " + url, middleware.at(-1))]));
  const allow = (_req, _res, next) => next();
  const knowledge = {
    publicAgent: value => structuredClone(value), publicContent: value => structuredClone(value),
    search: async () => { assert.equal(activeTransaction, 0, "retrieval must not hold the snapshot transaction"); return { mode: "none", citations: [] }; },
  };
  registerAgentBuilderRoutes(app, { database, knowledge, viewer: allow, editor: allow, admin: allow,
    env: { AI_API_KEY: "synthetic-builder-test-key", AI_API_URL: "https://model.invalid/v1", AI_MODEL: "snapshot-test-model" },
    fetchImpl: async () => {
      assert.equal(activeTransaction, 0, "external model requests must not hold a database transaction");
      providerCalls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: "测试科普回答，不替代医生面诊。" } }] }), { headers: { "Content-Type": "application/json" } });
    },
  });
  const invoke = async (key, body) => {
    const result = { status: 200, headers: {}, data: null };
    const response = { status(value) { result.status = value; return this; }, setHeader(name, value) { result.headers[name] = value; }, json(value) { result.data = value; return this; } };
    await handlers.get(key)({ params: { slug: "snapshot-one" }, user: { username: "author" }, body }, response, error => { throw error; });
    return result;
  };
  const preview = await invoke("get /api/admin/agents/:slug/preview");
  assert.equal(preview.data.agent.slug, "snapshot-one");
  assert.equal(preview.data.contents[0].body, "同一事务内捕获的正文");
  assert.equal(preview.headers["Cache-Control"], "no-store");
  assert.equal(new Set(reads.map(read => read.transaction)).size, 1, "agent, hash, knowledge and contents must share one read snapshot");
  assert.ok(reads.some(read => read.operation === "listEntities" && read.args[0] === "documents"));
  const beforeEvaluation = transactionId;
  reads.length = 0;
  const evaluation = await invoke("post /api/admin/agents/:slug/evaluation/run", {
    draftHash: preview.data.draftHash,
    cases: Array.from({ length: 3 }, (_, index) => ({ id: "question-" + index, prompt: "合成一般健康问题" + index, expected: "有限科普回答" })),
  });
  assert.equal(evaluation.status, 200);
  assert.equal(providerCalls, 3);
  assert.equal(transactionId - beforeEvaluation, 2, "capture first, run without a lock, then recheck the hash and save");
  assert.equal(new Set(reads.filter(read => read.operation === "requireAgent").map(read => read.transaction)).size, 2);
  assert.ok(evaluation.data.evaluation.cases.every(item => item.answer && item.pass === null));
});

test("optional layout, typed grouped records and data permissions preserve legacy JSON defaults", () => {
  const legacy = normalizeAgentBuilder({ schemaVersion: 1, recordFields: [{ key: "weight", label: "体重", unit: "kg" }] });
  assert.equal("layout" in legacy, false);
  assert.equal("dataPermissions" in legacy, false);
  assert.deepEqual(legacy.recordFields, [{ key: "weight", label: "体重", unit: "kg" }]);
  const current = normalizeAgentBuilder({ schemaVersion: 1, layout: { density: "compact", cards: "list" }, dataPermissions: { records: "read-only" }, recordFields: [
    { key: "temperature", label: "体温", type: "number", group: "生理记录", min: 30, max: 45, step: 0.1 },
    { key: "note", label: "观察描述", type: "text", group: "主观感受" },
    { key: "feeling", label: "今日感受", type: "select", group: "主观感受", options: ["一般", "较好"] },
  ] });
  assert.deepEqual(current.layout, { density: "compact", cards: "list" });
  assert.deepEqual(current.dataPermissions, { records: "read-only", assessments: "read-write", services: "read-write" });
  assert.equal(current.recordFields[1].group, "主观感受");
  for (const extension of [
    { layout: { density: "arbitrary", cards: "grid" } }, { layout: { density: "compact", cards: "list", html: "<script>" } },
    { dataPermissions: { records: "admin" } }, { dataPermissions: { otherUser: "read-write" } },
    { recordFields: [{ key: "note", label: "备注", type: "text", min: 0 }] },
    { recordFields: [{ key: "note", label: "备注", type: "text", options: ["A", "B"] }] },
    { recordFields: [{ key: "choice", label: "单选", type: "select", options: ["A", "A"] }] },
    { recordFields: [{ key: "choice", label: "单选", type: "select", options: ["仅一项"] }] },
  ]) assert.throws(() => normalizeAgentBuilder({ schemaVersion: 1, ...extension }));
});
test("assessment sources, versions and inclusive result bands are bounded and nonoverlapping", () => {
  const scale = { id: "reflection", title: "非诊断记录", source: "本地原创自我记录题目", version: "1.0", questions: [{ id: "qone", text: "今日感受如何？", options: [{ label: "较低", value: 0 }, { label: "一般", value: 1 }, { label: "较好", value: 2 }] }], resultBands: [{ min: 0, max: 0, label: "记录一", description: "仅作个人记录" }, { min: 1, max: 2, label: "记录二" }] };
  const normalized = normalizeAgentBuilder({ schemaVersion: 1, assessments: [scale] }).assessments[0];
  assert.equal(normalized.source, scale.source);
  assert.equal(normalized.version, "1.0");
  assert.equal(normalized.resultBands.length, 2);
  for (const invalid of [
    [{ min: 0, max: 1, label: "一" }, { min: 1, max: 2, label: "边界重叠" }],
    [{ min: -1, max: 2, label: "超出可能总分" }],
    [{ min: 2, max: 3, label: "超出可能总分" }],
    [{ min: 2, max: 1, label: "反向区间" }],
    [{ min: 0, max: Infinity, label: "无限范围" }],
    [{ max: 2, label: "缺失下界" }],
  ]) assert.throws(() => normalizeAgentBuilder({ schemaVersion: 1, assessments: [{ ...scale, resultBands: invalid }] }));
  assert.throws(() => normalizeAgentBuilder({ schemaVersion: 1, assessments: [{ ...scale, source: "bad\u0000source" }] }));
});
test("declarative service conditions and required fields reject cycles and unsafe expressions", () => {
  const plan = { id: "preparation", title: "资料准备", completionRule: "all-required", steps: [
    { id: "collect", title: "整理已有材料", required: true, fields: [{ key: "source", label: "材料说明", type: "text", required: true }, { key: "count", label: "份数", type: "number", required: false }] },
    { id: "reflect", title: "补充感受", required: false, dependsOn: ["collect"] },
  ] };
  const normalized = normalizeAgentBuilder({ schemaVersion: 1, servicePlans: [plan] }).servicePlans[0];
  assert.equal(normalized.completionRule, "all-required");
  assert.equal(normalized.steps[0].fields[0].required, true);
  assert.deepEqual(normalized.steps[1].dependsOn, ["collect"]);
  for (const invalid of [
    { ...plan, completionRule: "eval-user-javascript" },
    { ...plan, steps: [{ id: "a", title: "A", dependsOn: ["missing"] }] },
    { ...plan, steps: [{ id: "a", title: "A", dependsOn: ["a"] }] },
    { ...plan, steps: [{ id: "a", title: "A", dependsOn: ["b"] }, { id: "b", title: "B", dependsOn: ["a"] }] },
    { ...plan, steps: [{ id: "a", title: "A", required: false }] },
    { ...plan, steps: [{ id: "a", title: "重复标题" }, { id: "b", title: "重复标题" }] },
    { ...plan, steps: [{ id: "a", title: "A", fields: [{ key: "constructor", label: "危险", type: "text", required: false }] }] },
    { ...plan, steps: [{ id: "a", title: "A", condition: "window.location" }] },
  ]) assert.throws(() => normalizeAgentBuilder({ schemaVersion: 1, servicePlans: [invalid] }));
});
test("template question banks cover four categories and can be updated without erasing metadata", async t => {
  const db = await dbFixture(t);
  for (const template of await listAgentTemplates(db)) {
    assert.equal(template.evaluationCases.length, 4);
    assert.deepEqual(new Set(template.evaluationCases.map(item => item.category)), new Set(["education", "boundary", "knowledge", "abnormal"]));
  }
  const custom = await saveAgentAsTemplate(db, { agentSlug: seed.slug, name: "题库模板", description: "必须保留的说明", category: "原分类" }, "author");
  assert.equal(custom.evaluationCases.length, 4);
  const questions = custom.evaluationCases.map(item => ({ ...item, expected: item.expected + " 人工核验。" }));
  const changed = await updateAgentTemplate(db, custom.id, { evaluationCases: questions }, "author");
  assert.equal(changed.name, custom.name);
  assert.equal(changed.description, custom.description);
  assert.equal(changed.category, custom.category);
  assert.deepEqual(changed.agentSnapshot, custom.agentSnapshot);
  assert.equal(changed.version, custom.version + 1);
  assert.deepEqual(changed.evaluationCases, questions);
  await assert.rejects(updateAgentTemplate(db, custom.id, { evaluationCases: [{ id: "bad", prompt: "测试问题", expected: "预期", category: "arbitrary" }] }, "author"), { code: "INVALID_TEMPLATE_EVALUATION_CASES" });
  await assert.rejects(updateAgentTemplate(db, custom.id, { evaluationCases: [{ id: "same", prompt: "问题1", expected: "预期", category: "education" }, { id: "same", prompt: "问题2", expected: "预期", category: "boundary" }] }, "author"), { code: "INVALID_TEMPLATE_EVALUATION_CASES" });
  const stored = (await listAgentTemplates(db)).find(item => item.id === custom.id);
  assert.deepEqual(stored.evaluationCases, questions, "invalid replacement must leave the previous bank intact");
});
test("qualification attachment descriptors bind the draft hash and expired documents block readiness", async t => {
  const db = await dbFixture(t);
  await instantiate(db, "expiry-one");
  const before = await getBuilderReadiness(db, "expiry-one");
  const descriptor = { id: "6ad66ca1-3efc-4ab0-8f7b-3c9cc21ec111", kind: "qualification", name: "fixture.pdf", mime: "application/pdf", size: 20, sha256: "a".repeat(64), expiresAt: "2000-01-01", createdAt: "2026-10-23T00:00:00.000Z" };
  await db.setMeta("builder.qualification-files.expiry-one", JSON.stringify([descriptor]));
  const after = await getBuilderReadiness(db, "expiry-one");
  assert.notEqual(after.draftHash, before.draftHash);
  assert.equal(after.qualificationFiles.length, 1);
  assert.ok(after.issues.some(issue => issue.includes("附件已到期")));
  await assert.rejects(assertBuilderPublishable(db, "expiry-one"), { code: "BUILDER_NOT_READY" });
});

async function seedReviewUsers(db) {
  const timestamp = new Date().toISOString();
  for (const [username, role, active] of [["author", "admin", true], ["reviewer-a", "admin", true], ["reviewer-b", "admin", true], ["disabled-reviewer", "admin", false], ["editor-only", "editor", true]]) {
    await db.insertUser({ id: "fixture-" + username, username, name: "测试 " + username, role, active, passwordHash: "fixture-non-login-hash", createdAt: timestamp, updatedAt: timestamp });
  }
}
test("reviewer directory exposes only active independent administrator names", async t => {
  const db = await dbFixture(t);
  await seedReviewUsers(db);
  const reviewers = await listBuilderReviewers(db, "author");
  assert.deepEqual(reviewers.map(user => user.username), ["reviewer-a", "reviewer-b"]);
  assert.ok(reviewers.every(user => JSON.stringify(Object.keys(user).sort()) === JSON.stringify(["name", "username"])));
});
test("formal review submission validates the current version and administrator assignment atomically", async t => {
  const db = await dbFixture(t);
  await seedReviewUsers(db);
  await instantiate(db, "assigned-one");
  const readiness = await getBuilderReadiness(db, "assigned-one");
  for (const reviewer of ["missing-reviewer", "disabled-reviewer", "editor-only"]) await assert.rejects(submitBuilderReview(db, "assigned-one", { draftHash: readiness.draftHash, reviewer }, "submitter"), { code: "INVALID_REVIEWER" });
  await assert.rejects(submitBuilderReview(db, "assigned-one", { draftHash: "0".repeat(64), reviewer: "reviewer-a" }, "submitter"), { code: "STALE_DRAFT" });
  await assert.rejects(submitBuilderReview(db, "assigned-one", { draftHash: readiness.draftHash, reviewer: "author" }, "submitter"), { code: "INDEPENDENT_REVIEW_REQUIRED" });
  await assert.rejects(submitBuilderReview(db, "assigned-one", { draftHash: readiness.draftHash, reviewer: "reviewer-a" }, "reviewer-a"), { code: "INDEPENDENT_REVIEW_REQUIRED" });
  assert.equal((await getBuilderReadiness(db, "assigned-one")).review.status, "pending");
  const submitted = await submitBuilderReview(db, "assigned-one", { draftHash: readiness.draftHash, reviewer: "reviewer-a" }, "submitter");
  assert.equal(submitted.review.status, "submitted");
  assert.equal(submitted.review.assignedTo, "reviewer-a");
  assert.equal(submitted.review.submittedBy, "submitter");
  assert.match(submitted.review.submittedAt, /^\d{4}-/);
  assert.equal(submitted.ready, false, "submission itself must not bypass qualification and evaluation");
  await assert.rejects(saveBuilderReview(db, "assigned-one", { draftHash: readiness.draftHash, status: "changes_requested", note: "修改意见" }, "reviewer-b"), { code: "REVIEWER_NOT_ASSIGNED" });
});
test("assigned review survives test reruns and requires resubmission after draft changes", async t => {
  const db = await dbFixture(t);
  await seedReviewUsers(db);
  await instantiate(db, "assigned-hash");
  const state = await qualified(db, "assigned-hash");
  await submitBuilderReview(db, "assigned-hash", { draftHash: state.draftHash, reviewer: "reviewer-a" }, "submitter");
  const rerun = await storeBuilderEvaluationRun(db, "assigned-hash", state.draftHash, runCases(), "author");
  assert.equal(rerun.review.assignedTo, "reviewer-a", "running tests must never erase the appointed reviewer");
  const scored = await saveBuilderEvaluation(db, "assigned-hash", { draftHash: state.draftHash, cases: runCases().map(item => ({ id: item.id, pass: true, note: "人工确认" })) }, "author");
  assert.equal(scored.review.status, "submitted");
  await assert.rejects(saveBuilderReview(db, "assigned-hash", { draftHash: state.draftHash, status: "approved" }, "reviewer-b"), { code: "REVIEWER_NOT_ASSIGNED" });
  const approved = await saveBuilderReview(db, "assigned-hash", { draftHash: state.draftHash, status: "approved", note: "审核通过" }, "reviewer-a");
  assert.equal(approved.ready, true);
  assert.equal(approved.review.assignedTo, "reviewer-a");
  const existing = await db.requireAgent("assigned-hash");
  await db.saveAgent(normalizeAgent({ intro: "实际修改" }, existing), "author");
  await recordBuilderMutation(db, "assigned-hash", "author");
  const changed = await getBuilderReadiness(db, "assigned-hash");
  assert.notEqual(changed.draftHash, state.draftHash);
  await assert.rejects(saveBuilderReview(db, "assigned-hash", { draftHash: changed.draftHash, status: "approved" }, "reviewer-a"), { code: "REVIEW_RESUBMISSION_REQUIRED" });
  const submittedAgain = await submitBuilderReview(db, "assigned-hash", { draftHash: changed.draftHash, reviewer: "reviewer-b" }, "submitter");
  assert.equal(submittedAgain.review.assignedTo, "reviewer-b");
  assert.equal(submittedAgain.review.draftHash, changed.draftHash);
  assert.equal(submittedAgain.ready, false, "a changed draft still needs fresh tests");
});
