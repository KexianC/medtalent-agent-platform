import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPlatformApp } from "../server/app.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
let builtHtml = null;
try { builtHtml = await fs.readFile(path.join(dist, "index.html"), "utf8"); }
catch (error) { if (error.code !== "ENOENT") throw error; }

test("production build HTTP smoke (isolated data and random loopback port)", {
  skip: builtHtml === null ? "dist/index.html is missing; run npm run build before the production HTTP smoke test." : false,
}, async (t) => {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, "agent-production-smoke-"));
  const password = `Smoke-${randomBytes(32).toString("base64url")}`;
  // Explicit synthetic configuration only: never load .env or spread process.env.
  const env = Object.freeze({
    NODE_ENV: "production",
    PUBLIC_URL: "https://agents.example.test",
    ADMIN_USERNAME: "production-smoke-admin",
    ADMIN_PASSWORD: password,
    SESSION_HOURS: "1",
  });
  let platform;
  let server;
  let externalRequests = 0;
  t.after(async () => {
    if (server?.listening) {
      server.closeIdleConnections?.();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    if (platform) await platform.close();
    const relative = path.relative(temporaryRoot, directory);
    assert.match(relative, /^agent-production-smoke-[^\\/]+$/);
    assert.equal(path.isAbsolute(relative), false);
    await fs.rm(directory, { recursive: true, force: true });
  });

  platform = await createPlatformApp({
    env,
    dataDir: path.join(directory, "data"),
    startWorker: false,
    fetchImpl: async () => {
      externalRequests += 1;
      throw new Error("Production smoke must not contact an external model or NAS service.");
    },
  });
  server = await new Promise((resolve, reject) => {
    const instance = platform.app.listen(0, "127.0.0.1");
    instance.once("error", reject);
    instance.once("listening", () => resolve(instance));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object" && address.port > 0);
  assert.equal(address.address, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (url, options = {}) => fetch(`${base}${url}`, { ...options, signal: AbortSignal.timeout(10000) });

  await t.test("production factory starts successfully and exposes the health endpoint", async () => {
    const response = await request("/api/health");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /application\/json/);
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.equal(data.service, "medtalent-agent-platform");
    assert.equal(data.storage, "SQLite");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-powered-by"), null);
  });

  await t.test("fresh production data contains the 11 public seed agents without private configuration", async () => {
    const response = await request("/api/doctors");
    assert.equal(response.status, 200);
    const agents = await response.json();
    assert.equal(agents.length, 11);
    assert.equal(new Set(agents.map((agent) => agent.slug)).size, 11);
    assert.equal(agents.some((agent) => agent.slug === "tang-jinsong"), true);
    assert.equal(agents.some((agent) => agent.slug === "qa-dynamic-public-0903"), false);
    assert.equal(agents.every((agent) => !Object.hasOwn(agent, "config") && !Object.hasOwn(agent, "systemPrompt")), true);
    const detail = await request("/api/doctors/tang-jinsong");
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).slug, "tang-jinsong");
  });

  await t.test("SPA entry, admin route and nested doctor route serve built HTML", async () => {
    for (const route of ["/", "/admin", "/d/tang-jinsong/"]) {
      const response = await request(route);
      assert.equal(response.status, 200, `${route} should serve the SPA document`);
      assert.match(response.headers.get("content-type") || "", /text\/html/);
      const html = await response.text();
      assert.equal(html, builtHtml);
      assert.match(html, /<div id="root"><\/div>/);
      assert.match(html, /<script[^>]+src="\/assets\/[^\"]+\.js"/);
    }
  });

  await t.test("all built JavaScript and CSS chunks are served as real static files", async () => {
    const entries = await fs.readdir(path.join(dist, "assets"), { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && /\.(?:js|css)$/.test(entry.name)).map((entry) => entry.name);
    assert.equal(files.some((name) => name.endsWith(".js")), true);
    assert.equal(files.some((name) => name.endsWith(".css")), true);
    for (const filename of files) {
      const response = await request(`/assets/${encodeURIComponent(filename)}`);
      assert.equal(response.status, 200, `built asset ${filename} should be readable`);
      assert.match(response.headers.get("content-type") || "", filename.endsWith(".css") ? /text\/css/ : /(?:text|application)\/javascript/);
      const served = Buffer.from(await response.arrayBuffer());
      const expected = await fs.readFile(path.join(dist, "assets", filename));
      assert.equal(served.length > 0, true);
      assert.equal(served.equals(expected), true, `built asset ${filename} must not fall through to SPA HTML`);
    }
  });

  await t.test("unknown API routes return JSON 404 rather than SPA HTML", async () => {
    const response = await request("/api/production-smoke-not-a-route");
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type") || "", /application\/json/);
    const data = await response.json();
    assert.equal(data.code, "NOT_FOUND");
    assert.equal(typeof data.error, "string");
  });

  await t.test("unauthenticated management requests are rejected with JSON 401", async () => {
    const response = await request("/api/admin/agents");
    assert.equal(response.status, 401);
    assert.match(response.headers.get("content-type") || "", /application\/json/);
    assert.equal((await response.json()).code, "UNAUTHENTICATED");
  });

  await t.test("production login sets Secure, HttpOnly and SameSite cookies without leaking credentials", async () => {
    const response = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: env.PUBLIC_URL },
      body: JSON.stringify({ username: env.ADMIN_USERNAME, password }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie") || "";
    // Assert boolean attributes so a failure never prints the session token.
    assert.equal(/(?:^|;\s*)Secure(?:;|$)/i.test(cookie), true, "session cookie must be Secure");
    assert.equal(/(?:^|;\s*)HttpOnly(?:;|$)/i.test(cookie), true, "session cookie must be HttpOnly");
    assert.equal(/(?:^|;\s*)SameSite=Strict(?:;|$)/i.test(cookie), true, "session cookie must use SameSite=Strict");
    const data = await response.json();
    assert.equal(data.user.role, "admin");
    assert.equal(Object.hasOwn(data.user, "password_hash"), false);
    assert.equal(JSON.stringify(data).includes(password), false);
  });

  assert.equal(externalRequests, 0, "production HTTP smoke must not call external model or NAS services");
});
