import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMiniprograms, chooseAppId, fetchPublishedAgents, parseAppIdMapping,
  parsePublishedAgents, resolveH5BaseUrl, resolvePlatformApiUrl, validateSlug,
} from "../scripts/build-miniprograms.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = { H5_BASE_URL: "https://agents.example.org" };
const directory = (agents) => async () => Response.json(agents);

async function fixture(t) {
  const temp = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(temp, "agent-miniprograms-test-"));
  t.after(async () => {
    const relative = path.relative(temp, folder);
    assert.match(relative, /^agent-miniprograms-test-[^\\/]+$/);
    assert.equal(path.isAbsolute(relative), false);
    await fs.rm(folder, { recursive: true, force: true });
  });
  await fs.cp(path.join(root, "miniprogram-template"), path.join(folder, "miniprogram-template"), { recursive: true });
  return folder;
}

async function writeJson(folder, relative, value) {
  const target = path.join(folder, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(value, null, 2), "utf8");
}

async function readJson(folder, relative) {
  return JSON.parse(await fs.readFile(path.join(folder, relative), "utf8"));
}

test("an explicit production HTTPS H5 origin is mandatory and H5_BASE_URL takes priority", () => {
  assert.throws(() => resolveH5BaseUrl({}), /显式设置/);
  assert.equal(resolveH5BaseUrl({ PUBLIC_URL: "https://public.example.org/" }), "https://public.example.org");
  assert.equal(resolveH5BaseUrl({ PUBLIC_URL: "https://old.example.org", H5_BASE_URL: "https://new.example.org/" }), "https://new.example.org");
  for (const value of ["http://agents.example.org", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://nas.local", "https://agent.internal", "https://agents.example.org/path", "https://agents.example.org?key=value", "https://user:password@agents.example.org", "https://agents.example.org/#hash"]) {
    assert.throws(() => resolveH5BaseUrl({ H5_BASE_URL: value }), /HTTPS|正式/);
  }
});

test("API origin defaults to the new backend and rejects ambiguous endpoints or credentials", () => {
  assert.equal(resolvePlatformApiUrl(), "http://127.0.0.1:8788");
  assert.equal(resolvePlatformApiUrl("https://platform.example.org/"), "https://platform.example.org");
  assert.throws(() => resolvePlatformApiUrl("https://platform.example.org/api/doctors"), /根地址/);
  assert.throws(() => resolvePlatformApiUrl("https://name:secret@platform.example.org"), /根地址/);
});

test("slugs cannot contain traversal, absolute paths, encoded separators or duplicate identities", () => {
  assert.equal(validateSlug("brand-new-agent"), "brand-new-agent");
  for (const slug of ["../outside", "..", "/outside", "C:\\outside", "a/b", "a\\b", "%2e%2e", "Mixed-Case", "-first", "last-", "ab", "con", "nul", "com1"]) assert.throws(() => validateSlug(slug), /slug/);
  assert.throws(() => parsePublishedAgents([{ slug: "new-agent", name: "A" }, { slug: "new-agent", name: "B" }]), /重复/);
  assert.throws(() => parsePublishedAgents([{ slug: "draft-agent", name: "Draft", status: "draft" }]), /非已发布/);
  assert.deepEqual(parsePublishedAgents([]), []);
});

test("legacy tenant arrays and slug-to-AppID objects are mapping-only", () => {
  const legacy = parseAppIdMapping([{ slug: "old-agent", name: "不决定发布名单", projectName: "ignored", appid: "wx1111111111111111" }]);
  assert.equal(legacy.get("old-agent"), "wx1111111111111111");
  assert.equal(parseAppIdMapping({ "new-agent": "wx2222222222222222" }).get("new-agent"), "wx2222222222222222");
  assert.throws(() => parseAppIdMapping([{ slug: "new-agent" }, { slug: "new-agent" }]), /重复/);
  assert.throws(() => parseAppIdMapping({ "../outside": "wx123" }), /slug/);
});

test("configured mapping wins, otherwise manual AppID is retained before tourist fallback", () => {
  assert.deepEqual(chooseAppId("wx1111111111111111", "wx2222222222222222"), { appid: "wx1111111111111111", appidSource: "mapping" });
  assert.deepEqual(chooseAppId("", "wx2222222222222222"), { appid: "wx2222222222222222", appidSource: "existing" });
  assert.deepEqual(chooseAppId("touristappid", "wx2222222222222222"), { appid: "wx2222222222222222", appidSource: "existing" });
  assert.deepEqual(chooseAppId(undefined, "touristappid"), { appid: "touristappid", appidSource: "unconfigured" });
});

test("new published agents generate even when absent from the old mapping list", async (t) => {
  const folder = await fixture(t);
  await writeJson(folder, "miniprogram-tenants.json", [{ slug: "old-agent", name: "旧名单" }]);
  const requested = [];
  const manifest = await buildMiniprograms({ rootDir: folder, env, generatedAt: "2026-09-03T00:00:00.000Z", fetchImpl: async (url) => { requested.push(url); return Response.json([{ slug: "new-agent", name: "新发布助手" }]); } });
  assert.deepEqual(requested, ["http://127.0.0.1:8788/api/doctors"]);
  assert.deepEqual(manifest.activeProjects.map((item) => item.slug), ["new-agent"]);
  assert.deepEqual(manifest.missingAppIds, ["new-agent"]);
  assert.equal(manifest.deploymentPerformed, false);
  assert.equal((await readJson(folder, "dist-wx/new-agent/project.config.json")).appid, "touristappid");
  assert.equal((await readJson(folder, "dist-wx/new-agent/app.json")).window.navigationBarTitleText, "新发布助手智能体");
  const config = await fs.readFile(path.join(folder, "dist-wx/new-agent/config.js"), "utf8");
  assert.match(config, /https:\/\/agents\.example\.org\/d\/new-agent/);
  assert.doesNotMatch(config, /agent\.hzmwmt\.com/);
  assert.equal((await readJson(folder, "dist-wx/manifest.json")).generatedAt, "2026-09-03T00:00:00.000Z");
  await assert.rejects(fs.access(path.join(folder, "dist-wx/old-agent")), { code: "ENOENT" });
});

test("regeneration preserves manual AppID, private files and project settings", async (t) => {
  const folder = await fixture(t);
  await writeJson(folder, "dist-wx/new-agent/project.config.json", { appid: "wx2222222222222222", projectname: "手工项目名", setting: { es6: false, customSetting: true } });
  await writeJson(folder, "dist-wx/new-agent/project.private.config.json", { userSetting: "keep" });
  const result = await buildMiniprograms({ rootDir: folder, env, fetchImpl: directory([{ slug: "new-agent", name: "发布名" }]) });
  const project = await readJson(folder, "dist-wx/new-agent/project.config.json");
  assert.equal(project.appid, "wx2222222222222222");
  assert.equal(project.projectname, "手工项目名");
  assert.equal(project.setting.es6, false);
  assert.equal(project.setting.customSetting, true);
  assert.deepEqual(result.missingAppIds, []);
  assert.equal(result.activeProjects[0].appidSource, "existing");
  assert.equal((await readJson(folder, "dist-wx/new-agent/project.private.config.json")).userSetting, "keep");
  await writeJson(folder, "miniprogram-tenants.json", { "new-agent": "wx3333333333333333" });
  const next = await buildMiniprograms({ rootDir: folder, env, fetchImpl: directory([{ slug: "new-agent", name: "发布名" }]) });
  assert.equal((await readJson(folder, "dist-wx/new-agent/project.config.json")).appid, "wx3333333333333333");
  assert.equal(next.activeProjects[0].appidSource, "mapping");
});

test("successful empty directory preserves historical projects and writes an empty active manifest", async (t) => {
  const folder = await fixture(t);
  await writeJson(folder, "dist-wx/old-agent/project.config.json", { appid: "wx2222222222222222" });
  const result = await buildMiniprograms({ rootDir: folder, env, fetchImpl: directory([]) });
  assert.deepEqual(result.activeProjects, []);
  assert.deepEqual(result.retainedInactiveDirectories, ["old-agent"]);
  assert.deepEqual(result.missingAppIds, []);
  assert.equal((await readJson(folder, "dist-wx/old-agent/project.config.json")).appid, "wx2222222222222222");
});

test("invalid API data fails before changing existing output", async (t) => {
  const folder = await fixture(t);
  await writeJson(folder, "dist-wx/first-agent/project.config.json", { appid: "wx2222222222222222", untouched: true });
  const before = await fs.readFile(path.join(folder, "dist-wx/first-agent/project.config.json"), "utf8");
  await assert.rejects(buildMiniprograms({ rootDir: folder, env, fetchImpl: directory([{ slug: "first-agent", name: "First" }, { slug: "../outside", name: "Bad" }]) }), /slug/);
  assert.equal(await fs.readFile(path.join(folder, "dist-wx/first-agent/project.config.json"), "utf8"), before);
});

test("malformed manual project JSON is never silently replaced", async (t) => {
  const folder = await fixture(t);
  const target = path.join(folder, "dist-wx/new-agent/project.config.json");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "manual appid unfinished", "utf8");
  await assert.rejects(buildMiniprograms({ rootDir: folder, env, fetchImpl: directory([{ slug: "new-agent", name: "New" }]) }), /保护手工配置/);
  assert.equal(await fs.readFile(target, "utf8"), "manual appid unfinished");
});

test("symlink or junction output paths are rejected without writing to the linked directory", async (t) => {
  const folder = await fixture(t);
  const outside = path.join(folder, "outside-output");
  await fs.mkdir(outside);
  await fs.mkdir(path.join(folder, "dist-wx"));
  await fs.symlink(outside, path.join(folder, "dist-wx/new-agent"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(buildMiniprograms({ rootDir: folder, env, fetchImpl: directory([{ slug: "new-agent", name: "New" }]) }), /符号链接|目录联接/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test("API HTTP errors, malformed JSON and network failures are explicit", async () => {
  await assert.rejects(fetchPublishedAgents({ fetchImpl: async () => new Response("unavailable", { status: 503 }) }), /HTTP 503/);
  await assert.rejects(fetchPublishedAgents({ fetchImpl: async () => new Response("not json") }), /无效 JSON/);
  await assert.rejects(fetchPublishedAgents({ fetchImpl: async () => { throw new Error("offline"); } }), /offline/);
});

test("template has no implicit H5 destination or original demo domain", async () => {
  const template = await fs.readFile(path.join(root, "miniprogram-template/config.js"), "utf8");
  assert.match(template, /h5Url:\s*""/);
  assert.doesNotMatch(template, /agent\.hzmwmt\.com/);
});
