import { promises as defaultFileSystem } from "node:fs";
import path from "node:path";
import { acquireBlobMaintenanceLease, BLOB_MAINTENANCE_LOCK } from "./file-lease.mjs";

export { BLOB_MAINTENANCE_LOCK } from "./file-lease.mjs";

const STORAGE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$/i;

function validStorageKey(storageKey) {
  return typeof storageKey === "string" && STORAGE_KEY.test(storageKey);
}

/**
 * Small failure-tolerant blob lifecycle manager.
 *
 * A generated file remains in `pendingWrites` until the database transaction
 * that references it has committed. Sweeps therefore cannot remove a file in
 * the write-to-commit window. Retired blobs are deleted only after the caller
 * confirms that no document currently references the key.
 */
export class DocumentBlobStorage {
  constructor(directory, { fileSystem = defaultFileSystem, instanceLease = null, maintenanceLeaseFactory = acquireBlobMaintenanceLease, maintenanceLeaseOptions = {} } = {}) {
    this.directory = path.resolve(directory);
    this.fileSystem = fileSystem;
    this.lockDirectory = path.join(path.dirname(this.directory), BLOB_MAINTENANCE_LOCK);
    this.instanceLease = instanceLease;
    this.maintenanceLeaseFactory = maintenanceLeaseFactory;
    this.maintenanceLeaseOptions = maintenanceLeaseOptions;
    this.pendingWrites = new Set();
    this.retired = new Set();
    this.collecting = null;
  }

  filePath(storageKey) {
    if (!validStorageKey(storageKey)) throw new Error("文档存储标识无效。");
    return path.join(this.directory, storageKey);
  }

  assertInstanceLease() { this.instanceLease?.assertOwned(); }

  async write(storageKey, buffer) {
    const target = this.filePath(storageKey);
    this.assertInstanceLease();
    this.pendingWrites.add(storageKey);
    try {
      await this.fileSystem.mkdir(this.directory, { recursive: true });
      this.assertInstanceLease();
      await this.fileSystem.writeFile(target, buffer, { flag: "wx", mode: 0o600 });
      this.assertInstanceLease();
    } catch (error) {
      this.pendingWrites.delete(storageKey);
      throw error;
    }
    return target;
  }

  finishWrite(storageKey) {
    this.pendingWrites.delete(storageKey);
  }

  retire(storageKey) {
    if (validStorageKey(storageKey)) this.retired.add(storageKey);
  }

  async candidatesFromDisk(maintenanceLease) {
    this.assertInstanceLease();
    maintenanceLease.assertOwned();
    let entries;
    try {
      entries = await this.fileSystem.readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return { keys: [], failed: 0 };
      return { keys: [], failed: 1 };
    }
    this.assertInstanceLease();
    maintenanceLease.assertOwned();
    return {
      keys: entries.filter((entry) => entry.isFile() && validStorageKey(entry.name)).map((entry) => entry.name),
      failed: 0,
    };
  }

  async collectLocked({ isReferenced, sweep }, maintenanceLease) {
    let failed = 0;
    let sweepFailed = false;
    if (sweep) {
      const disk = await this.candidatesFromDisk(maintenanceLease);
      failed += disk.failed;
      sweepFailed = disk.failed > 0;
      for (const storageKey of disk.keys) this.retired.add(storageKey);
    }

    let deleted = 0;
    let referenced = 0;
    let pending = 0;
    for (const storageKey of [...this.retired]) {
      if (this.pendingWrites.has(storageKey)) { pending += 1; continue; }
      let currentReference;
      try { currentReference = await isReferenced(storageKey); }
      catch { failed += 1; continue; }
      if (currentReference) {
        this.retired.delete(storageKey);
        referenced += 1;
        continue;
      }
      this.assertInstanceLease();
      maintenanceLease.assertOwned();
      try {
        await this.fileSystem.unlink(this.filePath(storageKey));
        this.assertInstanceLease();
        maintenanceLease.assertOwned();
        this.retired.delete(storageKey);
        deleted += 1;
      } catch (error) {
        if (["LEASE_COMPROMISED", "LEASE_RELEASED", "PLATFORM_DATA_CLOSED"].includes(error?.code)) throw error;
        if (error?.code === "ENOENT") {
          this.retired.delete(storageKey);
          continue;
        }
        failed += 1;
      }
    }
    return { deleted, referenced, pending, failed, queued: this.retired.size, sweepFailed };
  }

  async collectOnce(options) {
    this.assertInstanceLease();
    let maintenanceLease;
    try {
      maintenanceLease = await this.maintenanceLeaseFactory(path.dirname(this.directory), this.maintenanceLeaseOptions);
    } catch (error) {
      if (error?.code === "LEASE_BUSY") return { deleted: 0, referenced: 0, pending: 0, failed: 0, queued: this.retired.size, sweepFailed: false, deferred: true };
      throw error;
    }
    try {
      this.assertInstanceLease();
      maintenanceLease.assertOwned();
      const result = await this.collectLocked(options, maintenanceLease);
      this.assertInstanceLease();
      maintenanceLease.assertOwned();
      return result;
    } finally {
      await maintenanceLease.release();
    }
  }

  async collect({ isReferenced, sweep = false } = {}) {
    if (typeof isReferenced !== "function") throw new TypeError("isReferenced callback is required");
    // Serialize collectors. A candidate queued while an earlier collector is
    // running is picked up by this invocation after that collector settles.
    while (this.collecting) await this.collecting;
    const running = this.collectOnce({ isReferenced, sweep });
    this.collecting = running;
    try { return await running; }
    finally { if (this.collecting === running) this.collecting = null; }
  }
}

export function isDocumentStorageKey(value) { return validStorageKey(value); }
