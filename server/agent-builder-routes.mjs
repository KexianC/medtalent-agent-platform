import { getPendingReleaseSnapshot, searchPendingRelease } from "./builder-lifecycle-release.mjs";
import { BUILTIN_AGENT_TEMPLATES, listAgentTemplates, saveAgentAsTemplate, updateAgentTemplate, instantiateAgentTemplate, copyAgentDraft, getBuilderReadiness, saveBuilderQualification, saveBuilderReview, saveBuilderEvaluation, storeBuilderEvaluationRun, normalizeEvaluationRun, listBuilderReviewers, submitBuilderReview } from "./agent-builder.mjs";
import { PlatformError, now, validateSlug } from "./domain.mjs";
import { generateChatReply, detectChatCrisis, classifyTangQuestion } from "./chat-core.mjs";
import { buildKnowledgeContext } from "./rag.mjs";
import { safeOutputText, credentialValues } from "./output-safety.mjs";
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const actor = req => req.user?.username || "system";

export function registerAgentBuilderRoutes(app, { database, knowledge, viewer, editor, admin, env = {}, fetchImpl = fetch, limit, clonePortrait }) {
  const secrets = credentialValues(env);
  const safe = value => typeof value === "string" ? safeOutputText(value, secrets, 120000) : Array.isArray(value) ? value.map(safe) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, safe(nested)])) : value;
  const publicTemplate = template => safe({ ...template, agentSnapshot: knowledge.publicAgent(template.agentSnapshot) });
  const limited = limit ? limit("builder-evaluation", 6, 60000) : (_req, _res, next) => next();
  app.get("/api/admin/reviewers", viewer, asyncRoute(async (req, res) => res.json({ reviewers: safe(await listBuilderReviewers(database, actor(req))) })));
  app.post("/api/admin/agents/:slug/review/submit", editor, asyncRoute(async (req, res) => res.json(safe(await submitBuilderReview(database, req.params.slug, req.body, actor(req))))));
  app.get("/api/admin/templates", viewer, asyncRoute(async (_req, res) => res.json({ templates: (await listAgentTemplates(database)).map(publicTemplate) })));
  app.post("/api/admin/templates", editor, asyncRoute(async (req, res) => res.status(201).json(publicTemplate(await saveAgentAsTemplate(database, req.body, actor(req))))));
  app.put("/api/admin/templates/:id", editor, asyncRoute(async (req, res) => res.json(publicTemplate(await updateAgentTemplate(database, req.params.id, req.body, actor(req))))));
  app.delete("/api/admin/templates/:id", editor, asyncRoute(async (req, res) => {
    await updateAgentTemplate(database, req.params.id, undefined, actor(req), true);
    res.json({ ok: true });
  }));
  app.post("/api/admin/templates/:id/instantiate", editor, asyncRoute(async (req, res) => res.status(201).json(knowledge.publicAgent(await instantiateAgentTemplate(database, req.params.id, req.body, actor(req))))));
  app.post("/api/admin/agents/:slug/copy", editor, asyncRoute(async (req, res) => res.status(201).json(knowledge.publicAgent(await copyAgentDraft(database, req.params.slug, req.body, actor(req), { clonePortrait })))));
  app.get("/api/admin/agents/:slug/preview", viewer, asyncRoute(async (req, res) => {
    const snapshot = await database.transaction(async () => {
      const stored = await database.requireAgent(validateSlug(req.params.slug));
      const readiness = await getBuilderReadiness(database, stored.slug);
      const agent = knowledge.publicAgent(stored);
      const pendingRelease = await getPendingReleaseSnapshot(database, stored.slug);
      const contents = (pendingRelease ? pendingRelease.contents : await database.listEntities("content", stored.slug)).map(content => knowledge.publicContent(content));
      return { preview: true, draftHash: readiness.draftHash, agent: { ...agent, welcomeMessage: agent.config?.welcomeMessage || "", healthContextEnabled: agent.config?.healthContextEnabled !== false && agent.builder?.healthContext !== false }, contents };
    });
    res.setHeader("Cache-Control", "no-store");
    res.json(snapshot);
  }));
  app.get("/api/admin/agents/:slug/readiness", viewer, asyncRoute(async (req, res) => res.json(safe(await getBuilderReadiness(database, req.params.slug)))));
  app.post("/api/admin/agents/:slug/qualification", admin, asyncRoute(async (req, res) => res.json(safe(await saveBuilderQualification(database, req.params.slug, req.body, actor(req))))));
  app.post("/api/admin/agents/:slug/review", admin, asyncRoute(async (req, res) => res.json(safe(await saveBuilderReview(database, req.params.slug, req.body, actor(req))))));
  app.post("/api/admin/agents/:slug/evaluation", editor, asyncRoute(async (req, res) => res.json(safe(await saveBuilderEvaluation(database, req.params.slug, req.body, actor(req))))));
  app.post("/api/admin/agents/:slug/evaluation/run", editor, limited, asyncRoute(async (req, res) => {
    const input = normalizeEvaluationRun(req.body);
    const { initial, doctor, pendingRelease } = await database.transaction(async () => ({
      initial: await getBuilderReadiness(database, req.params.slug),
      doctor: knowledge.publicAgent(await database.requireAgent(req.params.slug)),
      pendingRelease: await getPendingReleaseSnapshot(database, req.params.slug),
    }));
    if (initial.draftHash !== input.draftHash) throw new PlatformError("草稿已变化，请刷新后运行。", 409, "STALE_DRAFT");
    const cases = [];
    for (const item of input.cases) {
      const crisis = detectChatCrisis({ doctor, message: item.prompt });
      const scopeGuidance = doctor.slug === "tang-jinsong" && classifyTangQuestion(item.prompt) !== "related";
      const retrieval = crisis || scopeGuidance ? { mode: "none", citations: [] } : await searchPendingRelease(database, doctor.slug, item.prompt, { knowledge, env, fetchImpl, pendingSnapshot: pendingRelease, agent: doctor }) || await knowledge.search(doctor.slug, item.prompt, { published: false });
      const context = retrieval.citations.length ? buildKnowledgeContext(retrieval.citations, { requireCitations: doctor.config?.requireCitations !== false }) : "未检索到已审核的相关知识，不得编造来源；一般知识回答须说明局限。";
      const result = await generateChatReply({ doctor, message: item.prompt, knowledgeContext: context, env, fetchImpl });
      cases.push({ ...item, answer: result.reply, model: result.model, ranAt: now(), pass: null, note: "", retrievalMode: retrieval.mode });
    }
    res.json(safe(await storeBuilderEvaluationRun(database, doctor.slug, input.draftHash, cases, actor(req))));
  }));
  return { templateCount: BUILTIN_AGENT_TEMPLATES.length };
}
