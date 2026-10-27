import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OpsError,
  blobReportMatches,
  inspectMySqlLogicalBackup,
  publicFailure,
  snapshotIsRestoreReady,
  verifyBlobDirectory,
} from "./mysql-ops-common.mjs";

export async function verifyLocalMySqlBackup(sourceDirectory) {
  if (typeof sourceDirectory !== "string" || !sourceDirectory.trim()) {
    throw new OpsError("LOCAL_MYSQL_BACKUP_DIRECTORY_REQUIRED");
  }
  const source = await inspectMySqlLogicalBackup(path.resolve(sourceDirectory));
  const blobs = await verifyBlobDirectory(source.internal.uploadDirectory, source.internal.blobReferences);
  if (!blobReportMatches(source.internal.manifest.blobs, blobs)) {
    throw new OpsError("MYSQL_BACKUP_BLOB_MANIFEST_MISMATCH");
  }
  if (!snapshotIsRestoreReady(source.report, blobs)) {
    throw new OpsError("MYSQL_BACKUP_NOT_RESTORABLE");
  }
  return {
    ok: true,
    code: "LOCAL_MYSQL_BACKUP_VERIFIED",
    kind: "logical-export-v1",
    tableCount: Object.keys(source.report.tables).length,
    rows: Object.values(source.report.tables).reduce((sum, table) => sum + table.rows, 0),
    aggregateSha256: source.report.aggregateSha256,
    privateFiles: source.report.privateFiles,
    blobs: blobs.files,
    blobManifestSha256: blobs.manifestSha256,
  };
}

async function main() {
  if (process.argv.length !== 3) throw new OpsError("LOCAL_MYSQL_BACKUP_ARGUMENT_INVALID");
  process.stdout.write(`${JSON.stringify(await verifyLocalMySqlBackup(process.argv[2]))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(publicFailure(error, "LOCAL_MYSQL_BACKUP_VERIFICATION_FAILED"))}\n`);
    process.exitCode = 1;
  });
}
