import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { PlatformError, id, now, textField } from "./domain.mjs";
import { credentialValues, publicTimestamp, safeOutputText } from "./output-safety.mjs";

const COOKIE_NAME = "medtalent_session";
const ROLE_RANK = { viewer: 0, editor: 1, admin: 2 };
const tokenHash = (token) => createHash("sha256").update(token).digest("hex");

export function passwordField(value, { name = "密码", min = 12, rejectExamples = true } = {}) {
  if (typeof value !== "string") throw new PlatformError(`${name}必须是文本。`, 400, "INVALID_PASSWORD");
  if (value.length < min || value.length > 1024) throw new PlatformError(`${name}长度须为 ${min} 至 1024 个字符。`, 400, "INVALID_PASSWORD");
  if (!value.trim()) throw new PlatformError(`${name}不能仅包含空白字符。`, 400, "INVALID_PASSWORD");
  if (rejectExamples && /^(dev-admin-password|replace|change|password)/i.test(value.trim())) throw new PlatformError(`${name}不能使用开发或示例密码，请设置独立强密码。`, 400, "INVALID_PASSWORD");
  // Whitespace is valid password content, not formatting. Do not trim, remove
  // nulls or normalize Unicode before hashing or verifying the supplied value.
  return value;
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, encoded) {
  try {
    const [method, salt, expected] = encoded.split("$");
    if (method !== "scrypt" || !salt || !expected) return false;
    const actual = scryptSync(password, salt, 64);
    const target = Buffer.from(expected, "hex");
    return actual.length === target.length && timingSafeEqual(actual, target);
  } catch { return false; }
}

function constantEqual(left, right) {
  const leftHash = createHash("sha256").update(left || "").digest();
  const rightHash = createHash("sha256").update(right || "").digest();
  return timingSafeEqual(leftHash, rightHash);
}

function safeUser(user, secrets = []) {
  if (!user) return null;
  return {
    id: safeOutputText(user.id || "", secrets, 100),
    username: safeOutputText(user.username || "", secrets, 80),
    name: safeOutputText(user.name || "", secrets, 100),
    role: Object.hasOwn(ROLE_RANK, user.role) ? user.role : "invalid",
    active: user.active === true || user.active === 1,
    createdAt: publicTimestamp(user.created_at),
  };
}

function cookieToken(req) {
  const cookie = String(req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  return cookie ? cookie.slice(COOKIE_NAME.length + 1) : "";
}

export async function createAuth(database, env = process.env, testHooks) {
  const secure = env.NODE_ENV === "production" || String(env.PUBLIC_URL || "").startsWith("https://");
  const sessionHours = Math.min(72, Math.max(1, Number(env.SESSION_HOURS || 8)));
  const serviceToken = env.ADMIN_TOKEN || "";
  const outputSecrets = credentialValues(env);
  if (env.NODE_ENV === "production" && serviceToken && serviceToken.length < 32) throw new Error("生产环境 ADMIN_TOKEN 必须至少 32 位，或留空禁用 API 令牌。");
  if (!await database.hasAnyUser()) {
    const developmentDefault = env.NODE_ENV !== "production" && (env.ADMIN_PASSWORD === undefined || env.ADMIN_PASSWORD === "");
    const password = passwordField(developmentDefault ? "dev-admin-password" : env.ADMIN_PASSWORD, { name: "ADMIN_PASSWORD", rejectExamples: !developmentDefault });
    const timestamp = now();
    const passwordHash = hashPassword(password);
    await database.transaction(async () => {
      testHooks?.beforeBootstrapMutation?.();
      await database.bootstrapUser({
        id: id(),
        username: env.ADMIN_USERNAME || "admin",
        name: "平台管理员",
        role: "admin",
        active: 1,
        passwordHash,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await database.audit("user.bootstrap", "system", env.ADMIN_USERNAME || "admin");
    });
  }
  if (env.NODE_ENV === "production") {
    const defaults = ["dev-admin-password", "replace-with-your-strong-password", "replace-with-a-long-random-secret"];
    const activeHashes = await database.listActivePasswordHashes();
    const hasDefaultPassword = activeHashes
      .some((entry) => defaults.some((password) => verifyPassword(password, typeof entry === "string" ? entry : entry.password_hash)));
    if (hasDefaultPassword) throw new Error("生产环境拒绝沿用开发/示例密码。请先使用 reset-admin 或账号管理设置独立强密码。");
  }
  // A dummy hash keeps nonexistent-user checks close to normal password checks.
  const dummyHash = hashPassword(randomBytes(24).toString("hex"));
  const setCookie = (res, value, maxAge) => res.cookie(COOKIE_NAME, value, {
    httpOnly: true, sameSite: "strict", secure, path: "/", maxAge,
  });

  const auth = {
    async authenticate(req) {
      const provided = req.get("x-admin-token") || (/^Bearer /i.test(req.get("authorization") || "") ? req.get("authorization").slice(7) : "");
      if (serviceToken && provided && constantEqual(serviceToken, provided)) {
        return { id: "service-token", username: "api-service", name: "API 管理员", role: "admin", active: true };
      }
      const token = cookieToken(req);
      if (!/^[\da-f]{64}$/.test(token)) return null;
      const user = await database.findSessionUser(tokenHash(token), now());
      return safeUser(user, outputSecrets);
    },

    requireRole(role = "viewer") {
      return async (req, _res, next) => {
        const user = await auth.authenticate(req);
        if (!user) return next(new PlatformError("请先登录管理后台。", 401, "UNAUTHENTICATED"));
        if (!Object.hasOwn(ROLE_RANK, user.role) || !Object.hasOwn(ROLE_RANK, role) || ROLE_RANK[user.role] < ROLE_RANK[role]) return next(new PlatformError("当前账号没有此操作权限。", 403, "FORBIDDEN"));
        req.user = user;
        next();
      };
    },

    async login(req, res) {
      const username = textField(req.body?.username, "用户名", { max: 80, required: true });
      const password = passwordField(req.body?.password, { min: 1, rejectExamples: false });
      const user = await database.findUserByUsername(username);
      if (!verifyPassword(password, user?.password_hash || dummyHash) || !user?.active) {
        await database.audit("auth.login_failed", "anonymous", null);
        throw new PlatformError("用户名或密码不正确。", 401, "INVALID_CREDENTIALS");
      }
      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + sessionHours * 3600000).toISOString();
      await database.transaction(async () => {
        testHooks?.beforeLoginSessionMutation?.();
        await database.createLoginSession({ tokenHash: tokenHash(token), userId: user.id, expiresAt, now: now() });
        await database.audit("auth.login", username, user.id);
      });
      setCookie(res, token, sessionHours * 3600000);
      return { user: safeUser(user, outputSecrets), expiresAt };
    },

    async logout(req, res) {
      const token = cookieToken(req);
      if (token) {
        await database.transaction(async () => {
          testHooks?.beforeLogoutSessionMutation?.();
          await database.deleteSession(tokenHash(token));
        });
      }
      setCookie(res, "", 0);
      return { ok: true };
    },

    async listUsers() { return (await database.listUsersRaw()).map((user) => safeUser(user, outputSecrets)); },

    async saveUser(input, actor, userId) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new PlatformError("账号信息格式无效。");
      return database.transaction(async () => {
        const existing = userId ? await database.getUser(userId) : null;
        if (userId && !existing) throw new PlatformError("账号不存在。", 404);
        const username = existing?.username || textField(input.username, "用户名", { max: 80, required: true });
        if (!/^[A-Za-z0-9_.@-]{3,80}$/.test(username)) throw new PlatformError("用户名须为3—80位字母、数字、点、下划线、@或连字符。");
        const name = textField(input.name ?? existing?.name ?? username, "显示名称", { max: 100, required: true });
        const role = input.role || existing?.role || "editor";
        if (typeof role !== "string" || !Object.hasOwn(ROLE_RANK, role)) throw new PlatformError("账号角色无效。");
        if (input.active !== undefined && typeof input.active !== "boolean") throw new PlatformError("账号状态无效。");
        const active = input.active === undefined ? (existing?.active ?? 1) : Number(input.active);
        if (existing?.role === "admin" && existing.active && (role !== "admin" || !active)) {
          const admins = await database.countActiveAdmins();
          if (admins <= 1) throw new PlatformError("必须保留至少一个启用的管理员账号。", 409);
        }
        let passwordHash = existing?.password_hash;
        if (input.password !== undefined || !existing) {
          const password = passwordField(input.password);
          passwordHash = hashPassword(password);
        }
        const actualId = existing?.id || id();
        try {
          if (existing) await database.updateUser(actualId, { name, role, active, passwordHash, updatedAt: now() });
          else {
            const timestamp = now();
            await database.insertUser({ id: actualId, username, name, role, active, passwordHash, createdAt: timestamp, updatedAt: timestamp });
          }
        } catch (error) {
          if (error.code === "ER_DUP_ENTRY" || error.code?.includes("CONSTRAINT")) throw new PlatformError("用户名已存在。", 409, "DUPLICATE_USERNAME");
          throw error;
        }
        if (existing) await database.deleteUserSessions(actualId);
        await database.audit(existing ? "user.update" : "user.create", actor, actualId, { role, active: Boolean(active) });
        return safeUser(await database.getUser(actualId), outputSecrets);
      });
    },
  };
  return auth;
}

export function sameOriginWrites(env = process.env) {
  return (req, _res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.get("origin");
    if (req.get("sec-fetch-site") === "cross-site") return next(new PlatformError("已拒绝跨站写入请求。", 403, "INVALID_ORIGIN"));
    if (origin) {
      const expected = env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : null;
      let allowed = false;
      try { allowed = expected ? new URL(origin).origin === expected : new URL(origin).host === req.get("host"); } catch { /* reject */ }
      if (!allowed) return next(new PlatformError("请求来源与平台域名不匹配。", 403, "INVALID_ORIGIN"));
    }
    next();
  };
}
