import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createPlatformApp } from "./app.mjs";
import { registerWechatBridgeRoutes } from "./wechat-bridge.mjs";

async function startBridge(t, beforeRoutes) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  if (beforeRoutes) app.use(beforeRoutes);
  registerWechatBridgeRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return (pathname, options) => fetch(`${origin}${pathname}`, options);
}

function assertPrivateResponse(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.match(response.headers.get("content-type"), /^application\/json\b/);
}

test("WeChat capability discovery explicitly reports every reserved capability as disabled", async (t) => {
  const request = await startBridge(t);
  const response = await request("/api/wechat/capabilities?enabled=true&login=true");
  assertPrivateResponse(response, 200);
  assert.deepEqual(await response.json(), {
    protocol: "medtalent.wechat",
    version: 1,
    capabilities: {
      login: { enabled: false },
      phoneNumber: { enabled: false },
      payment: { enabled: false },
      subscribeMessage: { enabled: false },
    },
  });
});

test("WeChat session does not adopt an existing management identity or supplied credentials", async (t) => {
  // A preceding management middleware may have populated req.user. The public
  // bridge still has no consumer session and must never reuse that identity.
  const request = await startBridge(t, (req, _res, next) => {
    req.user = { id: "management-admin", username: "administrator", role: "admin" };
    next();
  });
  const response = await request("/api/wechat/session?openid=untrusted-openid&authenticated=true", {
    headers: {
      Cookie: "medtalent_session=existing-management-session; wechat_session=untrusted-session",
      Authorization: "Bearer untrusted-token",
    },
  });
  assertPrivateResponse(response, 200);
  assert.deepEqual(await response.json(), {
    protocol: "medtalent.wechat",
    version: 1,
    enabled: false,
    authenticated: false,
    user: null,
    csrfToken: null,
  });
});

test("WeChat login rejects supplied codes and identities without echoing secrets or creating a session", async (t) => {
  const request = await startBridge(t);
  const response = await request("/api/wechat/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "medtalent_session=existing-management-session" },
    body: JSON.stringify({
      code: "user-supplied-login-code",
      openid: "user-supplied-openid",
      appSecret: "user-supplied-secret",
      session_key: "user-supplied-session-key",
      authenticated: true,
      user: { id: "administrator", role: "admin" },
    }),
  });
  assertPrivateResponse(response, 501);
  assert.deepEqual(await response.json(), {
    protocol: "medtalent.wechat",
    version: 1,
    code: "WECHAT_LOGIN_NOT_CONFIGURED",
    message: "微信登录暂未开放",
  });
  const session = await request("/api/wechat/session");
  assertPrivateResponse(session, 200);
  assert.deepEqual(await session.json(), {
    protocol: "medtalent.wechat",
    version: 1,
    enabled: false,
    authenticated: false,
    user: null,
    csrfToken: null,
  });
});

test("WeChat login without payload also returns the fixed unavailable contract", async (t) => {
  const request = await startBridge(t);
  const response = await request("/api/wechat/login", { method: "POST" });
  assertPrivateResponse(response, 501);
  assert.deepEqual(await response.json(), {
    protocol: "medtalent.wechat",
    version: 1,
    code: "WECHAT_LOGIN_NOT_CONFIGURED",
    message: "微信登录暂未开放",
  });
});

test("platform mounts the reserved WeChat routes and keeps real administrator sessions separate", async (t) => {
  const tempRoot = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(tempRoot, "medtalent-wechat-bridge-test-"));
  let platform;
  let server;
  t.after(async () => {
    try {
      if (server) await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    } finally {
      try { await platform?.close(); }
      finally {
        // Delete only this test's newly created, resolved temporary directory.
        const resolvedDirectory = path.resolve(directory);
        assert.equal(path.dirname(resolvedDirectory), tempRoot);
        assert.ok(path.basename(resolvedDirectory).startsWith("medtalent-wechat-bridge-test-"));
        await fs.rm(resolvedDirectory, { recursive: true, force: true });
      }
    }
  });
  platform = await createPlatformApp({ dataDir: path.join(directory, "data"), env: {}, startWorker: false, seedDoctors: [] });
  server = platform.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (pathname, options) => fetch(`${origin}${pathname}`, options);

  const health = await request("/api/health");
  assertPrivateResponse(health, 200);
  assert.equal((await health.json()).ok, true);

  const capabilities = await request("/api/wechat/capabilities");
  assertPrivateResponse(capabilities, 200);
  assert.deepEqual(await capabilities.json(), {
    protocol: "medtalent.wechat", version: 1,
    capabilities: {
      login: { enabled: false }, phoneNumber: { enabled: false },
      payment: { enabled: false }, subscribeMessage: { enabled: false },
    },
  });
  const expectedSession = {
    protocol: "medtalent.wechat", version: 1, enabled: false, authenticated: false, user: null, csrfToken: null,
  };
  const anonymous = await request("/api/wechat/session");
  assertPrivateResponse(anonymous, 200);
  assert.deepEqual(await anonymous.json(), expectedSession);

  const adminLogin = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ username: "admin", password: "dev-admin-password" }),
  });
  assert.equal(adminLogin.status, 200);
  assert.equal((await adminLogin.json()).user.role, "admin");
  const cookie = adminLogin.headers.get("set-cookie")?.split(";")[0];
  assert.match(cookie, /^medtalent_session=[a-f0-9]{64}$/);

  const wechatLogin = await request("/api/wechat/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie },
    body: JSON.stringify({ code: "integration-untrusted-wechat-code", openid: "integration-untrusted-openid" }),
  });
  assertPrivateResponse(wechatLogin, 501);
  assert.deepEqual(await wechatLogin.json(), {
    protocol: "medtalent.wechat", version: 1,
    code: "WECHAT_LOGIN_NOT_CONFIGURED", message: "微信登录暂未开放",
  });
  const consumer = await request("/api/wechat/session", { headers: { Cookie: cookie } });
  assertPrivateResponse(consumer, 200);
  assert.deepEqual(await consumer.json(), expectedSession);

  const adminSession = await request("/api/admin/session", { headers: { Cookie: cookie } });
  assertPrivateResponse(adminSession, 200);
  assert.equal((await adminSession.json()).user.role, "admin");
});
