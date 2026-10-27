import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import properLockfile from "proper-lockfile";

export const BLOB_MAINTENANCE_LOCK = ".blob-maintenance.lock";
export const PLATFORM_INSTANCE_LOCK = ".platform-instance.lock";
export const DEFAULT_MAINTENANCE_STALE_MS = 30_000;
export const DEFAULT_INSTANCE_STALE_MS = 15_000;

const MIN_STALE_MS = 2_000;
const MIN_UPDATE_MS = 1_000;
const OWNER_VERSION = 1;
const OWNER_MARKER_PATTERN = /^\.owner-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function leaseError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "LeaseError";
  error.code = code;
  return error;
}

function normalizeTiming(staleMs, updateMs) {
  const stale = Math.max(MIN_STALE_MS, Number.isFinite(Number(staleMs)) ? Number(staleMs) : DEFAULT_MAINTENANCE_STALE_MS);
  const requestedUpdate = Number.isFinite(Number(updateMs)) ? Number(updateMs) : Math.floor(stale / 3);
  return { stale, update: Math.max(MIN_UPDATE_MS, Math.min(requestedUpdate, stale / 2)) };
}

function ownerPathFor(lockPath, token) { return path.join(lockPath, `.owner-${token}`); }

function internalResourcePathFor(lockPath, token) {
  return path.join(path.dirname(lockPath), `.lease-resource-${token}`);
}

function readOwner(ownerPath) {
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    return owner && owner.version === OWNER_VERSION && typeof owner.token === "string" ? owner : null;
  } catch { return null; }
}

function isSoleOwner(lockPath, ownerPath, token) {
  try {
    const entries = fs.readdirSync(lockPath);
    return entries.length === 1 && entries[0] === path.basename(ownerPath) && readOwner(ownerPath)?.token === token;
  } catch { return false; }
}

function sameIdentity(left, right) {
  // On filesystems without native birth time support Node may expose ctime as
  // birthtime. proper-lockfile updates the directory mtime for its heartbeat,
  // which also changes ctime and would make a live lease look replaced. The
  // device/inode pair plus the token-specific sole-owner marker identify the
  // directory without relying on that unstable fallback value.
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function statIdentity(lockPath) {
  const stat = fs.statSync(lockPath);
  return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
}

function ownershipError(lockPath) {
  return leaseError(`租约 ${path.basename(lockPath)} 已由其他进程持有。`, "ELEASEOWNERSHIP");
}

function ownershipGuardedFileSystem(lockPath, ownerPath, ownerRecord, stale, state) {
  const resolvedLockPath = path.resolve(lockPath);
  const ownerName = path.basename(ownerPath);
  const lockedError = () => Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" });
  const abandonMarkerSync = () => {
    try { fs.unlinkSync(ownerPath); }
    catch { return; }
    try { fs.rmdirSync(resolvedLockPath); } catch { /* another marker or replacement protects the directory */ }
  };
  const createLockSync = (target) => {
    if (path.resolve(target) !== resolvedLockPath) return fs.mkdirSync(target);
    fs.mkdirSync(resolvedLockPath, { mode: 0o700 });
    let markerWritten = false;
    try {
      writeOwner(ownerPath, ownerRecord);
      markerWritten = true;
      const entries = fs.readdirSync(resolvedLockPath);
      if (entries.length !== 1 || entries[0] !== ownerName) throw lockedError();
      state.pendingOwnership = true;
    } catch (error) {
      if (markerWritten) abandonMarkerSync();
      throw error;
    }
  };
  const createLock = (target, callback) => {
    if (path.resolve(target) !== resolvedLockPath) return fs.mkdir(target, callback);
    fs.mkdir(resolvedLockPath, { mode: 0o700 }, (mkdirError) => {
      if (mkdirError) return callback(mkdirError);
      fs.writeFile(ownerPath, JSON.stringify(ownerRecord), { encoding: "utf8", mode: 0o600, flag: "wx" }, (writeError) => {
        if (writeError) return callback(writeError);
        fs.readdir(resolvedLockPath, (readError, entries) => {
          if (!readError && entries.length === 1 && entries[0] === ownerName) {
            state.pendingOwnership = true;
            return callback(null);
          }
          const acquisitionError = readError || lockedError();
          fs.unlink(ownerPath, (unlinkError) => {
            if (unlinkError) return callback(acquisitionError);
            fs.rmdir(resolvedLockPath, () => callback(acquisitionError));
          });
        });
      });
    });
  };
  const finishOwnedRemovalSync = (target) => {
    if (state.compromised) throw ownershipError(lockPath);
    try { fs.unlinkSync(ownerPath); }
    catch (error) { throw error?.code === "ENOENT" ? ownershipError(lockPath) : error; }
    try { return fs.rmdirSync(target); }
    catch (error) {
      if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw ownershipError(lockPath);
      throw error;
    }
  };
  const removeStaleSync = (target) => {
    const markers = fs.readdirSync(target).filter((entry) => OWNER_MARKER_PATTERN.test(entry));
    const identity = statIdentity(target);
    if (identity.mtimeMs >= Date.now() - stale) throw lockedError();
    for (const marker of markers) {
      try { fs.unlinkSync(path.join(target, marker)); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    try { return fs.rmdirSync(target); }
    catch (error) {
      if (["ENOTEMPTY", "EEXIST"].includes(error?.code)) throw lockedError();
      throw error;
    }
  };
  const removeLockSync = (target) => {
    if (path.resolve(target) !== resolvedLockPath) return fs.rmdirSync(target);
    if (state.enforceOwnership || state.pendingOwnership) return finishOwnedRemovalSync(target);
    return removeStaleSync(target);
  };
  const finishOwnedRemoval = (target, callback) => {
    if (state.compromised) return queueMicrotask(() => callback(ownershipError(lockPath)));
    fs.unlink(ownerPath, (unlinkError) => {
      if (unlinkError) return callback(unlinkError.code === "ENOENT" ? ownershipError(lockPath) : unlinkError);
      fs.rmdir(target, (rmdirError) => {
        if (rmdirError && ["ENOENT", "ENOTEMPTY", "EEXIST"].includes(rmdirError.code)) return callback(ownershipError(lockPath));
        callback(rmdirError);
      });
    });
  };
  const removeStale = (target, callback) => {
    fs.readdir(target, (readError, entries) => {
      if (readError) return callback(readError);
      const markers = entries.filter((entry) => OWNER_MARKER_PATTERN.test(entry));
      fs.stat(target, (statError, stat) => {
        if (statError) return callback(statError);
        if (stat.mtimeMs >= Date.now() - stale) return callback(lockedError());
        let index = 0;
        const removeNext = () => {
          if (index >= markers.length) {
            return fs.rmdir(target, (rmdirError) => {
              if (rmdirError && ["ENOTEMPTY", "EEXIST"].includes(rmdirError.code)) return callback(lockedError());
              callback(rmdirError);
            });
          }
          fs.unlink(path.join(target, markers[index++]), (unlinkError) => {
            if (unlinkError && unlinkError.code !== "ENOENT") return callback(unlinkError);
            removeNext();
          });
        };
        removeNext();
      });
    });
  };
  const removeLock = (target, callback) => {
    if (path.resolve(target) !== resolvedLockPath) return fs.rmdir(target, callback);
    if (state.enforceOwnership || state.pendingOwnership) return finishOwnedRemoval(target, callback);
    return removeStale(target, callback);
  };
  const guarded = { ...fs };
  guarded.mkdir = createLock;
  guarded.mkdirSync = createLockSync;
  guarded.rmdir = removeLock;
  guarded.rmdirSync = removeLockSync;
  return guarded;
}

function writeOwner(ownerPath, record) {
  fs.writeFileSync(ownerPath, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flag: "wx" });
}

function mapAcquireError(error, kind) {
  if (error?.code === "ELOCKED") return leaseError(`${kind}正由另一个活动进程持有。`, "LEASE_BUSY", error);
  return error;
}

export class CrossProcessLease {
  constructor({ token, kind, resourcePath, lockPath, ownerPath, stale, release, synchronous, state, identity, onCompromised }) {
    this.token = token;
    this.kind = kind;
    this.resourcePath = resourcePath;
    this.lockPath = lockPath;
    this.ownerPath = ownerPath;
    this.stale = stale;
    this.rawRelease = release;
    this.synchronous = synchronous;
    this.state = state;
    this.identity = identity;
    this.onCompromised = onCompromised;
    this.compromised = null;
    this.released = false;
    this.releasePromise = null;
  }

  markCompromised(cause) {
    if (this.released || this.compromised) return this.compromised;
    const error = cause?.code === "LEASE_COMPROMISED" ? cause
      : leaseError(`${this.kind}已失效，当前进程已停止使用共享数据目录。`, "LEASE_COMPROMISED", cause);
    this.compromised = error;
    this.state.compromised = true;
    try { this.onCompromised?.(error); } catch { /* a lease callback may not restore ownership */ }
    return error;
  }

  assertOwned() {
    if (this.released) throw leaseError(`${this.kind}已释放。`, "LEASE_RELEASED");
    if (this.compromised) throw this.compromised;
    try {
      const current = statIdentity(this.lockPath);
      if (!isSoleOwner(this.lockPath, this.ownerPath, this.token)
        || !sameIdentity(current, this.identity) || current.mtimeMs < Date.now() - this.stale) {
        throw ownershipError(this.lockPath);
      }
    } catch (error) {
      throw this.markCompromised(error);
    }
    return true;
  }

  releaseSync() {
    if (this.released) return;
    if (!this.synchronous) throw leaseError("异步取得的租约不能同步释放。", "LEASE_RELEASE_MODE");
    let preparationError = this.compromised;
    if (!this.compromised) {
      try {
        this.assertOwned();
        this.state.releasing = true;
      } catch (error) {
        preparationError = error;
        if (error?.code === "ELEASEOWNERSHIP") preparationError = this.markCompromised(error);
      }
    }
    try { this.rawRelease(); }
    catch (error) {
      if (error?.code === "ELEASEOWNERSHIP") preparationError ||= this.markCompromised(error);
      else if (!["ERELEASED", "ENOTACQUIRED"].includes(error?.code)) throw error;
    } finally {
      this.released = true;
      this.state.releasing = false;
    }
    if (preparationError) throw preparationError;
  }

  async release() {
    if (this.releasePromise) return this.releasePromise;
    if (this.released) return;
    this.releasePromise = (async () => {
      let preparationError = this.compromised;
      if (!this.compromised) {
        try {
          this.assertOwned();
          this.state.releasing = true;
        } catch (error) {
          preparationError = error;
          if (error?.code === "ELEASEOWNERSHIP") preparationError = this.markCompromised(error);
        }
      }
      try { await this.rawRelease(); }
      catch (error) {
        if (error?.code === "ELEASEOWNERSHIP") preparationError ||= this.markCompromised(error);
        else if (!["ERELEASED", "ENOTACQUIRED"].includes(error?.code)) throw error;
      } finally {
        this.released = true;
        this.state.releasing = false;
      }
      if (preparationError) throw preparationError;
    })();
    return this.releasePromise;
  }
}

function leaseSetup({ resourcePath, lockPath, kind, staleMs, updateMs, onCompromised }) {
  const resolvedResource = path.resolve(resourcePath);
  const resolvedLock = path.resolve(lockPath);
  fs.mkdirSync(path.dirname(resolvedLock), { recursive: true });
  const token = randomUUID();
  const ownerPath = ownerPathFor(resolvedLock, token);
  const internalResourcePath = internalResourcePathFor(resolvedLock, token);
  const timing = normalizeTiming(staleMs, updateMs);
  const ownerRecord = { version: OWNER_VERSION, token, pid: process.pid, hostname: os.hostname(), kind, acquiredAt: new Date().toISOString() };
  const state = { token, identity: null, pendingOwnership: false, enforceOwnership: false, compromised: false, releasing: false };
  const guardedFs = ownershipGuardedFileSystem(resolvedLock, ownerPath, ownerRecord, timing.stale, state);
  let lease;
  let earlyCompromise;
  const compromised = (error) => lease ? lease.markCompromised(error) : (earlyCompromise = error);
  return { resolvedResource, resolvedLock, internalResourcePath, ownerPath, token, timing, state, guardedFs, kind, onCompromised, compromised,
    attach(rawRelease, synchronous) {
      const identity = statIdentity(resolvedLock);
      state.identity = identity;
      state.enforceOwnership = true;
      lease = new CrossProcessLease({ token, kind, resourcePath: resolvedResource, lockPath: resolvedLock, ownerPath,
        stale: timing.stale, release: rawRelease, synchronous, state, identity, onCompromised });
      if (earlyCompromise) lease.markCompromised(earlyCompromise);
      lease.assertOwned();
      return lease;
    },
  };
}

export function acquireLeaseSync(options) {
  const setup = leaseSetup(options);
  let rawRelease;
  try {
    rawRelease = properLockfile.lockSync(setup.internalResourcePath, {
      realpath: false, lockfilePath: setup.resolvedLock, stale: setup.timing.stale, update: setup.timing.update,
      fs: setup.guardedFs, onCompromised: setup.compromised,
    });
  } catch (error) { throw mapAcquireError(error, setup.kind); }
  try { return setup.attach(rawRelease, true); }
  catch (error) {
    try { rawRelease(); } catch { /* stale recovery will handle an unreleased acquisition */ }
    throw error;
  }
}

export async function acquireLease(options) {
  const setup = leaseSetup(options);
  const waitMs = Math.max(0, Number(options.waitMs) || 0);
  const retryInterval = 100;
  const retries = waitMs ? { retries: Math.ceil(waitMs / retryInterval), factor: 1, minTimeout: retryInterval, maxTimeout: retryInterval, randomize: false } : 0;
  let rawRelease;
  try {
    rawRelease = await properLockfile.lock(setup.internalResourcePath, {
      realpath: false, lockfilePath: setup.resolvedLock, stale: setup.timing.stale, update: setup.timing.update,
      retries, fs: setup.guardedFs, onCompromised: setup.compromised,
    });
  } catch (error) { throw mapAcquireError(error, setup.kind); }
  try { return setup.attach(rawRelease, false); }
  catch (error) {
    try { await rawRelease(); } catch { /* stale recovery will handle an unreleased acquisition */ }
    throw error;
  }
}

export function acquirePlatformInstanceLeaseSync(dataDir, options = {}) {
  const directory = path.resolve(dataDir);
  try {
    return acquireLeaseSync({
      resourcePath: path.join(directory, ".platform-instance"),
      lockPath: path.join(directory, PLATFORM_INSTANCE_LOCK),
      kind: "平台数据目录租约",
      staleMs: options.staleMs ?? DEFAULT_INSTANCE_STALE_MS,
      updateMs: options.updateMs,
      onCompromised: options.onCompromised,
    });
  } catch (error) {
    if (error?.code === "LEASE_BUSY") throw leaseError("该 DATA_DIR 已由另一个平台实例使用；请停止重复实例或改用独立数据目录。", "PLATFORM_INSTANCE_LOCKED", error);
    throw error;
  }
}

export function acquireBlobMaintenanceLease(dataDir, options = {}) {
  const directory = path.resolve(dataDir);
  return acquireLease({
    resourcePath: path.join(directory, ".blob-maintenance"),
    lockPath: path.join(directory, BLOB_MAINTENANCE_LOCK),
    kind: "文档 Blob 维护租约",
    staleMs: options.staleMs ?? DEFAULT_MAINTENANCE_STALE_MS,
    updateMs: options.updateMs,
    waitMs: options.waitMs,
    onCompromised: options.onCompromised,
  });
}
