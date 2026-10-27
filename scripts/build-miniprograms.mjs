import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const unconfiguredAppId = "touristappid";
const generatedFiles = new Set(["project.config.json", "app.json", "config.js"]);

export function validateSlug(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(value)) {
    throw new Error(`无效的智能体 slug：${String(value)}；仅允许 3—64 位小写英文、数字及内部连字符。`);
  }
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(value)) throw new Error(`无效的智能体 slug：${value} 是 Windows 保留目录名。`);
  return value;
}

export function resolveH5BaseUrl(env = {}) {
  const value = env.H5_BASE_URL || env.PUBLIC_URL;
  if (!value || typeof value !== "string" || !value.trim()) {
    throw new Error("请显式设置 H5_BASE_URL 或 PUBLIC_URL 为正式 H5 的 HTTPS 域名；不会使用原 demo 域名。");
  }
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error("H5_BASE_URL / PUBLIC_URL 不是有效的 HTTPS 域名。"); }
  const hostname = url.hostname.toLowerCase();
  const labels = hostname.split(".");
  const isDomain = labels.length >= 2 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || !isDomain || /^[\d.]+$/.test(hostname) || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(hostname)) {
    throw new Error("H5 地址必须是显式配置的正式 HTTPS 域名根地址，不能包含账号、路径、查询参数、IP 或本地域名。");
  }
  return url.origin;
}

export function resolvePlatformApiUrl(value = "http://127.0.0.1:8788") {
  let url;
  try { url = new URL(value); } catch { throw new Error("PLATFORM_API_URL 必须是平台 API 的 HTTP(S) 根地址。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("PLATFORM_API_URL 必须是平台 API 的 HTTP(S) 根地址，不应包含 /api/doctors、账号或查询参数。");
  }
  return url.origin;
}

export function parsePublishedAgents(value) {
  if (!Array.isArray(value)) throw new Error("/api/doctors 必须返回已发布智能体数组。");
  const seen = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("智能体目录条目格式无效。");
    const slug = validateSlug(entry.slug);
    if (seen.has(slug)) throw new Error(`已发布智能体目录存在重复 slug：${slug}`);
    if (entry.status !== undefined && entry.status !== "published") throw new Error(`目录包含非已发布智能体：${slug}`);
    if (typeof entry.name !== "string" || !entry.name.trim()) throw new Error(`智能体 ${slug} 缺少名称。`);
    seen.add(slug);
    return { slug, name: entry.name.trim() };
  });
}

function configuredAppId(value, label) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error(`${label} 的 AppID 必须是文本。`);
  const appid = value.trim();
  return appid && appid.toLowerCase() !== unconfiguredAppId ? appid : "";
}

/** Legacy arrays remain supported, but names/projectName never define the active directory. */
export function parseAppIdMapping(value) {
  const entries = Array.isArray(value) ? value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("miniprogram-tenants.json 中的映射条目无效。");
    return [item.slug, item.appid];
  }) : value && typeof value === "object" ? Object.entries(value).map(([slug, entry]) => [slug, typeof entry === "object" && entry !== null ? entry.appid : entry]) : null;
  if (!entries) throw new Error("miniprogram-tenants.json 必须是 slug / appid 数组或 slug 到 AppID 的对象。");
  const mapping = new Map();
  for (const [slugValue, value] of entries) {
    const slug = validateSlug(slugValue);
    if (mapping.has(slug)) throw new Error(`AppID 映射存在重复 slug：${slug}`);
    mapping.set(slug, configuredAppId(value, slug));
  }
  return mapping;
}

export function chooseAppId(mapped, existing) {
  const mappedId = configuredAppId(mapped, "映射");
  const existingId = configuredAppId(existing, "已有 project.config.json");
  if (mappedId) return { appid: mappedId, appidSource: "mapping" };
  if (existingId) return { appid: existingId, appidSource: "existing" };
  return { appid: unconfiguredAppId, appidSource: "unconfigured" };
}

export async function fetchPublishedAgents({ apiUrl, fetchImpl = fetch, timeoutMs = 15000 }) {
  const endpoint = `${resolvePlatformApiUrl(apiUrl)}/api/doctors`;
  let response;
  try { response = await fetchImpl(endpoint, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) }); }
  catch (error) { throw new Error(`无法读取已发布智能体目录 ${endpoint}：${error.message}`); }
  if (!response.ok) throw new Error(`读取已发布智能体目录失败：HTTP ${response.status}。`);
  let data;
  try { data = await response.json(); } catch { throw new Error("已发布智能体目录返回了无效 JSON。"); }
  return parsePublishedAgents(data);
}

async function readJson(file, fallback) {
  let content;
  try { content = await fs.readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
  try { return JSON.parse(content.replace(/^\uFEFF/, "")); }
  catch { throw new Error(`${file} 不是有效 JSON；为保护手工配置，本轮停止且不覆盖该文件。`); }
}

function jsonObject(value, file) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${file} 必须是 JSON 对象。`);
  return value;
}

async function statIfExists(file) {
  try { return await fs.lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

/** Reject existing symlinks/junctions as well as lexical directory traversal before any write. */
async function assertSafeOutputPath(output, target) {
  const relative = path.relative(output, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("输出路径不能离开 dist-wx。");
  let current = output;
  for (const part of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const stat = await statIfExists(current);
    if (stat?.isSymbolicLink()) throw new Error(`输出路径包含符号链接或目录联接，已停止写入：${current}`);
    if (stat && current !== target && !stat.isDirectory()) throw new Error(`输出父路径不是目录：${current}`);
    if (stat && current === target && !stat.isFile()) throw new Error(`输出文件位置已被非普通文件占用：${current}`);
  }
}

async function listTemplateFiles(template, relative = "") {
  const directory = path.join(template, relative);
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`模板必须是普通目录：${directory}`);
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`模板不允许符号链接：${name}`);
    if (entry.isDirectory()) result.push(...await listTemplateFiles(template, name));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`模板中存在不支持的文件类型：${name}`);
  }
  return result;
}

export async function buildMiniprograms({ rootDir = projectRoot, env = process.env, fetchImpl = fetch, generatedAt = new Date().toISOString() } = {}) {
  const root = path.resolve(rootDir);
  const template = path.join(root, "miniprogram-template");
  const output = path.join(root, "dist-wx");
  // Fetch and validate all inputs before touching previously generated projects.
  const h5BaseUrl = resolveH5BaseUrl(env);
  const platformApiUrl = resolvePlatformApiUrl(env.PLATFORM_API_URL || undefined);
  const agents = await fetchPublishedAgents({ apiUrl: platformApiUrl, fetchImpl });
  const mapping = parseAppIdMapping(await readJson(path.join(root, "miniprogram-tenants.json"), []));
  const templateFiles = await listTemplateFiles(template);
  const templateProject = jsonObject(await readJson(path.join(template, "project.config.json")), "模板 project.config.json");
  const templateApp = jsonObject(await readJson(path.join(template, "app.json")), "模板 app.json");
  await assertSafeOutputPath(output, path.join(output, "manifest.json"));
  const plans = [];
  for (const agent of agents) {
    const target = path.join(output, agent.slug);
    for (const file of [...templateFiles, ...generatedFiles]) await assertSafeOutputPath(output, path.join(target, file));
    const existingProject = jsonObject(await readJson(path.join(target, "project.config.json"), {}), `${agent.slug}/project.config.json`);
    const existingApp = jsonObject(await readJson(path.join(target, "app.json"), {}), `${agent.slug}/app.json`);
    const appid = chooseAppId(mapping.get(agent.slug), existingProject.appid);
    plans.push({ agent, target, appid, existingProject, existingApp, h5Url: `${h5BaseUrl}/d/${agent.slug}` });
  }
  const previous = await fs.readdir(output, { withFileTypes: true }).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  const activeSlugs = new Set(agents.map((agent) => agent.slug));
  const retainedInactiveDirectories = previous.filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !activeSlugs.has(entry.name)).map((entry) => entry.name).sort();
  await fs.mkdir(output, { recursive: true });
  for (const plan of plans) {
    await fs.mkdir(plan.target, { recursive: true });
    for (const file of templateFiles.filter((name) => !generatedFiles.has(name))) {
      const destination = path.join(plan.target, file);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(template, file), destination);
    }
    const project = { ...templateProject, ...plan.existingProject,
      setting: { ...templateProject.setting, ...plan.existingProject.setting },
      projectname: plan.existingProject.projectname || `${plan.agent.name}智能体`, appid: plan.appid.appid };
    const app = { ...templateApp, ...plan.existingApp,
      window: { ...templateApp.window, ...plan.existingApp.window, navigationBarTitleText: `${plan.agent.name}智能体` } };
    await fs.writeFile(path.join(plan.target, "project.config.json"), `${JSON.stringify(project, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(plan.target, "app.json"), `${JSON.stringify(app, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(plan.target, "config.js"), `module.exports = ${JSON.stringify({ doctorSlug: plan.agent.slug, doctorName: plan.agent.name, h5Url: plan.h5Url }, null, 2)};\n`, "utf8");
  }
  const activeProjects = plans.map(({ agent, appid, h5Url }) => ({ slug: agent.slug, name: agent.name, directory: agent.slug, h5Url, ...appid }));
  const manifest = { schemaVersion: 1, generatedAt, platformApiUrl, h5BaseUrl, activeProjects,
    missingAppIds: activeProjects.filter((project) => project.appidSource === "unconfigured").map((project) => project.slug),
    retainedInactiveDirectories, deploymentPerformed: false };
  await fs.writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { ...manifest, outputDirectory: output };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await buildMiniprograms();
    console.log(`已生成 ${result.activeProjects.length} 个已发布智能体的小程序工程：${result.outputDirectory}`);
    console.log(`本轮清单：${path.join(result.outputDirectory, "manifest.json")}`);
    if (result.missingAppIds.length) console.warn(`以下工程尚未配置 AppID：${result.missingAppIds.join("、")}。请填写映射或对应 project.config.json 后再导入微信开发者工具。`);
    if (result.retainedInactiveDirectories.length) console.warn(`保留 ${result.retainedInactiveDirectories.length} 个本轮非活跃的历史目录；发布时请以 manifest.json 的 activeProjects 为准。`);
    console.log("仅生成本地工程，未向微信提交、上传或发布。");
  } catch (error) {
    console.error(`小程序生成失败：${error.message}`);
    process.exitCode = 1;
  }
}
