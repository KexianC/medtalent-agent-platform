import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import type { ChatRetrievalMetadata } from "../lib/chatStream";
import { useConsumerSession } from './useConsumerSession';
import { consumerDataStore, type ConsumerSection, type ConsumerDataStatus } from '../lib/consumerData';
import { getConsumerSession } from '../lib/consumerSession';
import { useDoctorTemplatePreview, useDoctorPreview, previewStorageSlug } from './doctorPreview';
export { DoctorPreviewContext, useDoctorPreview, previewStorageSlug } from './doctorPreview';

export type DoctorChatMessage = ChatRetrievalMetadata & {
  id: string;
  role: "assistant" | "user";
  text: string;
  createdAt: string;
  error?: boolean;
  retryText?: string;
  inputMode?: "voice";
  voiceDurationSeconds?: number;
};

export type DoctorFavorite = {
  id: string;
  text: string;
  createdAt: string;
};

export type DoctorHealthMetrics = {
  sleepDurationMinutes?: number;
  sleepLatencyMinutes?: number;
  nightAwakenings?: number;
  moodScore?: number;
  anxietyScore?: number;
  energyScore?: number;
  daytimeImpactScore?: number;
  safetyConcern?: boolean;
};

export type DoctorHealthRecord = {
  schemaVersion?: 2;
  id: string;
  createdAt: string;
  updatedAt?: string;
  dateKey?: string;
  completedTitles: string[];
  note?: string;
  source: "home" | "manage";
  metrics?: DoctorHealthMetrics;
  measurements?: Record<string, number>;
  values?: Record<string, string>;
};

export type DoctorDailyTasks = {
  dateKey: string;
  completed: boolean[];
};

export type DoctorPrivacySettings = {
  saveChat: boolean;
  voicePlayback: boolean;
  reminders: boolean;
};

const cloneFallback = <T,>(fallback: T): T => {
  if (typeof structuredClone === "function") return structuredClone(fallback);
  return JSON.parse(JSON.stringify(fallback)) as T;
};

export type DoctorPersistenceStatus = "ready" | "memory-only" | "error";

export type DoctorPersistenceErrorCode =
  | "STORAGE_UNAVAILABLE"
  | "INVALID_DATA"
  | "WRITE_FAILED"
  | "SERIALIZE_FAILED";

export type DoctorPersistenceMeta = {
  storage?: 'local' | 'cloud';
  cloudStatus?: ConsumerDataStatus;
  status: DoctorPersistenceStatus;
  errorCode?: DoctorPersistenceErrorCode;
  retry: () => void;
};

type StoredReadResult<T> = {
  value: T;
  status: DoctorPersistenceStatus;
  errorCode?: DoctorPersistenceErrorCode;
  blockAutomaticWrite: boolean;
};

const visitorStorageKey = "medtalent:visitor-id";
let memoryVisitorId = "";

const createVisitorId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `guest-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

export const getDoctorVisitorId = () => {
  if (typeof window === "undefined") return "server";
  try {
    const stored = window.localStorage.getItem(visitorStorageKey);
    if (stored) return (memoryVisitorId = stored);
    const next = createVisitorId();
    window.localStorage.setItem(visitorStorageKey, next);
    return (memoryVisitorId = next);
  } catch {
    if (memoryVisitorId) return memoryVisitorId;
    try {
      const stored = window.sessionStorage.getItem(visitorStorageKey);
      if (stored) return (memoryVisitorId = stored);
      const next = createVisitorId();
      window.sessionStorage.setItem(visitorStorageKey, next);
      return (memoryVisitorId = next);
    } catch {
      return (memoryVisitorId = createVisitorId());
    }
  }
};

const readValue = <T,>(key: string, fallback: T, legacyKey?: string): StoredReadResult<T> => {
  if (typeof window === "undefined") {
    return {
      value: cloneFallback(fallback),
      status: "memory-only",
      errorCode: "STORAGE_UNAVAILABLE",
      blockAutomaticWrite: true,
    };
  }
  try {
    const currentRaw = window.localStorage.getItem(key);
    const legacyRaw = currentRaw === null && legacyKey ? window.localStorage.getItem(legacyKey) : null;
    const raw = currentRaw ?? legacyRaw;
    if (raw === null) {
      return { value: cloneFallback(fallback), status: "ready", blockAutomaticWrite: false };
    }

    let value: T;
    try {
      value = JSON.parse(raw) as T;
    } catch {
      return {
        value: cloneFallback(fallback),
        status: "error",
        errorCode: "INVALID_DATA",
        blockAutomaticWrite: true,
      };
    }

    if (legacyRaw !== null && legacyKey) {
      try {
        window.localStorage.setItem(key, legacyRaw);
        window.localStorage.removeItem(legacyKey);
      } catch {
        return { value, status: "memory-only", errorCode: "WRITE_FAILED", blockAutomaticWrite: true };
      }
    }

    return { value, status: "ready", blockAutomaticWrite: false };
  } catch {
    return {
      value: cloneFallback(fallback),
      status: "memory-only",
      errorCode: "STORAGE_UNAVAILABLE",
      blockAutomaticWrite: true,
    };
  }
};

const legacyDoctorStorageKey = (doctorSlug: string, section: string) => `medtalent:${doctorSlug}:${section}`;

export const doctorStorageKey = (doctorSlug: string, section: string) => `medtalent:${getConsumerSession().user?.id || getDoctorVisitorId()}:${doctorSlug}:${section}`;

export const doctorSessionKey = (doctorSlug: string, section: string) => `medtalent:session:${getConsumerSession().user?.id || getDoctorVisitorId()}:${doctorSlug}:${section}`;

export const localDateKey = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const clearCurrentVisitorData = () => {
  if (typeof window === "undefined") return;
  const visitorId = getDoctorVisitorId();
  const localPrefix = `medtalent:${visitorId}:`;
  const sessionPrefix = `medtalent:session:${visitorId}:`;
  const next = createVisitorId();
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key && (key.startsWith(localPrefix) || (/^medtalent:[^:]+:[^:]+$/.test(key) && key !== visitorStorageKey))) {
        window.localStorage.removeItem(key);
      }
    }
    window.localStorage.setItem(visitorStorageKey, next);
  } catch { /* 继续轮换会话内游客身份。 */ }
  try {
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(sessionPrefix)) window.sessionStorage.removeItem(key);
    }
    window.sessionStorage.setItem(visitorStorageKey, next);
  } catch {
    // 受限 WebView 中 sessionStorage 也可能不可用。
  }
  memoryVisitorId = next;
};

export const createLocalId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function useDoctorGuestState<T>(
  doctorSlug: string,
  section: string,
  fallback: T,
  persist = true,
  enabled = true,
): [T, Dispatch<SetStateAction<T>>, DoctorPersistenceMeta] {
  const visitorId = getDoctorVisitorId();
  const key = useMemo(() => `medtalent:${visitorId}:${doctorSlug}:${section}`, [doctorSlug, section, visitorId]);
  const legacyKey = useMemo(() => doctorSlug.startsWith("preview~") ? undefined : legacyDoctorStorageKey(doctorSlug, section), [doctorSlug, section]);
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const initialReadRef = useRef<{ key: string; result: StoredReadResult<T> }>();
  if (!initialReadRef.current) initialReadRef.current = { key, result: enabled ? readValue(key, fallback, legacyKey) : { value: cloneFallback(fallback), status: 'ready', blockAutomaticWrite: false } };
  const [value, setStoredValue] = useState<T>(() => initialReadRef.current!.result.value);
  const [persistenceState, setPersistenceState] = useState<Omit<DoctorPersistenceMeta, "retry">>(() => ({
    status: initialReadRef.current!.result.status,
    errorCode: initialReadRef.current!.result.errorCode,
  }));
  const loadedKeyRef = useRef(initialReadRef.current.key);
  const blockAutomaticWriteRef = useRef(initialReadRef.current.result.blockAutomaticWrite);
  const requiresExplicitRetryRef = useRef(initialReadRef.current.result.errorCode === "INVALID_DATA");
  const suppressNextWriteRef = useRef(false);

  const applyReadResult = useCallback((result: StoredReadResult<T>) => {
    blockAutomaticWriteRef.current = result.blockAutomaticWrite;
    requiresExplicitRetryRef.current = result.errorCode === "INVALID_DATA";
    suppressNextWriteRef.current = true;
    setStoredValue(result.value);
    setPersistenceState({ status: result.status, errorCode: result.errorCode });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (loadedKeyRef.current === key) return;
    loadedKeyRef.current = key;
    applyReadResult(readValue(key, fallbackRef.current, legacyKey));
  }, [applyReadResult, key, legacyKey, enabled]);

  const setValue = useCallback<Dispatch<SetStateAction<T>>>((nextValue) => {
    if (!requiresExplicitRetryRef.current) blockAutomaticWriteRef.current = false;
    suppressNextWriteRef.current = false;
    setStoredValue(nextValue);
  }, []);

  const persistValue = useCallback((nextValue: T) => {
    if (!enabled) return true;
    try {
      if (persist) {
        const serialized = JSON.stringify(nextValue);
        if (typeof serialized !== "string") {
          setPersistenceState({ status: "memory-only", errorCode: "SERIALIZE_FAILED" });
          return false;
        }
        window.localStorage.setItem(key, serialized);
      } else {
        window.localStorage.removeItem(key);
      }
      setPersistenceState({ status: "ready" });
      return true;
    } catch {
      setPersistenceState({ status: "memory-only", errorCode: "WRITE_FAILED" });
      return false;
    }
  }, [key, persist, enabled]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (loadedKeyRef.current !== key || blockAutomaticWriteRef.current) return;
    if (suppressNextWriteRef.current) {
      suppressNextWriteRef.current = false;
      return;
    }
    // WebView 隐私模式下写入可能失败，但数据仍保留在当前 React 会话中。
    persistValue(value);
  }, [key, persistValue, value]);

  const retry = useCallback(() => {
    requiresExplicitRetryRef.current = false;
    blockAutomaticWriteRef.current = false;
    suppressNextWriteRef.current = false;
    persistValue(value);
  }, [persistValue, value]);

  useEffect(() => {
    if (!enabled) return;
    const syncVisitor = (event: StorageEvent) => {
      if (event.key === visitorStorageKey && event.newValue && event.newValue !== visitorId) window.location.reload();
    };
    const syncStoredValue = (event: StorageEvent) => {
      if (event.key !== key) return;
      loadedKeyRef.current = key;
      applyReadResult(readValue(key, fallbackRef.current));
    };
    window.addEventListener("storage", syncVisitor);
    window.addEventListener("storage", syncStoredValue);
    return () => {
      window.removeEventListener("storage", syncVisitor);
      window.removeEventListener("storage", syncStoredValue);
    };
  }, [applyReadResult, key, visitorId, enabled]);

  const persistenceMeta = useMemo<DoctorPersistenceMeta>(() => ({
    storage: 'local',
    ...persistenceState,
    retry,
  }), [persistenceState, retry]);

  return [value, setValue, persistenceMeta];
}

export function useDoctorLocalState<T>(doctorSlug: string, section: string, fallback: T, persist = true): [T, Dispatch<SetStateAction<T>>, DoctorPersistenceMeta] {
  const preview = useDoctorPreview();
  const templatePreview = useDoctorTemplatePreview();
  const storageSlug = preview ? previewStorageSlug(doctorSlug) : doctorSlug;
  const session = useConsumerSession();
  useSyncExternalStore(consumerDataStore.subscribe, consumerDataStore.getVersion, consumerDataStore.getVersion);
  const signedIn = !preview && Boolean(session.user);
  const ownerId = session.user?.id;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const guest = useDoctorGuestState(storageSlug, section, fallback, persist, !signedIn && !templatePreview);
  const snapshot = consumerDataStore.get<T>(doctorSlug, section as ConsumerSection, fallback);
  const current = useRef(snapshot.value);
  current.current = snapshot.value;
  const setCloud = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    if (!mounted.current || !ownerId || getConsumerSession().user?.id !== ownerId) return;
    const value = typeof next === 'function' ? (next as (previous: T) => T)(current.current) : next;
    if (consumerDataStore.set(doctorSlug, section as ConsumerSection, value)) current.current = value;
  }, [doctorSlug, section, ownerId]);
  useEffect(() => {
    if (signedIn && !persist && snapshot.canEdit && snapshot.revision !== null && snapshot.value !== fallback) {
      const raw = consumerDataStore.get(doctorSlug, section as ConsumerSection, null);
      if (raw.value !== null) consumerDataStore.set(doctorSlug, section as ConsumerSection, null);
    }
  }, [doctorSlug, section, signedIn, persist, snapshot.canEdit, snapshot.revision, snapshot.value, fallback]);
  const meta: DoctorPersistenceMeta = {
    storage: 'cloud', cloudStatus: snapshot.status,
    status: snapshot.status === 'synced' ? 'ready' : snapshot.status === 'conflict' || snapshot.status === 'error' ? 'error' : 'memory-only',
    ...(snapshot.status === 'synced' ? {} : { errorCode: 'WRITE_FAILED' as const }),
    retry: () => { void consumerDataStore.retry(doctorSlug, section as ConsumerSection); },
  };
  return signedIn && persist ? [snapshot.value, setCloud, meta] : guest;
}
