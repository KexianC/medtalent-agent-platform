import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function emptyState(config) {
  return {
    version: 2,
    sourceRoot: config.sourceRoot,
    bucket: config.bucket,
    storeIdentity: config.storeIdentity,
    basePrefix: config.basePrefix,
    updatedAt: null,
    lastRun: null,
    files: {},
    orphanedKeys: [],
  };
}

export async function loadState(config) {
  try {
    const parsed = JSON.parse(await fs.readFile(config.statePath, "utf8"));
    if (![1, 2].includes(parsed?.version) || !parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files)) {
      throw new Error("状态清单格式无效。");
    }
    return {
      ...emptyState(config),
      ...parsed,
      version: 2,
      storeIdentity: typeof parsed.storeIdentity === "string" ? parsed.storeIdentity : null,
      files: parsed.files,
      orphanedKeys: parsed.orphanedKeys === undefined ? [] : parsed.orphanedKeys,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState(config);
    throw error;
  }
}

export async function saveState(config, state) {
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  state.updatedAt = new Date().toISOString();
  const temporary = path.join(config.stateDir, `.manifest-${randomUUID()}.tmp`);
  const content = `${JSON.stringify(state, null, 2)}\n`;
  await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  try {
    await fs.rename(temporary, config.statePath);
    await fs.chmod(config.statePath, 0o600).catch(() => {});
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
