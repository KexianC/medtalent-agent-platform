import {registerKnowledgeRecoveryRoutes} from './knowledge-recovery.mjs';
import express from "express";
import { registerQualificationFileRoutes } from "./builder-qualification-files.mjs";
import { registerAgentBuilderRoutes } from "./agent-builder-routes.mjs";
import { assertBuilderPublishable, recordBuilderMutation, getBuilderReadiness } from "./agent-builder.mjs";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { doctorProfiles } from "../src/data/doctorProfiles.ts";
import { PlatformDatabase } from "./database.mjs";
import { MySQLPlatformDatabase } from "./mysql-database.mjs";
import { createAuth, sameOriginWrites } from "./auth.mjs";
import { KnowledgeService } from "./knowledge-service.mjs";
import { buildKnowledgeContext, KnowledgeError } from "./rag.mjs";
import { getNasCapabilities, NasError } from "./nas.mjs";
import { generateAgentDrafts, generateContentDraft, optimizeAgentPrompt, modelSettings } from "./ai-studio.mjs";
import { assertSourceScopeAvailable, normalizeAgent, normalizeContent, normalizeDocumentApproval, normalizeDocumentBatchReview, normalizeDocumentDeletion, normalizeDocumentReindex, normalizeSource, PlatformError, MAX_FILE_BYTES, now, textField, validateSlug } from "./domain.mjs";
import { ChatServiceError, generateChatReply, generateChatReplyStream, detectChatCrisis, classifyTangQuestion } from "./chat-core.mjs";
import { registerSpeechRoutes } from "./speech-routes.mjs";
import { validateRuntimeConfig } from "./runtime-config.mjs";
import { acquirePlatformInstanceLeaseSync } from "./file-lease.mjs";
import { credentialValues, safeOutputCode, safeOutputText } from "./output-safety.mjs";
import { registerWechatBridgeRoutes } from "./wechat-bridge.mjs";

import {PlatformAccess,scopedDatabase,registerAccessRoutes} from './platform-access.mjs';
import {ProviderRegistry,registerProviderRoutes} from './provider-registry.mjs';
import {PlatformAssets,registerAssetRoutes} from './platform-assets.mjs';
import {PlatformObservability,registerObservabilityRoutes} from './platform-observability.mjs';
import {KnowledgeGovernanceService} from './knowledge-governance.mjs';
import {registerKnowledgeGovernanceRoutes} from './knowledge-governance-routes.mjs';
import {registerBuilderLifecycleRoutes} from './builder-lifecycle-routes.mjs';
import {withAgentDraftHash,saveAgentWithCAS,assertExpectedDraftHash} from './builder-lifecycle.mjs';
import {publishAgentRelease,searchPendingRelease,getPendingReleaseSnapshot} from './builder-lifecycle-release.mjs';
import {registerConsumerReportRoutes} from './consumer-reports.mjs';
import {registerPlatformBusinessRoutes} from './platform-business.mjs';
import {createDistributedRuntime,registerDistributedRoutes,createDistributedDispatchHandler,createSqlQueueBroker,createOptionalDistributedLimiter} from './distributed-runtime.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const INSTANCE_LEASE_ERROR_CODES = new Set(["LEASE_COMPROMISED", "LEASE_RELEASED", "PLATFORM_INSTANCE_LOCK_LOST", "PLATFORM_DATA_CLOSED"]);
const isInstanceLeaseError = (error) => INSTANCE_LEASE_ERROR_CODES.has(error?.code);
const instanceLeaseError = () => new PlatformError("平台实例租约已失效，当前实例已停止服务。", 503, "PLATFORM_INSTANCE_LEASE_LOST");
const actor = (req) => req.user?.username || "system";
const agentFilter = (req) => req.query.agentSlug === undefined || req.query.agentSlug === "" ? undefined : validateSlug(req.query.agentSlug);
const publicCitationTitles = (citations) => {
  if (!Array.isArray(citations)) return [];
  const seen = new Set();
  return citations.flatMap((citation) => {
    const title = typeof citation?.title === "string" && citation.title.trim() ? citation.title.trim() : "未命名文档";
    if (seen.has(title)) return [];
    seen.add(title);
    return [{ title, ...(typeof citation.shareUrl === "string" && /^\/api\/citations\/[a-z0-9-]+\/[A-Za-z0-9_-]+\/\d+$/.test(citation.shareUrl) ? {shareUrl:citation.shareUrl} : {}) }];
  });
};

function createLimiter({ disabled = false } = {}) {
  const buckets = new Map();
  return (name, limit = 30, windowMs = 60000) => (req, _res, next) => {
    if (disabled) return next();
    const timestamp = Date.now();
    const key = `${name}:${req.ip || req.socket.remoteAddress || "local"}`;
    if (buckets.size > 10000) for (const [entry, record] of buckets) if (record.until <= timestamp) buckets.delete(entry);
    if (buckets.size > 20000) return next(new PlatformError("服务繁忙，请稍后重试。", 429, "RATE_LIMITED"));
    const record = buckets.get(key);
    if (!record || record.until <= timestamp) { buckets.set(key, { count: 1, until: timestamp + windowMs }); return next(); }
    record.count += 1;
    if (record.count > limit) return next(new PlatformError("请求过于频繁，请稍后再试。", 429, "RATE_LIMITED"));
    next();
  };
}

function originalFilename(name) {
  if ([...name].every((character) => character.charCodeAt(0) <= 255)) {
    const decoded = Buffer.from(name, "latin1").toString("utf8");
    if (!decoded.includes("�")) return decoded;
  }
  return name;
}

export async function createPlatformApp({ env = process.env, dataDir, seedDoctors = doctorProfiles, fetchImpl = fetch, s3ClientFactory, staticDir, startWorker, disableRateLimits = false, instanceLeaseOptions = {}, testHooks } = {}) {
  const suppliedEnv=env;
  env=new Proxy({}, {set:(target,key,value)=>{Object.defineProperty(target,key,{value,writable:true,enumerable:true,configurable:true});return true},get:(target,key)=>Object.hasOwn(target,key)?target[key]:suppliedEnv[key],has:(target,key)=>Object.hasOwn(target,key)||key in suppliedEnv,ownKeys:target=>[...new Set([...Reflect.ownKeys(suppliedEnv),...Reflect.ownKeys(target)])],getOwnPropertyDescriptor:(target,key)=>({value:Object.hasOwn(target,key)?target[key]:suppliedEnv[key],writable:true,enumerable:true,configurable:true})});
  validateRuntimeConfig(env);
  const workerEnabled = startWorker ?? (env.WORKER_ENABLED !== "false");
  const resolvedDataDir = path.resolve(dataDir || env.DATA_DIR || path.join(root, "data"));
  let database;
  let knowledge;
  let leaseCompromised = null;
  let closeScheduled = false;
  const handleCompromised = (error) => {
    leaseCompromised = error;
    knowledge?.handleLeaseCompromised(error);
    if (!closeScheduled) {
      closeScheduled = true;
      queueMicrotask(() => { void Promise.resolve(database?.close()).catch(() => {}); });
    }
    try { instanceLeaseOptions.onCompromised?.(error); } catch { /* compromise state remains sticky */ }
  };
  const instanceLease = acquirePlatformInstanceLeaseSync(resolvedDataDir, {
    ...instanceLeaseOptions,
    onCompromised: handleCompromised,
  });
  const databaseOptions = { dataDir: resolvedDataDir, seedDoctors, writeGuard: () => instanceLease.assertOwned(), testHooks, environment: env };
  try {
    database = env.DATABASE_URL
      ? await MySQLPlatformDatabase.initialize({ ...databaseOptions, databaseUrl: env.DATABASE_URL, onCompromised: handleCompromised })
      : new PlatformDatabase(databaseOptions);
  }
  catch (error) { instanceLease.releaseSync(); throw error; }
  const rawDatabase=database;
  const access=new PlatformAccess(rawDatabase);
  database=scopedDatabase(rawDatabase,access);
  let providers,telemetry;
  try {
    providers=await new ProviderRegistry(rawDatabase,{env,dataDir:resolvedDataDir,fetchImpl}).initialize();
    telemetry=await new PlatformObservability(database,{env,access,providers}).initialize();
    fetchImpl=telemetry.wrapFetch(providers.guardFetch(fetchImpl));providers.fetchImpl=fetchImpl;
  } catch(error){await rawDatabase.close();instanceLease.releaseSync();throw error}
  let auth;
  try { auth = await createAuth(database, env, testHooks); }
  catch (error) { await database.close(); instanceLease.releaseSync(); throw error; }
  try { knowledge = new KnowledgeService(database, { env, fetchImpl, s3ClientFactory, instanceLease, blobReferenceDatabase: rawDatabase }); }
  catch (error) { await database.close(); instanceLease.releaseSync(); throw error; }
  const app = express();
  const localLimit = createLimiter({ disabled: disableRateLimits });
  const guardedRole=role=>asyncRoute(async(req,_res,next)=>{
    const user=await auth.authenticate(req);if(!user)throw new PlatformError('请先登录管理后台。',401,'UNAUTHENTICATED');
    const context=await access.context(user,req.get('x-tenant-id'));const ranks={viewer:0,editor:1,admin:2};
    const effective=context.member&&ranks[context.member.role]<ranks[user.role]?context.member.role:user.role;
    if(ranks[effective]===undefined||ranks[effective]<ranks[role])throw new PlatformError('当前账号没有此操作权限。',403,'FORBIDDEN');
    req.user={...user,role:effective};req.accessContext=context;access.assertRequest(req,context);return access.run(context,()=>next());
  });
  const viewer=guardedRole('viewer'),editor=guardedRole('editor'),admin=guardedRole('admin');
  const assets=new PlatformAssets(database,{dataDir:resolvedDataDir,env,auth,access});
  const governance=new KnowledgeGovernanceService(database,{knowledge,env,fetchImpl});
  const runtime=createDistributedRuntime({database:rawDatabase,env,fetchImpl});
  const limit=disableRateLimits?localLimit:createOptionalDistributedLimiter({runtime,fallback:localLimit});
  const broker=createSqlQueueBroker({runtime,database:rawDatabase,access,assertOwned:()=>instanceLease.assertOwned()});
  const platformAdmin=(req,res,next)=>admin(req,res,error=>{if(error)return next(error);try{access.assertPlatform();next()}catch(error){next(error)}});
  const authMutation = (handler) => asyncRoute(async (req, res) => {
    try { return res.json(await handler(req, res)); }
    catch (error) {
      if (isInstanceLeaseError(error)) throw instanceLeaseError();
      throw error;
    }
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 4, fieldSize: 2000 } });
  app.disable("x-powered-by");
  if (env.TRUST_PROXY) app.set("trust proxy", env.TRUST_PROXY === "true" ? 1 : env.TRUST_PROXY);
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=(self)");
    if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(asyncRoute(async (req, _res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    try {
      instanceLease.assertOwned();
      await database.assertWritable();
    }
    catch {
      return next(instanceLeaseError());
    }
    next();
  }));
  app.use(telemetry.middleware());
  app.use(telemetry.browserCookie());
  app.use(sameOriginWrites(env));
  app.use(express.json({ limit: '8mb', verify(req,_res,buffer){if(req.url?.split('?')[0]==='/api/business/payment/wechat/notify')req.rawBody=Buffer.from(buffer)} }));
  registerAccessRoutes(app,{access,database,auth,viewer,admin,limit});
  registerProviderRoutes(app,{providers,viewer,admin,access});
  registerAssetRoutes(app,{assets,viewer,editor,admin});
  registerObservabilityRoutes(app,{telemetry,viewer,admin});
  registerKnowledgeRecoveryRoutes(app,{governance,editor,limit});
  registerKnowledgeGovernanceRoutes(app,{governance,database,knowledge,viewer,editor,admin,limit,upload,access,contentChanged:content=>retractContentKnowledge(content.id)});
  registerBuilderLifecycleRoutes(app,{database,knowledge,viewer,editor,admin,env,fetchImpl,limit,authorizeAgent:slug=>access.assertSlug(slug)});
  const business=registerPlatformBusinessRoutes(app,{database:rawDatabase,access,env,fetchImpl,viewer,editor,admin,limit});
  const reports=registerConsumerReportRoutes(app,{database:rawDatabase,env,limit});
  registerDistributedRoutes(app,{viewer,admin:platformAdmin,runtime,audit:(action,req,result)=>{access.assertPlatform();return database.audit(action,actor(req),null,{redis:result.redis?.connected,vector:result.vector?.connected})}});
  const dispatchToken=env.DISTRIBUTED_DISPATCH_TOKEN||env.DISTRIBUTED_WORKER_TOKEN;
  if(env.DISTRIBUTED_RUNTIME_ENABLED==='true'&&dispatchToken)app.post('/api/internal/runtime/dispatch',createDistributedDispatchHandler({runtime,token:dispatchToken,executeDispatch:()=>knowledge.runOne()}));
  app.get("/api/health", asyncRoute(async (_req, res) => {
    if (!await database.ping()) throw new PlatformError("数据库暂时不可用。", 503, "DATABASE_UNAVAILABLE");
    res.json({ ok: true, service: "medtalent-agent-platform", version: "1.0.0", storage: database.storageKind });
  }));
  registerWechatBridgeRoutes(app, { database, env, fetchImpl, limit });
  app.post("/api/auth/login", limit("login", 12, 15 * 60000), authMutation((req, res) => auth.login(req, res)));
  app.post("/api/auth/logout", authMutation((req, res) => auth.logout(req, res)));
  app.get("/api/admin/session", viewer, asyncRoute(async (req, res) => res.json({ user: req.user })));
  app.get("/api/admin/overview", viewer, asyncRoute(async (_req, res) => {
    const overview = await database.overview();
    res.json({ ...overview, recentJobs: overview.recentJobs.map((job) => knowledge.publicJob(job)),
      recentAudit: overview.recentAudit.map((record) => knowledge.publicAudit(record)),
      dailyUsage: knowledge.publicDailyUsage(overview.dailyUsage) });
  }));
  app.get("/api/admin/settings", viewer, asyncRoute(async (_req, res) => {
    const model = modelSettings(env);
    const embeddingDimensions = env.EMBEDDING_DIMENSIONS ? Number(env.EMBEDDING_DIMENSIONS) : null;
    const embeddingBatchSize = env.EMBEDDING_BATCH_SIZE ? Number(env.EMBEDDING_BATCH_SIZE) : 20;
    const embeddingMaxRetries = env.EMBEDDING_MAX_RETRIES ? Number(env.EMBEDDING_MAX_RETRIES) : 2;
    const embeddingSegmentCharacters = env.EMBEDDING_SEGMENT_CHARACTERS ? Number(env.EMBEDDING_SEGMENT_CHARACTERS) : null;
    const embeddingApiProtocol = env.EMBEDDING_API_PROTOCOL || "openai";
    res.json({ version: "1.0.0", storage: database.storageKind, aiConfigured: model.configured, model: model.model,
      embeddingConfigured: Boolean(env.EMBEDDING_API_URL && env.EMBEDDING_API_KEY && env.EMBEDDING_MODEL),
      embeddingModel: env.EMBEDDING_MODEL || "", embeddingApiProtocol, embeddingDimensions, embeddingBatchSize, embeddingMaxRetries, embeddingSegmentCharacters,
      voiceConfigured: Boolean(env.DASHSCOPE_API_KEY),
      nas: getNasCapabilities(env), privacy: "访客数据保留在本机；微信登录后，经用户选择的数据保存到个人账户，可跨设备同步。" });
  }));

  registerAgentBuilderRoutes(app, { database, knowledge, viewer, editor, admin, env, fetchImpl, limit, clonePortrait: (sourceUrl,targetSlug,actor) => assets.clonePortrait(sourceUrl,targetSlug,actor) });
  registerQualificationFileRoutes(app, { database, dataDir: resolvedDataDir, viewer, admin, recordMutation: recordBuilderMutation });
  app.get("/api/admin/agents", viewer, asyncRoute(async (_req, res) => {
    res.json(await Promise.all((await database.listAgents()).map((agent) => withAgentDraftHash(database,agent,knowledge))));
  }));
  app.post("/api/admin/agents/generate", editor, limit("ai-studio", 10, 60000), asyncRoute(async (req, res) => {
    const result = await generateAgentDrafts(req.body, { env, fetchImpl });
    await database.audit("agent.generate_preview", actor(req), null, { count: result.drafts.length, mode: result.mode });
    res.json(result);
  }));
  app.post("/api/admin/agents/batch", editor, asyncRoute(async (req, res) => {
    if (!Array.isArray(req.body?.agents) || req.body.agents.length < 1 || req.body.agents.length > 20) throw new PlatformError("一次可确认创建1—20个智能体。");
    const records = req.body.agents.map((input) => normalizeAgent(input));
    const agents = await database.transaction(async () => {
      const created = [];
      for (const record of records) { created.push(await database.createAgent(record, actor(req))); await recordBuilderMutation(database, record.slug, actor(req)); }
      return created;
    });
    res.status(201).json({ agents: agents.map((agent) => knowledge.publicAgent(agent)) });
  }));
  app.post("/api/admin/agents", editor, asyncRoute(async (req, res) => {
    const created = await database.transaction(async () => {
      const agent = await database.createAgent(normalizeAgent(req.body), actor(req));
      await recordBuilderMutation(database, agent.slug, actor(req));
      return agent;
    });
    res.status(201).json(knowledge.publicAgent(created));
  }));
  app.get("/api/admin/agents/:slug", viewer, asyncRoute(async (req, res) => {
    res.json(await withAgentDraftHash(database,await database.requireAgent(req.params.slug),knowledge));
  }));
  app.put("/api/admin/agents/:slug", editor, asyncRoute(async (req, res) => {
    const saved=await saveAgentWithCAS(database,req.params.slug,req.body,actor(req));
    res.json(await withAgentDraftHash(database,saved,knowledge));
  }));
  app.post('/api/admin/agents/:slug/publish',editor,asyncRoute(async(req,res)=>{
    const published=await publishAgentRelease(database,req.params.slug,actor(req),{expectedDraftHash:req.body?.expectedDraftHash,knowledge});
    res.json(await withAgentDraftHash(database,published,knowledge));
  }));
  app.post("/api/admin/agents/:slug/archive", editor, asyncRoute(async (req, res) => {
    const archived=await database.transaction(async()=>{await assertExpectedDraftHash(database,req.params.slug,req.body?.expectedDraftHash,{allowLegacyMissingHash:true});return database.archiveAgent(req.params.slug,actor(req))});res.json(await withAgentDraftHash(database,archived,knowledge));
  }));
  app.get("/api/admin/agents/:slug/versions", viewer, asyncRoute(async (req, res) => {
    res.json((await database.listVersions(req.params.slug)).map((version) => knowledge.publicVersion(version)));
  }));
  app.post("/api/admin/agents/:slug/rollback", editor, asyncRoute(async (req, res) => {
    if (!Number.isInteger(req.body?.version) || req.body.version < 1) throw new PlatformError("请选择有效的历史版本。");
    const restored = await database.transaction(async () => {
      await assertExpectedDraftHash(database,req.params.slug,req.body?.expectedDraftHash,{allowLegacyMissingHash:true});
      const agent = await database.rollbackAgent(req.params.slug, req.body.version, actor(req));
      await recordBuilderMutation(database, agent.slug, actor(req));
      return agent;
    });
    res.json(await withAgentDraftHash(database,restored,knowledge));
  }));
  app.post("/api/admin/agents/:slug/optimize", editor, limit("ai-studio", 10), asyncRoute(async (req, res) => {
    res.json(await optimizeAgentPrompt(knowledge.publicAgent(await database.requireAgent(req.params.slug)), req.body?.prompt, { env, fetchImpl }));
  }));

  const mutateBuilderResource = (slug, username, operation) => database.transaction(async () => {
    const result = await operation();
    await recordBuilderMutation(database, slug, username);
    return result;
  });
  app.get("/api/admin/documents", viewer, asyncRoute(async (req, res) => {
    const documents = await database.listEntities("documents", agentFilter(req));
    res.json(documents.filter((document) => document.status !== "deleted").map((document) => knowledge.publicDocument(document)));
  }));
  app.post("/api/admin/agents/:slug/documents", editor, limit("upload", 30), upload.single("file"), asyncRoute(async (req, res) => {
    if (!req.file) throw new PlatformError("请选择一个知识文件。");
    const result = await mutateBuilderResource(req.params.slug, actor(req), () => knowledge.storeDocument({ agentSlug: req.params.slug, name: originalFilename(req.file.originalname), buffer: req.file.buffer,
      mimeType: req.file.mimetype, approved: req.body.approved === "true" }, actor(req)));
    res.status(201).json(result.job ? { ...result, job: knowledge.publicJob(result.job) } : result);
  }));
  app.post("/api/admin/agents/:slug/documents/text", editor, asyncRoute(async (req, res) => {
    const text = textField(req.body?.text, "知识正文", { max: 1000000, required: true });
    let name = textField(req.body?.name, "资料名称", { max: 200, required: true });
    if (!path.extname(name)) name += ".md";
    const result = await mutateBuilderResource(req.params.slug, actor(req), () => knowledge.storeDocument({ agentSlug: req.params.slug, name, buffer: Buffer.from(text, "utf8"), mimeType: "text/markdown", approved: req.body.approved === true, source: "text" }, actor(req)));
    res.status(201).json(result.job ? { ...result, job: knowledge.publicJob(result.job) } : result);
  }));
  app.get("/api/admin/documents/:id", viewer, asyncRoute(async (req, res) => {
    const document = await database.requireEntity("documents", req.params.id);
    res.json({ document: knowledge.publicDocument(document), chunks: knowledge.publicChunks(await database.listChunks(document.id)) });
  }));
  app.get("/api/admin/documents/:id/download", viewer, asyncRoute(async (req, res) => {
    const document = await database.requireEntity("documents", req.params.id);
    if (document.status === "deleted" || !document.storageKey) throw new PlatformError("资料已移除，原文件不可下载。", 410, "DOCUMENT_DELETED");
    if (!/^[\da-f-]{36}\.bin$/.test(document.storageKey)) throw new PlatformError("资料存储标识无效。", 500);
    const projectedName = knowledge.publicDocument(document).name.replace(/[\\/\u0000-\u001f\u007f]/g, "_").trim();
    res.download(path.join(knowledge.uploadDir, document.storageKey), projectedName || "knowledge-document.bin");
  }));
  app.post("/api/admin/documents/:id/approve", editor, asyncRoute(async (req, res) => {
    const binding = normalizeDocumentApproval(req.body);
    const document = await database.requireEntity("documents", req.params.id);
    res.json(await mutateBuilderResource(document.agentSlug, actor(req), () => knowledge.approveDocument(req.params.id, actor(req), binding)));
  }));
  app.post("/api/admin/documents/batch-review", editor, asyncRoute(async (req, res) => {
    const input = normalizeDocumentBatchReview(req.body);
    await database.requireAgent(input.agentSlug);
    const result = await database.transaction(async () => {
      const result = await knowledge.batchReviewDocuments(input, actor(req));
      if (result.succeeded > 0) await recordBuilderMutation(database, input.agentSlug, actor(req));
      return result;
    });
    res.json(result);
  }));
  app.post("/api/admin/documents/:id/reindex", editor, limit("reindex", 60), asyncRoute(async (req, res) => {
    const input = normalizeDocumentReindex(req.body);
    const document = await database.requireEntity("documents", req.params.id);
    const job = await mutateBuilderResource(document.agentSlug, actor(req), () => input.strategy === "reuseExistingChunks"
      ? knowledge.reembedDocument(req.params.id, actor(req), input.binding)
      : knowledge.reindexDocument(req.params.id, actor(req), input.binding));
    res.status(202).json(knowledge.publicJob(job));
  }));
  app.delete("/api/admin/documents/:id", editor, asyncRoute(async (req, res) => {
    const binding = normalizeDocumentDeletion(req.body);
    const document = await database.requireEntity("documents", req.params.id);
    res.json(await mutateBuilderResource(document.agentSlug, actor(req), () => knowledge.deleteDocument(req.params.id, actor(req), binding)));
  }));
  app.post("/api/admin/knowledge/approval-preflight", editor, asyncRoute(async (req, res) => res.json(await knowledge.approvalPreflight(req.body))));
  app.get("/api/admin/knowledge/diagnostics", viewer, asyncRoute(async (req, res) => res.json(await knowledge.diagnostics(req.query.agentSlug))));
  app.post("/api/admin/knowledge/search", viewer, limit("search", 60), asyncRoute(async (req, res) => res.json(await knowledge.search(validateSlug(req.body?.agentSlug), req.body?.query))));

  app.get("/api/admin/nas", viewer, asyncRoute(async (_req, res) => res.json(await knowledge.nasStatus())));
  app.post("/api/admin/nas/sources", editor, asyncRoute(async (req, res) => {
    const source = await database.transaction(async () => {
      const candidate = normalizeSource(req.body);
      await database.requireAgent(candidate.agentSlug);
      assertSourceScopeAvailable(candidate, await database.listEntities("sources"));
      await database.saveEntity("sources", candidate);
      await database.audit("nas.source_create", actor(req), candidate.id, { agentSlug: candidate.agentSlug, path: candidate.path });
      if (candidate.enabled) await database.enqueue("nas.sync", { sourceId: candidate.id });
      await recordBuilderMutation(database, candidate.agentSlug, actor(req));
      return candidate;
    });
    res.status(201).json(await knowledge.publicNasSource(source));
  }));
  app.put("/api/admin/nas/sources/:id", editor, asyncRoute(async (req, res) => {
    const source = await database.transaction(async () => {
      const candidate = normalizeSource(req.body, await database.requireEntity("sources", req.params.id));
      assertSourceScopeAvailable(candidate, await database.listEntities("sources"));
      await database.saveEntity("sources", candidate);
      await database.audit("nas.source_update", actor(req), candidate.id);
      if (candidate.enabled) await database.enqueue("nas.sync", { sourceId: candidate.id });
      return candidate;
    });
    res.json(await knowledge.publicNasSource(source));
  }));
  app.delete("/api/admin/nas/sources/:id", editor, asyncRoute(async (req, res) => {
    const source = await database.requireEntity("sources", req.params.id);
    await mutateBuilderResource(source.agentSlug, actor(req), async () => {
      await database.removeEntity("sources", req.params.id);
      await database.audit("nas.source_remove", actor(req), req.params.id, { documentsRetained: true });
    });
    res.json({ ok: true, documentsRetained: true });
  }));
  app.post("/api/admin/nas/sources/:id/test", editor, limit("nas-test", 10), asyncRoute(async (req, res) => res.json(await knowledge.testSource(req.params.id))));
  app.post("/api/admin/nas/sources/:id/sync", editor, asyncRoute(async (req, res) => {
    const source = await database.requireEntity("sources", req.params.id);
    await knowledge.ensureSourceUnchanged(source);
    const job = await database.enqueue("nas.sync", { sourceId: req.params.id });
    await database.audit("nas.sync_requested", actor(req), req.params.id);
    await recordBuilderMutation(database, source.agentSlug, actor(req));
    res.status(202).json(knowledge.publicJob(job));
  }));
  app.get("/api/admin/jobs/active", viewer, asyncRoute(async (_req, res) => {
    const count = await database.countActiveJobs();
    res.json({ count, jobs: (await database.listActiveJobs(Math.min(count, 100))).map((job) => knowledge.publicJob(job)) });
  }));
  app.get("/api/admin/jobs", viewer, asyncRoute(async (_req, res) => {
    res.json((await database.listJobs()).map((job) => knowledge.publicJob(job)));
  }));
  app.get("/api/admin/jobs/:id", viewer, asyncRoute(async (req, res) => {
    const job = await database.getJob(req.params.id);
    if (!job) throw new PlatformError("任务不存在。", 404, "NOT_FOUND");
    res.json(knowledge.publicJob(job));
  }));
  app.post("/api/admin/jobs/:id/retry", editor, asyncRoute(async (req, res) => {
    const job = await database.retryJob(req.params.id);
    await database.audit("job.retry", actor(req), req.params.id);
    res.status(202).json(knowledge.publicJob(job));
  }));
  app.get("/api/admin/audit", viewer, asyncRoute(async (_req, res) => {
    res.json((await database.listAudit()).map((record) => knowledge.publicAudit(record)));
  }));

  const indexContent = async (content, username) => {
    const existing = (await database.listEntities("documents", content.agentSlug)).find((document) => document.source === "content" && document.sourceId === content.id);
    const result = await knowledge.storeDocument({ agentSlug: content.agentSlug, name: `${content.title.replace(/[\\/]/g, "_")}.md`,
      buffer: Buffer.from(`# ${content.title}\n\n${content.summary}\n\n${content.body}`, "utf8"), mimeType: "text/markdown",
      approved: content.status === "published", source: "content", sourceId: content.id, existing }, username);
    if (result.unchanged) {
      const document = await database.requireEntity("documents", result.document.id);
      if (content.status === "published") {
        await database.patchEntity("documents", document.id, { approved: true, status: document.chunkCount ? "ready" : document.status, updatedAt: now() });
      } else await database.patchEntity("documents", document.id, { approved: false, status: document.chunkCount ? "review" : document.status, updatedAt: now() });
    }
    return result;
  };
  const retractContentKnowledge = async (contentId) => {
    for (const document of (await database.listEntities("documents")).filter((document) => document.source === "content" && document.sourceId === contentId && document.status !== "deleted")) {
      await database.patchEntity("documents", document.id, { approved: false, status: document.chunkCount ? "review" : document.status, updatedAt: now() });
    }
  };
  app.get("/api/admin/content", viewer, asyncRoute(async (req, res) => {
    res.json((await database.listEntities("content", agentFilter(req))).map((content) => knowledge.publicContent(content)));
  }));
  app.post("/api/admin/content/generate", editor, limit("ai-studio", 10), asyncRoute(async (req, res) => {
    const agent = knowledge.publicAgent(await database.requireAgent(req.body?.agentSlug));
    const brief = textField(req.body?.brief, "内容需求", { max: 8000, required: true });
    const retrieval = await knowledge.search(agent.slug, brief.slice(0, 2000), { published: false });
    res.json(await generateContentDraft({ agent, brief, type: req.body?.type, citations: retrieval.citations }, { env, fetchImpl }));
  }));
  app.post("/api/admin/content", editor, asyncRoute(async (req, res) => {
    const content = normalizeContent(req.body);
    await database.requireAgent(content.agentSlug);
    await mutateBuilderResource(content.agentSlug, actor(req), async () => {
      await database.saveEntity("content", content);
      await database.audit("content.create", actor(req), content.id, { agentSlug: content.agentSlug, status: content.status });
    });
    res.status(201).json(knowledge.publicContent(content));
  }));
  app.put("/api/admin/content/:id", editor, asyncRoute(async (req, res) => {
    const content = normalizeContent(req.body, await database.requireEntity("content", req.params.id));
    await mutateBuilderResource(content.agentSlug, actor(req), async () => {
      await retractContentKnowledge(content.id);
      await database.saveEntity("content", content);
      if (content.status === "published" && (await database.listEntities("documents", content.agentSlug)).some((document) => document.source === "content" && document.sourceId === content.id && document.status !== "deleted")) await indexContent(content, actor(req));
      await database.audit("content.update", actor(req), content.id, { status: content.status });
    });
    res.json(knowledge.publicContent(content));
  }));
  app.delete("/api/admin/content/:id", editor, asyncRoute(async (req, res) => {
    const content = await database.requireEntity("content", req.params.id);
    await mutateBuilderResource(content.agentSlug, actor(req), async () => {
      await retractContentKnowledge(req.params.id);
      await database.removeEntity("content", req.params.id);
      await database.audit("content.delete", actor(req), req.params.id);
    });
    res.json({ ok: true });
  }));
  app.post("/api/admin/content/:id/index", editor, asyncRoute(async (req, res) => {
    const content = await database.requireEntity("content", req.params.id);
    const result = await mutateBuilderResource(content.agentSlug, actor(req), () => indexContent(content, actor(req)));
    res.status(202).json(result.job ? { ...result, job: knowledge.publicJob(result.job) } : result);
  }));
  app.get("/api/admin/users", admin, asyncRoute(async (_req, res) => res.json(await auth.listUsers())));
  app.post("/api/admin/users", admin, asyncRoute(async (req, res) => res.status(201).json(await auth.saveUser(req.body, actor(req)))));
  app.put("/api/admin/users/:id", admin, asyncRoute(async (req, res) => res.json(await auth.saveUser(req.body, actor(req), req.params.id))));

  app.get("/api/doctors", asyncRoute(async (_req, res) => {
    res.json((await database.listAgents(true)).map((agent) => knowledge.publicAgent(agent, { admin: false })));
  }));
  app.get("/api/doctors/:slug", asyncRoute(async (req, res) => {
    const doctor = await database.getAgent(req.params.slug, true);
    if (!doctor) throw new PlatformError("智能体不存在或尚未发布。", 404, "AGENT_NOT_FOUND");
    res.json({ ...knowledge.publicAgent(doctor, { admin: false }), content: (await database.listEntities("content", doctor.slug))
      .filter((content) => content.status === "published").map((content) => knowledge.publicContent(content)) });
  }));

  const chatArguments = async (req, draftSlug) => {
    const slug = draftSlug || req.body?.doctorSlug || req.body?.agentSlug;
    if (!slug || typeof slug !== "string") throw new PlatformError("缺少智能体标识。", 400, "INVALID_DOCTOR");
    const loadDoctor = async () => {
      const stored = await database.getAgent(slug, !draftSlug);
      if (!stored) throw new PlatformError("智能体不存在或尚未发布。", 404, "INVALID_DOCTOR");
      if (draftSlug && req.body?.draftHash !== undefined) {
        if (typeof req.body.draftHash !== "string" || !/^[a-f0-9]{64}$/.test(req.body.draftHash)) throw new PlatformError("草稿版本无效。", 400, "INVALID_DRAFT_HASH");
        const readiness = await getBuilderReadiness(database, draftSlug);
        if (readiness.draftHash !== req.body.draftHash) throw new PlatformError("草稿已更新，请刷新预览后重试。", 409, "STALE_DRAFT");
      }
      return stored;
    };
    const { storedDoctor, pendingRelease } = draftSlug
      ? await database.transaction(async () => ({ storedDoctor: await loadDoctor(), pendingRelease: await getPendingReleaseSnapshot(database, draftSlug) }))
      : { storedDoctor: await loadDoctor(), pendingRelease: null };
    // Legacy rows may predate strict schemas. Only a fixed, credential-scrubbed
    // projection may be sent to an external model or used to build its prompt.
    const doctor = knowledge.publicAgent(storedDoctor);
    const message = textField(req.body?.message, "问题", { max: 2000, required: true });
    const healthContext = req.body?.healthContext;
    const crisis = detectChatCrisis({ doctor, message, healthContext });
    const scopeGuidance = doctor.slug === "tang-jinsong" && classifyTangQuestion(message, req.body?.history) !== "related";
    if (!draftSlug && !crisis && await business.getActiveHandoff(req, slug)) throw new PlatformError("当前会话已由工作人员接管，请在人工协助入口继续沟通。", 409, "HUMAN_HANDOFF_ACTIVE");
    if (!draftSlug && !crisis && !scopeGuidance && modelSettings(env).configured) await access.consumeRequest(slug);
    const retrieval = crisis || scopeGuidance || !modelSettings(env).configured ? { mode: "none", citations: [] }
      : draftSlug ? await searchPendingRelease(database,slug,message,{knowledge,env,fetchImpl,pendingSnapshot:pendingRelease,agent:doctor}) || await knowledge.search(slug,message,{published:false}) : await knowledge.search(slug, message, { published: true });
    const knowledgeContext = retrieval.citations.length ? buildKnowledgeContext(retrieval.citations, { requireCitations: doctor.config?.requireCitations !== false })
      : "本次未检索到已审核且相关的知识资料。不得声称引用了知识库或编造文献、来源编号；一般知识回答必须明确局限。";
    return { doctor, message, history: req.body?.history, healthContext, knowledgeContext, env, fetchImpl, retrieval };
  };
  const normalChat = (draft = false) => asyncRoute(async (req, res) => {
    const started = Date.now();
    let args;
    try {
      args = await chatArguments(req, draft ? req.params.slug : undefined);
      const result = await generateChatReply(args);
      const retrieval = result.crisis ? { mode: "none", citations: [] } : args.retrieval;
      if (!draft) await database.recordUsage({ agentSlug: args.doctor.slug, model: result.model, retrievalMode: retrieval.mode, latencyMs: Date.now() - started });
      res.json({ ...result, citations: args.doctor.config?.requireCitations === false ? [] : draft ? retrieval.citations : publicCitationTitles(retrieval.citations), retrievalMode: retrieval.mode });
    } catch (error) {
      if (args && !draft) await database.recordUsage({ agentSlug: args.doctor.slug, success: false, latencyMs: Date.now() - started, errorCode: error.code || "UPSTREAM_ERROR" });
      throw error;
    }
  });
  app.post("/api/chat", limit("chat", 30), normalChat());
  app.post("/api/admin/agents/:slug/chat", viewer, limit("chat-preview", 30), normalChat(true));
  app.post("/api/chat/stream", limit("chat", 30), asyncRoute(async (req, res) => {
    const started = Date.now();
    const args = await chatArguments(req);
    const controller = new AbortController();
    const close = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", close);
    let completed = false;
    let model = null;
    let mode = args.retrieval.mode;
    const citations = args.doctor.config?.requireCitations === false ? [] : publicCitationTitles(args.retrieval.citations);
    try {
      const iterator = generateChatReplyStream({ ...args, signal: controller.signal });
      for await (const event of iterator) {
        if (controller.signal.aborted || res.destroyed) break;
        if (!res.headersSent) {
          res.status(200).set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-store, no-transform", "X-Accel-Buffering": "no" });
          res.flushHeaders();
        }
        if (event.model) model = event.model;
        if (event.crisis) mode = "none";
        const payload = event.type === "done" ? { ...event, citations: event.crisis ? [] : citations, retrievalMode: mode } : event;
        res.write(`${JSON.stringify(payload)}\n`);
        if (event.type === "done") completed = true;
      }
      if (!res.writableEnded && !res.destroyed) res.end();
    } catch (error) {
      if (controller.signal.aborted || res.destroyed) return;
      if (res.headersSent) {
        const safeError = safeOutputText(error instanceof ChatServiceError ? error.message : "智能问答服务暂时不可用，请稍后再试。", credentialValues(env), 1000);
        res.write(`${JSON.stringify({ type: "error", error: safeError, code: safeOutputCode(error.code, credentialValues(env), "UPSTREAM_ERROR") })}\n`);
        res.end();
      } else throw error;
    } finally {
      res.off("close", close);
      await database.recordUsage({ agentSlug: args.doctor.slug, model, retrievalMode: mode, success: completed, latencyMs: Date.now() - started, errorCode: completed ? null : "STREAM_INTERRUPTED" });
    }
  }));
  registerSpeechRoutes(app, { env, limit, fetchImpl, database, knowledge, viewer });

  app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在。", code: "NOT_FOUND" }));
  const staticRoot = path.resolve(staticDir || path.join(root, "dist"));
  app.use(express.static(staticRoot, { index: false }));
  app.get("/{*splat}", (_req, res) => res.sendFile(path.join(staticRoot, "index.html")));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.end();
    if (isInstanceLeaseError(error)) error = instanceLeaseError();
    const status = error instanceof multer.MulterError ? (error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
      : (error.statusCode || error.status || 500);
    const known = error instanceof PlatformError || error instanceof ChatServiceError || error instanceof NasError || error instanceof KnowledgeError || error.name === "SpeechServiceError";
    const message = error instanceof multer.MulterError ? "文件上传失败：请确认单个文件不超过50 MB，且一次只上传一个文件。"
      : known ? error.message : status === 413 ? "请求内容过大。" : status === 400 ? "请求格式无效。" : "服务暂时不可用，请稍后再试。";
    if (status >= 500 && !known) console.error("Platform error:", error.name, error.code || "INTERNAL_ERROR");
    res.status(Math.min(599, Math.max(400, status))).json({
      error: safeOutputText(message, credentialValues(env), 1000),
      code: safeOutputCode(error.code, credentialValues(env), "INTERNAL_ERROR"),
      ...(error.code === "DRAFT_CONFLICT" ? { currentDraftHash:error.currentDraftHash,currentVersion:error.currentVersion } : {}),
    });
  });
  if (workerEnabled) await knowledge.start();
  broker.start();
  let closePromise;
  const close = () => {
    if (!closePromise) closePromise = (async () => {
      try { await broker.close();await assets.close();await knowledge.stop();await telemetry.close(); }
      finally {
        try { await database.close(); }
        finally {
          try { await instanceLease.release(); }
          catch (error) { if (!["LEASE_COMPROMISED", "LEASE_RELEASED"].includes(error?.code)) throw error; }
        }
      }
    })();
    return closePromise;
  };
  return { app, database, rawDatabase, access, providers, telemetry, governance, assets, runtime, broker, business, reports, knowledge, auth, instanceLease, get leaseCompromised() { return leaseCompromised; }, close };
}
