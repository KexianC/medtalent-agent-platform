import { randomBytes, createHash } from "node:crypto";
import { PlatformError, id, now } from "./domain.mjs";

export const consumerHash = value => createHash("sha256").update(value).digest("hex");
const expires = milliseconds => new Date(Date.now() + milliseconds).toISOString();
const documentView = row => row ? ({ section: row.section, value: JSON.parse(row.value_json), revision: Number(row.revision), updatedAt: row.updated_at }) : null;
const invalidRequest = () => new PlatformError("登录请求已失效，请重新发起微信登录。", 409, "LOGIN_REQUEST_INVALID");

export class ConsumerStore {
  constructor(database) { this.database = database; }
  transaction(callback) { return this.database.transaction(callback); }
  async get(sql, args = []) {
    return this.database.storageKind === "MySQL" ? this.database._get(sql, args) : this.database.sqlite.prepare(sql).get(...args);
  }
  async rows(sql, args = []) {
    return this.database.storageKind === "MySQL" ? this.database._rows(sql, args) : this.database.sqlite.prepare(sql).all(...args);
  }
  async run(sql, args = []) {
    return this.database.storageKind === "MySQL" ? this.database._run(sql, args) : this.database.sqlite.prepare(sql).run(...args);
  }
  async session(token) {
    if (!/^[a-f0-9]{64}$/.test(token || "")) return null;
    return this.get(`SELECT s.token_hash,s.user_id,s.expires_at,u.display_name FROM consumer_sessions s
      LEFT JOIN consumer_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`, [consumerHash(token), now()]);
  }
  async createSession(userId = null) {
    const token = randomBytes(32).toString("hex");
    const maxAge = userId ? 30 * 86400000 : 30 * 60000;
    await this.run("DELETE FROM consumer_sessions WHERE expires_at<=?", [now()]);
    await this.run("DELETE FROM consumer_login_requests WHERE expires_at<=?", [now()]);
    await this.run("DELETE FROM consumer_login_codes WHERE expires_at<=?", [now()]);
    await this.run("INSERT INTO consumer_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)", [consumerHash(token), userId, expires(maxAge), now()]);
    return { token, maxAge, session: await this.session(token) };
  }
  async logout(token) {
    const hash = consumerHash(token);
    await this.run("DELETE FROM consumer_sessions WHERE token_hash=?", [hash]);
    await this.run("DELETE FROM consumer_login_requests WHERE session_hash=?", [hash]);
  }
  async beginLogin(token, returnPath) {
    const requestId = randomBytes(16).toString("hex");
    const bridgeToken = randomBytes(32).toString("hex");
    const expiresAt = expires(5 * 60000);
    // Only the most recent explicit login attempt may attach to this browser.
    await this.run("DELETE FROM consumer_login_requests WHERE session_hash=?", [consumerHash(token)]);
    await this.run("INSERT INTO consumer_login_requests(id,session_hash,bridge_hash,status,user_id,return_path,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
      [requestId, consumerHash(token), consumerHash(bridgeToken), "pending", null, returnPath, expiresAt, now()]);
    return { requestId, bridgeToken, expiresAt };
  }
  async claimLogin(requestId, bridgeToken, codeHash) {
    return this.transaction(async () => {
      const request = await this.get("SELECT * FROM consumer_login_requests WHERE id=?", [requestId]);
      if (!request || request.status !== "pending" || request.bridge_hash !== consumerHash(bridgeToken) || request.expires_at <= now()
        || !await this.get("SELECT token_hash FROM consumer_sessions WHERE token_hash=? AND expires_at>?", [request.session_hash, now()])) throw invalidRequest();
      if (await this.get("SELECT code_hash FROM consumer_login_codes WHERE code_hash=?", [codeHash])) throw invalidRequest();
      // Claim before provider IO: concurrent submissions cannot exchange the same code twice.
      await this.run("INSERT INTO consumer_login_codes(code_hash,expires_at) VALUES(?,?)", [codeHash, expires(10 * 60000)]);
      await this.run("UPDATE consumer_login_requests SET status='processing' WHERE id=?", [requestId]);
    });
  }
  async finishLogin(requestId, appId, openId) {
    return this.transaction(async () => {
      const request = await this.get("SELECT * FROM consumer_login_requests WHERE id=?", [requestId]);
      if (!request || request.status !== "processing" || request.expires_at <= now()
        || !await this.get("SELECT token_hash FROM consumer_sessions WHERE token_hash=? AND expires_at>?", [request.session_hash, now()])) throw invalidRequest();
      let user = await this.get("SELECT id FROM consumer_users WHERE app_id=? AND open_id=?", [appId, openId]);
      if (!user) {
        user = { id: id() };
        await this.run("INSERT INTO consumer_users(id,app_id,open_id,display_name,created_at,updated_at) VALUES(?,?,?,?,?,?)", [user.id, appId, openId, "微信用户", now(), now()]);
      }
      await this.run("UPDATE consumer_login_requests SET status='complete',user_id=? WHERE id=?", [user.id, requestId]);
    });
  }
  async failLogin(requestId) {
    await this.transaction(() => this.run("UPDATE consumer_login_requests SET status='failed' WHERE id=? AND status='processing'", [requestId]));
  }
  async consumeLogin(requestId, token) {
    const request = await this.get("SELECT * FROM consumer_login_requests WHERE id=?", [requestId]);
    if (!request || request.session_hash !== consumerHash(token) || request.expires_at <= now()) throw invalidRequest();
    if (["pending", "processing"].includes(request.status)) throw new PlatformError("请先在微信登录页完成登录。", 409, "LOGIN_PENDING");
    if (request.status !== "complete" || !request.user_id) throw invalidRequest();
    const replacement = await this.createSession(request.user_id);
    await this.logout(token);
    return replacement;
  }
  async documents(userId, doctorSlug) {
    return (await this.rows("SELECT section,value_json,revision,updated_at FROM consumer_documents WHERE user_id=? AND agent_slug=? ORDER BY section", [userId, doctorSlug])).map(documentView);
  }
  async saveDocument(userId, doctorSlug, section, value, expectedRevision) {
    if (value !== null && ["chat-messages", "chat-assessments-v1"].includes(section)) {
      const privacy = await this.get("SELECT value_json FROM consumer_documents WHERE user_id=? AND agent_slug=? AND section='privacy'", [userId, doctorSlug]);
      if (privacy && JSON.parse(privacy.value_json)?.saveChat === false) throw new PlatformError("保存对话记录已关闭。", 403, "CHAT_STORAGE_DISABLED");
    }
    const existing = await this.get("SELECT section,value_json,revision,updated_at FROM consumer_documents WHERE user_id=? AND agent_slug=? AND section=?", [userId, doctorSlug, section]);
    if (Number(existing?.revision || 0) !== expectedRevision) return { conflict: true, document: documentView(existing) };
    const revision = expectedRevision + 1;
    const updatedAt = now();
    if (existing) await this.run("UPDATE consumer_documents SET value_json=?,revision=?,updated_at=? WHERE user_id=? AND agent_slug=? AND section=?", [JSON.stringify(value), revision, updatedAt, userId, doctorSlug, section]);
    else await this.run("INSERT INTO consumer_documents(user_id,agent_slug,section,value_json,revision,updated_at) VALUES(?,?,?,?,?,?)", [userId, doctorSlug, section, JSON.stringify(value), revision, updatedAt]);
    await this.database.audit("consumer.component_data_write", "consumer:" + consumerHash(userId).slice(0, 16), doctorSlug, { section, revision, operation: value === null ? "clear" : existing ? "update" : "create" });
    const relatedDocuments = [];
    if (section === "privacy" && value?.saveChat === false) {
      for (const related of ["chat-messages", "chat-assessments-v1"]) {
        const current = await this.get("SELECT revision FROM consumer_documents WHERE user_id=? AND agent_slug=? AND section=?", [userId, doctorSlug, related]);
        const cleared = await this.saveDocument(userId, doctorSlug, related, null, Number(current?.revision || 0));
        relatedDocuments.push(cleared.document);
      }
    }
    return { document: { section, value, revision, updatedAt }, ...(relatedDocuments.length ? { relatedDocuments } : {}) };
  }
}
