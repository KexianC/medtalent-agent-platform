import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const PRIVATE_DATA_DIRECTORIES = Object.freeze([
  "private-config", "media", "builder-releases", "consumer-reports", "channel-candidates", "qualification-files",
]);
const allowed = new Set(PRIVATE_DATA_DIRECTORIES);
const sha256 = value => createHash("sha256").update(value).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { code }); };
const absent = error => error?.code === "ENOENT";
function safeRelative(value) {
  return typeof value === "string" && value.length > 0 && value.length < 4096
    && !value.includes("\\") && !/[\u0000-\u001f\u007f:]/u.test(value)
    && !path.posix.isAbsolute(value) && value.split("/").every(part => part && part !== "." && part !== ".."
      && !/[. ]$/u.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))
    && allowed.has(value.split("/")[0]);
}
async function rootDirectory(directory) {
  let entry;
  try { entry = await fs.lstat(directory); } catch { fail("PRIVATE_BACKUP_ROOT_INVALID"); }
  if (!entry.isDirectory() || entry.isSymbolicLink()) fail("PRIVATE_BACKUP_ROOT_INVALID");
  return await fs.realpath(directory);
}
async function regularHandle(filename) {
  let handle;
  try {
    const entry = await fs.lstat(filename);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink > 1) fail("PRIVATE_BACKUP_FILE_INVALID");
    handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const actual = await handle.stat();
    if (!actual.isFile() || actual.nlink > 1 || actual.ino !== entry.ino || actual.dev !== entry.dev) fail("PRIVATE_BACKUP_FILE_CHANGED");
    return handle;
  } catch (error) { await handle?.close(); throw error; }
}
async function fileInfo(filename) {
  const handle = await regularHandle(filename);
  try {
    const before = await handle.stat();
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail("PRIVATE_BACKUP_FILE_CHANGED");
    return { size: before.size, sha256: hash.digest("hex"), sourceMode: before.mode & 0o777 };
  } finally { await handle.close(); }
}
async function copyRegular(source, target) {
  const input = await regularHandle(source);
  let output;
  try {
    const before = await input.stat();
    output = await fs.open(target, "wx", 0o600);
    for await (const chunk of input.createReadStream({ autoClose: false })) await output.writeFile(chunk);
    await output.sync();
    await output.chmod(0o600);
    const after = await input.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail("PRIVATE_BACKUP_FILE_CHANGED");
  } finally { await input.close(); await output?.close(); }
}
export async function privateDataRoots(directory) {
  const roots = [];
  for (const name of PRIVATE_DATA_DIRECTORIES) {
    let entry;
    try { entry = await fs.lstat(path.join(directory, name)); }
    catch (error) { if (absent(error)) continue; throw error; }
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail("PRIVATE_BACKUP_DIRECTORY_INVALID");
    roots.push(name);
  }
  return roots.sort();
}
async function inventory(directory, roots, assertOwned = () => {}) {
  const root = await rootDirectory(directory);
  const directories = [];
  const files = [];
  async function walk(relative) {
    assertOwned();
    if (!safeRelative(relative)) fail("PRIVATE_BACKUP_PATH_INVALID");
    const absolute = path.join(root, ...relative.split("/"));
    const entry = await fs.lstat(absolute);
    if (entry.isSymbolicLink()) fail("PRIVATE_BACKUP_SYMLINK_FORBIDDEN");
    if (entry.isDirectory()) {
      if (await fs.realpath(absolute) !== absolute) fail("PRIVATE_BACKUP_PATH_INVALID");
      directories.push(relative);
      const children = await fs.readdir(absolute);
      for (const child of children.sort()) await walk(relative + "/" + child);
    } else if (entry.isFile()) files.push({ path: relative, ...await fileInfo(absolute), mode: 0o600 });
    else fail("PRIVATE_BACKUP_FILE_INVALID");
    if (files.length + directories.length > 500_000) fail("PRIVATE_BACKUP_INVENTORY_TOO_LARGE");
  }
  for (const name of roots) await walk(name);
  return { roots: [...roots], directories: directories.sort(), files: files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
}
const comparable = scan => JSON.stringify({ roots: scan.roots, directories: scan.directories,
  files: scan.files.map(({ path: filename, size, sha256: digest }) => ({ path: filename, size, sha256: digest })) });
const manifestDigest = value => sha256(JSON.stringify({ version: value.version, sensitive: value.sensitive,
  consistency: value.consistency, roots: value.roots, directories: value.directories, files: value.files }));
export async function copyPrivateDataDirectories(source, destination, { assertOwned } = {}) {
  if (typeof assertOwned !== "function") fail("PRIVATE_BACKUP_LEASE_REQUIRED");
  assertOwned();
  const sourceRoot = await rootDirectory(source);
  const destinationRoot = await rootDirectory(destination);
  if (sourceRoot === destinationRoot || sourceRoot.startsWith(destinationRoot + path.sep)
    || PRIVATE_DATA_DIRECTORIES.some(name => destinationRoot === path.join(sourceRoot, name) || destinationRoot.startsWith(path.join(sourceRoot, name) + path.sep))) fail("PRIVATE_BACKUP_DESTINATION_INVALID");
  const roots = await privateDataRoots(source);
  if (!roots.length) return undefined;
  const first = await inventory(source, roots, assertOwned);
  for (const relative of first.directories) {
    assertOwned();
    await fs.mkdir(path.join(destination, ...relative.split("/")), { mode: 0o700 });
  }
  for (const file of first.files) {
    assertOwned();
    await copyRegular(path.join(source, ...file.path.split("/")), path.join(destination, ...file.path.split("/")));
  }
  const after = await inventory(source, await privateDataRoots(source), assertOwned);
  if (comparable(first) !== comparable(after)) fail("PRIVATE_BACKUP_SOURCE_CHANGED");
  const manifest = { version: 1, sensitive: true, consistency: "exclusive-instance-lease",
    roots: first.roots, directories: first.directories, files: first.files };
  manifest.sha256 = manifestDigest(manifest);
  await verifyPrivateDataDirectories(destination, manifest);
  return manifest;
}
function validateManifest(manifest) {
  if (!manifest || manifest.version !== 1 || manifest.sensitive !== true || manifest.consistency !== "exclusive-instance-lease"
    || !Array.isArray(manifest.roots) || !manifest.roots.length || manifest.roots.length > allowed.size
    || !Array.isArray(manifest.directories) || !Array.isArray(manifest.files)
    || manifest.files.length + manifest.directories.length > 500_000
    || !/^[0-9a-f]{64}$/u.test(manifest.sha256 || "")) fail("PRIVATE_BACKUP_MANIFEST_INVALID");
  const roots = new Set(manifest.roots);
  if (roots.size !== manifest.roots.length || manifest.roots.some(root => !allowed.has(root))) fail("PRIVATE_BACKUP_MANIFEST_INVALID");
  const directories = new Set();
  for (const dir of manifest.directories) {
    if (!safeRelative(dir) || !roots.has(dir.split("/")[0]) || directories.has(dir)) fail("PRIVATE_BACKUP_MANIFEST_INVALID");
    directories.add(dir);
  }
  if (manifest.roots.some(root => !directories.has(root))) fail("PRIVATE_BACKUP_MANIFEST_INVALID");
  const files = new Set();
  for (const file of manifest.files) {
    if (!file || !safeRelative(file.path) || !roots.has(file.path.split("/")[0]) || files.has(file.path)
      || directories.has(file.path) || !directories.has(path.posix.dirname(file.path))
      || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[0-9a-f]{64}$/u.test(file.sha256 || "")
      || file.mode !== 0o600 || !Number.isInteger(file.sourceMode) || file.sourceMode < 0 || file.sourceMode > 0o777)
      fail("PRIVATE_BACKUP_MANIFEST_INVALID");
    files.add(file.path);
  }
  for (const dir of manifest.directories) {
    if (dir.includes("/") && !directories.has(path.posix.dirname(dir))) fail("PRIVATE_BACKUP_MANIFEST_INVALID");
  }
  if (manifestDigest(manifest) !== manifest.sha256) fail("PRIVATE_BACKUP_MANIFEST_HASH_MISMATCH");
}
export async function verifyPrivateDataDirectories(directory, manifest) {
  const roots = await privateDataRoots(directory);
  if (manifest === undefined) {
    if (roots.length) fail("PRIVATE_BACKUP_MANIFEST_MISSING");
    return { verified: true, legacy: true, sensitive: false, files: 0, bytes: 0, sha256: null };
  }
  validateManifest(manifest);
  if (JSON.stringify(roots) !== JSON.stringify([...manifest.roots].sort())) fail("PRIVATE_BACKUP_ROOTS_MISMATCH");
  const actual = await inventory(directory, roots);
  if (comparable(actual) !== comparable(manifest)) fail("PRIVATE_BACKUP_FILE_MISMATCH");
  if (process.platform !== "win32") {
    if (actual.files.some(file => file.sourceMode !== 0o600)) fail("PRIVATE_BACKUP_MODE_INVALID");
    for (const dir of actual.directories) if (((await fs.lstat(path.join(directory, ...dir.split("/")))).mode & 0o777) !== 0o700) fail("PRIVATE_BACKUP_MODE_INVALID");
  }
  return { verified: true, legacy: false, sensitive: true, files: manifest.files.length,
    bytes: manifest.files.reduce((sum, file) => sum + file.size, 0), sha256: manifest.sha256 };
}
export async function assertPrivateRestoreTarget(directory, manifest) {
  if (manifest !== undefined) validateManifest(manifest);
  const roots = await privateDataRoots(directory);
  // A restore never merges with pre-existing private data, including roots not present in this backup.
  for (const root of roots) if (!manifest?.roots.includes(root) || (await fs.readdir(path.join(directory, root))).length) fail("PRIVATE_RESTORE_TARGET_NOT_EMPTY");
}
export async function restorePrivateDataDirectories(source, destination, manifest, { assertOwned = () => {} } = {}) {
  const report = await verifyPrivateDataDirectories(source, manifest);
  await assertPrivateRestoreTarget(destination, manifest);
  const sourceRoot = await rootDirectory(source);
  const targetRoot = await rootDirectory(destination);
  if (sourceRoot === targetRoot || sourceRoot.startsWith(targetRoot + path.sep) || targetRoot.startsWith(sourceRoot + path.sep))
    fail("PRIVATE_RESTORE_TARGET_INVALID");
  if (manifest === undefined) return report;
  for (const relative of manifest.directories) {
    assertOwned();
    const target = path.join(targetRoot, ...relative.split("/"));
    try { await fs.mkdir(target, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== "EEXIST" || !manifest.roots.includes(relative)) throw error;
      const entry = await fs.lstat(target);
      if (!entry.isDirectory() || entry.isSymbolicLink() || (await fs.readdir(target)).length) fail("PRIVATE_RESTORE_TARGET_NOT_EMPTY");
    }
    await fs.chmod(target, 0o700);
  }
  for (const file of manifest.files) {
    assertOwned();
    await copyRegular(path.join(sourceRoot, ...file.path.split("/")), path.join(targetRoot, ...file.path.split("/")));
  }
  const restored = await verifyPrivateDataDirectories(targetRoot, manifest);
  assertOwned();
  return restored;
}

export async function digestPrivateFile(filename) { return (await fileInfo(filename)).sha256; }
export async function verifySqlitePrivateFiles(source) {
  if (source.manifest.databaseSha256 !== undefined && (!/^[0-9a-f]{64}$/.test(source.manifest.databaseSha256) || await digestPrivateFile(source.databasePath) !== source.manifest.databaseSha256)) fail("SQLITE_BACKUP_DATABASE_HASH_MISMATCH");
  return await verifyPrivateDataDirectories(source.root, source.manifest.privateFiles);
}
