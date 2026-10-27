/** Account-scoped, revision-checked cloud documents. Guest data is never read here. */
export const consumerSections = [
  'privacy', 'chat-messages', 'favorites', 'health-records', 'health-daily-tasks',
  'profile-name', 'voice-input-hint-dismissed', 'chat-assessments-v1', 'wellness-v1', 'service-plans-v1', 'builder-assessments-v1',
] as const;
export type ConsumerSection = typeof consumerSections[number];
export type ConsumerDataStatus = 'idle' | 'loading' | 'synced' | 'pending' | 'saving' | 'offline' | 'conflict' | 'error';
export interface ConsumerDataState<T> {
  value: T;
  status: ConsumerDataStatus;
  revision: number | null;
  canEdit: boolean;
  error?: string;
  cloudValue?: T;
  cloudRevision?: number;
}
export interface ConsumerIdentity { userId: string; csrfToken: string }
interface CloudDocument { section: ConsumerSection; value: unknown; revision: number; updatedAt?: string }
interface Entry {
  base: CloudDocument;
  local?: unknown;
  dirty: boolean;
  edit: number;
  saving?: boolean;
  conflict?: CloudDocument;
  error?: string;
}
interface DoctorData {
  known: boolean;
  checked: boolean;
  entries: Map<ConsumerSection, Entry>;
  loading?: Promise<void>;
  error?: string;
}
type CacheStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
interface StoreOptions { fetchImpl?: typeof fetch; storage?: CacheStorage | null }
const cachePrefix = 'medtalent:consumer-data:v1:';
const sectionSet = new Set<string>(consumerSections);
const chatSections = ['chat-messages', 'chat-assessments-v1'] as const;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const empty = (section: ConsumerSection): Entry => ({ base: { section, value: null, revision: 0 }, dirty: false, edit: 0 });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function document(value: unknown): CloudDocument | undefined {
  if (!object(value) || typeof value.section !== 'string' || !sectionSet.has(value.section)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !has(value, 'value')) return;
  return { section: value.section as ConsumerSection, value: value.value, revision: value.revision as number,
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}) };
}
function defaultStorage(): CacheStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; } catch { return undefined; }
}

export function createConsumerDataStore({ fetchImpl = (input, init) => fetch(input, init), storage = defaultStorage() }: StoreOptions = {}) {
  let identity: ConsumerIdentity | null = null;
  let epoch = 0;
  let controller = new AbortController();
  let doctors = new Map<string, DoctorData>();
  let version = 0;
  let worker: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const emit = () => { version += 1; listeners.forEach(listener => listener()); };
  const current = (generation: number) => generation === epoch && identity !== null;
  async function readDocuments(doctor: string, parent: AbortSignal) {
    const requestController = new AbortController();
    let rejectWait: (reason: Error) => void;
    const timeout = new Promise<never>((_resolve, reject) => { rejectWait = reject; });
    const abort = () => { requestController.abort(); rejectWait(new Error('读取云端记录超时，请检查网络后重试。')); };
    const timer = setTimeout(abort, 12000);
    parent.addEventListener('abort', abort, { once: true });
    if (parent.aborted) abort();
    try {
      return await Promise.race([(async () => {
        const response = await fetchImpl(`/api/user/data/${encodeURIComponent(doctor)}?include=service-plans-v1&includeBuilder=1`, { credentials: 'include', signal: requestController.signal });
        const body: unknown = await response.json();
        return { response, body };
      })(), timeout]);
    } finally { clearTimeout(timer); parent.removeEventListener('abort', abort); }
  }
  const doctorData = (doctor: string) => {
    let data = doctors.get(doctor);
    if (!data) { data = { known: false, checked: false, entries: new Map() }; doctors.set(doctor, data); }
    return data;
  };
  const entryFor = (data: DoctorData, section: ConsumerSection) => {
    let entry = data.entries.get(section);
    if (!entry) { entry = empty(section); data.entries.set(section, entry); }
    return entry;
  };
  function persist() {
    if (!identity || !storage) return;
    const values = [...doctors].filter(([, data]) => data.known).map(([doctor, data]) => [doctor, {
      entries: [...data.entries].map(([section, entry]) => [section, {
        base: entry.base, dirty: entry.dirty,
        ...(entry.dirty ? { local: entry.local } : {}),
        ...(entry.conflict ? { conflict: entry.conflict } : {}),
      }]),
    }]);
    // Never persist the session or CSRF token. A blocked/quota-limited cache must not stop online saving.
    try { storage.setItem(cachePrefix + encodeURIComponent(identity.userId), JSON.stringify({ version: 1, doctors: values })); } catch { /* memory and server remain usable */ }
  }
  function hydrate(userId: string) {
    try {
      const raw: unknown = JSON.parse(storage?.getItem(cachePrefix + encodeURIComponent(userId)) || 'null');
      if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.doctors)) return;
      for (const item of raw.doctors) {
        if (!Array.isArray(item) || typeof item[0] !== 'string' || !object(item[1]) || !Array.isArray(item[1].entries)) continue;
        const data: DoctorData = { known: true, checked: false, entries: new Map() };
        for (const row of item[1].entries) {
          if (!Array.isArray(row) || typeof row[0] !== 'string' || !object(row[1])) continue;
          const base = document(row[1].base);
          if (!base || base.section !== row[0]) continue;
          const dirty = row[1].dirty === true && has(row[1], 'local');
          const conflict = document(row[1].conflict);
          data.entries.set(base.section, { base, dirty, edit: 0, ...(dirty ? { local: row[1].local } : {}),
            ...(conflict?.section === base.section ? { conflict } : {}) });
        }
        doctors.set(item[0], data);
      }
    } catch { /* Invalid cache never grants a new account a known baseline. */ }
  }
  function eligible(): [string, ConsumerSection, Entry] | undefined {
    for (const [doctor, data] of doctors) {
      if (!data.known || !data.checked || data.loading || data.error) continue;
      for (const [section, entry] of data.entries) {
        if (entry.dirty && !entry.conflict && !entry.error && !entry.saving) return [doctor, section, entry];
      }
    }
  }
  function schedule() {
    if (worker || !identity || !eligible()) return;
    const generation = epoch;
    const signal = controller.signal;
    const task = Promise.resolve().then(async () => {
      while (current(generation)) {
        const next = eligible();
        if (!next) break;
        const [doctor, section, entry] = next;
        const value = copy(entry.local);
        const edit = entry.edit;
        const expectedRevision = entry.base.revision;
        const token = identity!.csrfToken;
        const clearsChat = section === 'privacy' && object(value) && value.saveChat === false;
        const relatedBefore = clearsChat ? new Map(chatSections.map(name => {
          const related = entryFor(doctorData(doctor), name);
          return [name, { edit: related.edit, revision: related.base.revision }];
        })) : undefined;
        entry.saving = true;
        emit();
        try {
          const response = await fetchImpl(`/api/user/data/${encodeURIComponent(doctor)}/${encodeURIComponent(section)}`, {
            method: 'PUT', credentials: 'include', signal,
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            body: JSON.stringify({ value, expectedRevision }),
          });
          const body: unknown = await response.json();
          if (!current(generation)) return;
          const remote = object(body) ? document(body.document) : undefined;
          const related = object(body) && Array.isArray(body.relatedDocuments) ? body.relatedDocuments.map(document) : [];
          const relatedConfirmed = !clearsChat || (related.length === chatSections.length && chatSections.every(name => {
            const matching = related.filter(item => item?.section === name);
            return matching.length === 1 && matching[0].value === null && matching[0].revision > relatedBefore!.get(name)!.revision;
          }));
          if (response.status === 409 && remote?.section === section) {
            entry.conflict = remote;
            entry.error = '其他设备已更新这份数据，请选择要保留的版本。';
          } else if (!response.ok) {
            const expired = response.status === 401 || response.status === 403;
            // A same-account session refresh can rotate CSRF while this write is in flight.
            entry.error = expired && identity?.csrfToken !== token ? undefined
              : expired ? '登录已失效，请重新登录后同步。' : '暂时无法同步，修改已保留在本机。';
          } else if (!remote || remote.section !== section || remote.revision <= expectedRevision || !same(remote.value, value) || !relatedConfirmed) {
            entry.error = '同步结果无法确认，修改已保留，重试前将核对云端。';
          } else {
            entry.base = remote;
            entry.error = undefined;
            if (entry.edit === edit) { entry.dirty = false; delete entry.local; }
            if (clearsChat) {
              for (const tombstone of related) {
                const associated = entryFor(doctorData(doctor), tombstone!.section);
                const previous = relatedBefore!.get(tombstone!.section as typeof chatSections[number])!;
                // The explicit privacy operation deletes saved history. Preserve
                // only nonempty edits made after this request started, such as a
                // new message after the user re-enabled saving while it ran.
                const discard = associated.edit === previous.edit || !associated.dirty || associated.local === null
                  || (Array.isArray(associated.local) && associated.local.length === 0);
                associated.base = tombstone!;
                associated.conflict = undefined;
                associated.error = undefined;
                if (discard) { associated.dirty = false; delete associated.local; }
                else associated.dirty = !same(associated.local, tombstone!.value);
              }
            }
          }
        } catch {
          if (!current(generation)) return;
          entry.error = '网络暂不可用，修改已保留在本机，恢复连接后可重试。';
        } finally {
          if (current(generation)) { entry.saving = false; persist(); emit(); }
        }
      }
    }).finally(() => {
      if (worker === task) { worker = undefined; schedule(); }
    });
    worker = task;
  }
  async function load(doctor: string) {
    if (!identity) return;
    const data = doctorData(doctor);
    if (data.loading) return data.loading;
    const generation = epoch;
    const signal = controller.signal;
    // Pause new writes for this doctor and finish the current write before reading its revision.
    const previousWrite = worker;
    const task = Promise.resolve().then(async () => {
      if (previousWrite) await previousWrite;
      if (!current(generation)) return;
      try {
        const { response, body } = await readDocuments(doctor, signal);
        if (!current(generation)) return;
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? '登录已失效，请重新登录后同步。' : '暂时无法读取云端数据。');
        if (!object(body) || !Array.isArray(body.documents)) throw new Error('云端数据格式异常，尚未进行覆盖。');
        const remote = new Map<ConsumerSection, CloudDocument>();
        for (const value of body.documents) {
          const parsed = document(value);
          if (!parsed || remote.has(parsed.section)) throw new Error('云端数据格式异常，尚未进行覆盖。');
          remote.set(parsed.section, parsed);
        }
        for (const section of consumerSections) {
          const entry = entryFor(data, section);
          const cloud = remote.get(section) ?? empty(section).base;
          // A delayed/replicated GET must never roll back an acknowledged revision.
          if (cloud.revision < entry.base.revision) continue;
          if (!entry.dirty || same(entry.local, cloud.value)) {
            entry.base = cloud; entry.dirty = false; delete entry.local; entry.conflict = undefined; entry.error = undefined;
          } else if (entry.base.revision !== cloud.revision) {
            entry.conflict = cloud; entry.error = '其他设备已更新这份数据，请选择要保留的版本。';
          } else {
            entry.error = undefined;
          }
        }
        data.known = true; data.checked = true; data.error = undefined;
      } catch (error) {
        if (!current(generation)) return;
        data.checked = false;
        data.error = error instanceof Error && error.message !== 'Failed to fetch' ? error.message : '网络暂不可用，请恢复连接后重试。';
      } finally {
        if (current(generation)) { data.loading = undefined; persist(); emit(); schedule(); }
      }
    });
    data.loading = task;
    emit();
    return task;
  }
  async function flush() {
    const generation = epoch;
    schedule();
    while (current(generation)) {
      const pending = [...doctors.values()].flatMap(data => data.loading ? [data.loading] : []);
      if (worker) pending.push(worker);
      if (!pending.length) break;
      await Promise.all(pending);
      schedule();
    }
  }
  return {
    setIdentity(next: ConsumerIdentity | null) {
      if (next?.userId === identity?.userId && next?.csrfToken === identity?.csrfToken) return;
      if (next && identity?.userId === next.userId) {
        identity = { ...next };
        emit(); schedule();
        return;
      }
      persist();
      controller.abort(); controller = new AbortController(); epoch += 1;
      identity = next ? { ...next } : null;
      doctors = new Map(); worker = undefined;
      if (identity) hydrate(identity.userId);
      emit();
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getVersion: () => version,
    get<T>(doctor: string, section: ConsumerSection, fallback: T): ConsumerDataState<T> {
      const data = doctors.get(doctor);
      const entry = data?.entries.get(section);
      const value = entry?.dirty ? entry.local : entry?.base.value;
      const status: ConsumerDataStatus = !identity ? 'idle' : entry?.conflict ? 'conflict' : entry?.saving ? 'saving'
        : data?.loading ? 'loading' : entry?.error || data?.error ? data?.known ? 'offline' : 'error'
          : entry?.dirty ? 'pending' : data?.checked ? 'synced' : 'idle';
      return { value: value == null ? fallback : value as T, status, revision: data?.known ? entry?.base.revision ?? 0 : null,
        canEdit: Boolean(identity && data?.known), ...(entry?.error || data?.error ? { error: entry?.error || data?.error } : {}),
        ...(entry?.conflict ? { cloudValue: entry.conflict.value == null ? fallback : entry.conflict.value as T, cloudRevision: entry.conflict.revision } : {}) };
    },
    load,
    set(doctor: string, section: ConsumerSection, value: unknown): boolean {
      if (!identity || !sectionSet.has(section) || !doctors.get(doctor)?.known || value === undefined) return false;
      const data = doctorData(doctor);
      const entry = entryFor(data, section);
      const local = copy(value);
      entry.local = local; entry.edit += 1;
      entry.dirty = Boolean(entry.saving || entry.conflict || !same(local, entry.base.value));
      if (!entry.conflict) entry.error = undefined;
      if (!entry.dirty) delete entry.local;
      persist(); emit(); schedule();
      return true;
    },
    async retry(doctor: string, section: ConsumerSection) {
      if (!sectionSet.has(section)) return;
      await load(doctor);
      await flush();
    },
    async resolveConflict(doctor: string, section: ConsumerSection, choice: 'cloud' | 'local') {
      const entry = doctors.get(doctor)?.entries.get(section);
      if (!identity || !entry?.conflict) return;
      entry.base = entry.conflict; entry.conflict = undefined; entry.error = undefined; entry.edit += 1;
      if (choice === 'cloud') { entry.dirty = false; delete entry.local; }
      persist(); emit(); schedule();
      await flush();
    },
    flush,
    clearLocal(userId: string) {
      try { storage?.removeItem(cachePrefix + encodeURIComponent(userId)); } catch { /* storage may be unavailable */ }
    },
  };
}

export const consumerDataStore = createConsumerDataStore();
