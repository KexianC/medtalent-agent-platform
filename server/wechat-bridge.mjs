import { timingSafeEqual } from "node:crypto";
import { validateBuilderAssessmentResults, isOnlyComponentRemoval } from "./builder-consumer.mjs";
import { ConsumerStore, consumerHash } from "./consumer-store.mjs";
import { PlatformError, validateSlug } from "./domain.mjs";

const protocol = "medtalent.wechat";
const version = 1;
const cookieName = "medtalent_consumer";
const sections = new Set(["privacy", "chat-messages", "favorites", "health-records", "health-daily-tasks", "profile-name", "voice-input-hint-dismissed", "chat-assessments-v1", "wellness-v1", "service-plans-v1", "builder-assessments-v1"]);
const arraySections = new Set(["chat-messages", "favorites", "health-records", "chat-assessments-v1"]);
const record = value => value && typeof value === "object" && !Array.isArray(value);
const csrfFor = token => consumerHash(`medtalent-consumer-csrf:${token}`);
const tokenFrom = req => String(req.headers.cookie || "").split(";").map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) || "";
const disabled = res => res.status(501).json({ protocol, version, code: "WECHAT_LOGIN_NOT_CONFIGURED", message: "微信登录暂未开放" });

function input(body, keys) {
  if (!record(body) || Object.keys(body).some(key => !keys.includes(key))) throw new PlatformError("请求格式无效。", 400, "INVALID_INPUT");
  return body;
}
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value)
    && validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}
function validateServicePlans(value) {
  const invalid = () => new PlatformError("服务计划格式无效。", 400, "INVALID_DOCUMENT");
  if (!record(value) || Object.keys(value).some(key => !["version", "plans"].includes(key))
    || value.version !== 1 || !Array.isArray(value.plans) || value.plans.length > 32) throw invalid();
  const ids = new Set();
  const shortText = (text, max) => typeof text === "string" && text.trim().length > 0 && text.length <= max;
  for (const plan of value.plans) {
    if (!record(plan) || Object.keys(plan).some(key => !["id", "service", "completed", "note", "targetDate", "updatedAt", "values"].includes(key))
      || !shortText(plan.id, 120) || !shortText(plan.service, 120) || ids.has(plan.id)
      || !Array.isArray(plan.completed) || plan.completed.length > 16 || plan.completed.some(item => !shortText(item, 160))
      || typeof plan.note !== "string" || plan.note.length > 2000
      || (plan.targetDate !== "" && !validDate(plan.targetDate)) || !validTimestamp(plan.updatedAt)) throw invalid();
    if (plan.values !== undefined) validateComponentValues(plan.values, true);
    ids.add(plan.id);
  }
}
function validateComponentValues(values, nested = false) {
  const invalid = () => new PlatformError("组件字段数据无效。", 400, "INVALID_DOCUMENT");
  const safeKey = key => /^[a-z][A-Za-z0-9_-]{0,63}$/.test(key) && !["constructor", "prototype", "__proto__"].includes(key);
  if (!record(values) || Object.keys(values).length > (nested ? 16 : 20)) throw invalid();
  for (const [key, value] of Object.entries(values)) {
    if (!safeKey(key)) throw invalid();
    if (nested) { validateComponentValues(value); continue; }
    if (!(typeof value === "string" && value.length <= 1000) && !(typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1000000000)) throw invalid();
  }
}
function validateDocument(section, value) {
  if (!sections.has(section)) throw new PlatformError("数据分类不存在。", 400, "INVALID_SECTION");
  if (value === null) return;
  if (value === undefined
    || (arraySections.has(section) && (!Array.isArray(value) || value.length > 2000))
    || (["privacy", "health-daily-tasks", "wellness-v1", "service-plans-v1", "builder-assessments-v1"].includes(section) && !record(value))
    || (section === "profile-name" && (typeof value !== "string" || value.length > 100))
    || (section === "voice-input-hint-dismissed" && typeof value !== "boolean")) throw new PlatformError("数据格式无效。", 400, "INVALID_DOCUMENT");
  if (section === "privacy" && (Object.keys(value).some(key => !["saveChat", "voicePlayback", "reminders"].includes(key)) || Object.values(value).some(item => typeof item !== "boolean"))) throw new PlatformError("隐私设置格式无效。", 400, "INVALID_DOCUMENT");
  if (section === "health-records") for (const item of value) if (item?.values !== undefined) validateComponentValues(item.values);
  if (section === "service-plans-v1") validateServicePlans(value);
  if (section === "builder-assessments-v1") validateBuilderAssessmentResults(value);
  let nodes = 0;
  function visit(node, depth = 0) {
    if (++nodes > 20000 || depth > 20) throw new PlatformError("数据内容过于复杂。", 413, "DOCUMENT_TOO_LARGE");
    if (node && typeof node === "object") {
      for (const key of Object.keys(node)) {
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new PlatformError("数据字段无效。", 400, "INVALID_DOCUMENT");
        visit(node[key], depth + 1);
      }
    }
  }
  visit(value);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 512 * 1024) throw new PlatformError("单项数据超过保存上限。", 413, "DOCUMENT_TOO_LARGE");
}

export function registerWechatBridgeRoutes(app, { database, env = {}, fetchImpl = fetch, limit = () => (_req, _res, next) => next() } = {}) {
  const store = database ? new ConsumerStore(database) : null;
  const enabled = !!store && /^wx[a-f0-9]{16}$/.test(env.WECHAT_APP_ID || "") && /^[A-Za-z0-9_-]{16,128}$/.test(env.WECHAT_APP_SECRET || "") && env.WECHAT_LOGIN_ENABLED !== "false";
  const secure = env.NODE_ENV === "production" || String(env.PUBLIC_URL || "").startsWith("https://");
  const setCookie = (res, token, maxAge) => res.cookie(cookieName, token, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge });
  const view = (session, token) => ({ protocol, version, enabled, authenticated: Boolean(session?.user_id),
    user: session?.user_id ? { id: session.user_id, displayName: session.display_name } : null,
    csrfToken: token ? csrfFor(token) : null });
  const route = handler => (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    Promise.resolve().then(() => handler(req, res)).catch(next);
  };
  const requireSession = async (req, { csrf = false, authenticated = false } = {}) => {
    const token = tokenFrom(req);
    const session = await store.session(token);
    if (!session || (authenticated && !session.user_id)) throw new PlatformError("请先使用微信登录。", 401, "CONSUMER_UNAUTHENTICATED");
    if (csrf) {
      const supplied = req.get("x-csrf-token") || "";
      if (!/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrfFor(token)))) throw new PlatformError("登录状态校验失败，请刷新后重试。", 403, "INVALID_CSRF");
    }
    return { token, session };
  };
  const publishedDoctor = async slug => {
    validateSlug(slug);
    const doctor = await database.getAgent(slug, true);
    if (!doctor) throw new PlatformError("智能体不存在或尚未发布。", 404, "AGENT_NOT_FOUND");
    return doctor;
  };

  app.get("/api/wechat/capabilities", route((_req, res) => res.json({ protocol, version, capabilities: {
    login: { enabled }, phoneNumber: { enabled: false }, payment: { enabled: false }, subscribeMessage: { enabled: false },
  } })));
  app.get("/api/wechat/session", limit("consumer-session", 90), route(async (req, res) => {
    if (!enabled) return res.json(view(null, null));
    const result = await store.transaction(async () => {
      const token = tokenFrom(req);
      const session = await store.session(token);
      return session ? { token, session } : store.createSession();
    });
    if (result.maxAge) setCookie(res, result.token, result.maxAge);
    res.json(view(result.session, result.token));
  }));
  app.post("/api/wechat/login", limit("consumer-login", 12, 15 * 60000), route(async (req, res) => {
    if (!enabled) return disabled(res);
    const body = input(req.body, ["returnPath"]);
    if (typeof body.returnPath !== "string" || !/^(?:\/|\/d\/[a-z0-9][a-z0-9-]{1,62}[a-z0-9](?:\/ask)?)$/.test(body.returnPath)) throw new PlatformError("登录返回路径无效。", 400, "INVALID_RETURN_PATH");
    const result = await store.transaction(async () => {
      const { token } = await requireSession(req, { csrf: true });
      if (body.returnPath !== "/") await publishedDoctor(body.returnPath.split("/")[2]);
      return store.beginLogin(token, body.returnPath);
    });
    res.json(result);
  }));
  app.post("/api/wechat/login/complete", limit("consumer-login-complete", 20, 15 * 60000), route(async (req, res) => {
    if (!enabled) return disabled(res);
    const { requestId, bridgeToken, code } = input(req.body, ["requestId", "bridgeToken", "code"]);
    if (!/^[a-f0-9]{32}$/.test(requestId || "") || !/^[a-f0-9]{64}$/.test(bridgeToken || "") || typeof code !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(code)) throw new PlatformError("登录凭证格式无效。", 400, "INVALID_LOGIN_CODE");
    await store.claimLogin(requestId, bridgeToken, consumerHash(`${env.WECHAT_APP_ID}:${code}`));
    try {
      const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
      url.search = new URLSearchParams({ appid: env.WECHAT_APP_ID, secret: env.WECHAT_APP_SECRET, js_code: code, grant_type: "authorization_code" }).toString();
      const response = await fetchImpl(url.toString(), { redirect: "error", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("provider unavailable");
      const raw = await response.text();
      if (raw.length > 16384) throw new Error("provider response invalid");
      const identity = JSON.parse(raw);
      if (!record(identity) || (identity.errcode && identity.errcode !== 0) || typeof identity.openid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(identity.openid)) throw new Error("provider identity invalid");
      await store.finishLogin(requestId, env.WECHAT_APP_ID, identity.openid);
    } catch {
      await store.failLogin(requestId);
      throw new PlatformError("微信登录未完成，请重新尝试。", 502, "WECHAT_LOGIN_FAILED");
    }
    res.json({ ok: true });
  }));
  app.post("/api/wechat/login/consume", route(async (req, res) => {
    if (!enabled) return disabled(res);
    const { requestId } = input(req.body, ["requestId"]);
    if (!/^[a-f0-9]{32}$/.test(requestId || "")) throw new PlatformError("登录请求无效。", 400, "INVALID_INPUT");
    const result = await store.transaction(async () => {
      const { token } = await requireSession(req, { csrf: true });
      return store.consumeLogin(requestId, token);
    });
    setCookie(res, result.token, result.maxAge);
    res.json(view(result.session, result.token));
  }));
  app.post("/api/wechat/logout", route(async (req, res) => {
    if (!enabled) return disabled(res);
    await store.transaction(async () => {
      const { token } = await requireSession(req, { csrf: true });
      await store.logout(token);
    });
    setCookie(res, "", 0);
    res.json({ ok: true });
  }));
  app.get("/api/user/data/:doctorSlug", limit("consumer-data-read", 120), route(async (req, res) => {
    if (!enabled) return disabled(res);
    const documents = await store.transaction(async () => {
      const { session } = await requireSession(req, { authenticated: true });
      await publishedDoctor(req.params.doctorSlug);
      // Older clients reject unknown sections; exact opt-in keeps active old clients usable.
      const includeServicePlans = req.query.include === "service-plans-v1";
      const includeBuilderAssessments = req.query.includeBuilder === "1";
      return (await store.documents(session.user_id, req.params.doctorSlug))
        .filter(document => (includeServicePlans || document.section !== "service-plans-v1")
          && (includeBuilderAssessments || document.section !== "builder-assessments-v1"));
    });
    res.json({ documents });
  }));
  app.put("/api/user/data/:doctorSlug/:section", limit("consumer-data-write", 120), route(async (req, res) => {
    if (!enabled) return disabled(res);
    const { value, expectedRevision } = input(req.body, ["value", "expectedRevision"]);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= 2147483647) throw new PlatformError("数据版本无效。", 400, "INVALID_REVISION");
    validateDocument(req.params.section, value);
    const result = await store.transaction(async () => {
      const { session } = await requireSession(req, { authenticated: true, csrf: true });
      const doctor = await publishedDoctor(req.params.doctorSlug);
      const permissionKey = { "health-records": "records", "builder-assessments-v1": "assessments", "service-plans-v1": "services" }[req.params.section];
      if (value !== null && permissionKey && doctor.builder?.dataPermissions?.[permissionKey] === "read-only") {
        const previous = (await store.documents(session.user_id, req.params.doctorSlug)).find(document => document.section === req.params.section)?.value;
        if (!isOnlyComponentRemoval(req.params.section, previous, value)) throw new PlatformError("当前组件为只读，仍可查看或删除个人数据。", 403, "COMPONENT_READ_ONLY");
      }
      return store.saveDocument(session.user_id, req.params.doctorSlug, req.params.section, value, expectedRevision);
    });
    if (result.conflict) return res.status(409).json({ code: "DATA_CONFLICT", message: "另一台设备已更新，请同步后重试。", document: result.document });
    res.json(result);
  }));
}
