import path from "node:path";
import { lstatSync, readFileSync } from "node:fs";
import { parseReleaseBlobReferencesMeta, snapshotBlobReferences } from "../server/release-blob-references.mjs";
import { digest } from "../server/builder-lifecycle-schema.mjs";
const fail = code => { throw Object.assign(new Error(code), { code }); };
function merge(references, reference) {
  const previous = references.get(reference.storageKey);
  const value = { size: reference.size, checksum: reference.checksum };
  if (previous && (previous.size !== value.size || previous.checksum !== value.checksum)) fail("RELEASE_BACKUP_BLOB_CONFLICT");
  references.set(reference.storageKey, value);
}
function readLegacy(directory, slug, descriptor) {
  const components = ["builder-releases", slug, descriptor.id + ".json"];
  let current = path.resolve(directory);
  for (let index = 0; index < components.length; index++) {
    current = path.join(current, components[index]);
    const entry = lstatSync(current);
    if (entry.isSymbolicLink() || (index < components.length - 1 ? !entry.isDirectory() : !entry.isFile() || entry.nlink > 1))
      fail("RELEASE_BACKUP_SNAPSHOT_PATH_INVALID");
    if (index === components.length - 1 && entry.size > 256 * 1024 * 1024) fail("RELEASE_BACKUP_SNAPSHOT_TOO_LARGE");
  }
  const snapshot = JSON.parse(readFileSync(current, "utf8"));
  if (snapshot.format !== "doctor-agent-release" || snapshot.schemaVersion !== 1 || snapshot.agentSlug !== slug
    || snapshot.agent?.slug !== slug || snapshot.id !== descriptor.id || digest(snapshot) !== descriptor.sha256)
    fail("RELEASE_BACKUP_SNAPSHOT_INVALID");
  return snapshotBlobReferences(snapshot, { allowMissing: true });
}
// Read-only, shared by immutable SQLite and logical MySQL backup inspections. Never backfills source metadata.
export function backupReleaseBlobReferences(metaRows, directory) {
  const references = new Map();
  let legacyUnresolved = 0;
  for (const row of metaRows) {
    const parsed = parseReleaseBlobReferencesMeta(row.key, row.value);
    if (!parsed) continue;
    for (const reference of parsed.references) merge(references, reference);
    if (!parsed.legacyReleaseIds.length) continue;
    let hasSnapshots = false;
    if (directory) {
      try {
        const entry = lstatSync(path.join(directory, "builder-releases"));
        if (entry.isSymbolicLink() || !entry.isDirectory()) fail("RELEASE_BACKUP_SNAPSHOT_PATH_INVALID");
        hasSnapshots = true;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    // Historical db/uploads-only backups explicitly lack the newer private snapshots.
    if (!hasSnapshots) { legacyUnresolved += parsed.legacyReleaseIds.length; continue; }
    const descriptors = JSON.parse(row.value);
    for (const id of parsed.legacyReleaseIds) {
      const descriptor = descriptors.find(item => item.id === id);
      for (const reference of readLegacy(directory, parsed.agentSlug, descriptor)) merge(references, reference);
    }
  }
  return { references, legacyUnresolved };
}
