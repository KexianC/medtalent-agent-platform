import { useCallback, useEffect, useState } from "react";
import { DEFAULT_COMPONENTS } from "../lib/agentBuilder.ts";
import type { DoctorProfile } from "../data/doctorProfiles";

export type PublishedContent = {
  id: string;
  type: "article" | "faq" | "notice" | "service";
  title: string;
  summary?: string;
  body: string;
  publishedAt?: string;
  updatedAt?: string;
};

export type PublicDoctorProfile = DoctorProfile & {
  welcomeMessage?: string;
  version?: number | string;
  citationsEnabled?: boolean;
  healthContextEnabled?: boolean;
  preview?: boolean;
  draftHash?: string;
};

export type PublicDoctorDetail = PublicDoctorProfile & { content: PublishedContent[] };

type ResourceState<T> = {
  key: string;
  data: T | null;
  loading: boolean;
  error: string;
  notFound: boolean;
};

const stringValue = (value: unknown) => typeof value === "string" ? value : "";
const stringList = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Public responses are normalized without importing the bundled seed directory. */
export function safePortraitUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (/^\/media\/avatars\/[a-f0-9]{24}$/.test(value)) return value;
  if (/^\/assets\/[a-zA-Z0-9_./-]+$/.test(value) && !value.includes('..')) return value;
  try { const url=new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? value : undefined; } catch { return undefined; }
}
export function parsePublicDoctor(value: unknown): PublicDoctorProfile {
  if (!value || typeof value !== "object") throw new Error("智能体资料格式不正确，请稍后重试。");
  const item = value as Record<string, unknown>;
  if (!stringValue(item.slug) || !stringValue(item.name)) throw new Error("智能体资料不完整，请稍后重试。");
  return {
    slug: stringValue(item.slug),
    name: stringValue(item.name),
    portrait: safePortraitUrl(item.portrait),
    portraitPosition: stringValue(item.portraitPosition) || undefined,
    portraitScale: typeof item.portraitScale === "number" ? item.portraitScale : undefined,
    portraitTranslateY: stringValue(item.portraitTranslateY) || undefined,
    portraitBackground: stringValue(item.portraitBackground) || undefined,
    portraitTransformOrigin: stringValue(item.portraitTransformOrigin) || undefined,
    hospital: stringValue(item.hospital),
    department: stringValue(item.department),
    title: stringValue(item.title),
    specialty: stringValue(item.specialty),
    intro: stringValue(item.intro),
    accent: stringValue(item.accent) || "#4e988f",
    accentSoft: stringValue(item.accentSoft) || "#eaf5ef",
    quickQuestions: stringList(item.quickQuestions),
    topics: stringList(item.topics),
    services: stringList(item.services),
    articles: Array.isArray(item.articles) ? item.articles.flatMap((article) => {
      if (!article || typeof article !== "object" || typeof article.id !== "string" || typeof article.title !== "string") return [];
      return [{ id: article.id, title: article.title, summary: stringValue(article.summary), tag: stringValue(article.tag), readTime: stringValue(article.readTime) }];
    }) : [],
    citationsEnabled: item.citationsEnabled === undefined ? undefined : item.citationsEnabled === true,
    healthContextEnabled: item.healthContextEnabled === undefined ? undefined : item.healthContextEnabled === true,
    builder: item.builder as DoctorProfile["builder"],
    preview: item.preview === true,
    draftHash: stringValue(item.draftHash) || undefined,
    welcomeMessage: stringValue(item.welcomeMessage) || undefined,
    version: typeof item.version === "number" || typeof item.version === "string" ? item.version : undefined,
  };
}

export function parsePublishedContent(value: unknown): PublishedContent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (item.status !== undefined && item.status !== "published") return [];
    if (!stringValue(item.id) || !stringValue(item.title) || !["article", "faq", "notice", "service"].includes(stringValue(item.type))) return [];
    return [{
      id: stringValue(item.id),
      type: item.type as PublishedContent["type"],
      title: stringValue(item.title),
      summary: stringValue(item.summary) || undefined,
      body: stringValue(item.body) || stringValue(item.content) || stringValue(item.text),
      publishedAt: stringValue(item.publishedAt) || undefined,
      updatedAt: stringValue(item.updatedAt) || undefined,
    }];
  });
}

export const parsePublicDirectory = (value: unknown) => {
  if (!Array.isArray(value)) throw new Error("智能体目录格式不正确，请稍后重试。");
  return value.map(parsePublicDoctor);
};

export const parsePublicDoctorDetail = (value: unknown): PublicDoctorDetail => ({
  ...parsePublicDoctor(value),
  content: parsePublishedContent((value as Record<string, unknown>).content),
});

function usePublicResource<T>(url: string, parse: (value: unknown) => T) {
  const [attempt, setAttempt] = useState(0);
  const key = `${url}:${attempt}`;
  const [state, setState] = useState<ResourceState<T>>({ key, data: null, loading: true, error: "", notFound: false });
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ key, data: null, loading: true, error: "", notFound: false });
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" }, cache: "no-store" });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const error = body && typeof body === "object" && "error" in body ? stringValue(body.error) : "";
          if (!controller.signal.aborted) setState({ key, data: null, loading: false, error: error || (response.status === 404 ? "该智能体不存在或已下线。" : "暂时无法加载智能体，请重试。"), notFound: response.status === 404 });
          return;
        }
        const data = parse(body);
        if (!controller.signal.aborted) setState({ key, data, loading: false, error: "", notFound: false });
      } catch (error) {
        if (!controller.signal.aborted) setState({ key, data: null, loading: false, error: error instanceof TypeError ? "无法连接服务，请检查网络后重试。" : error instanceof Error ? error.message : "加载失败，请重试。", notFound: false });
      }
    })();
    return () => controller.abort();
  }, [key, parse, url]);

  // Route changes must never briefly expose a previously loaded, now-unrelated agent.
  const current = state.key === key ? state : { key, data: null, loading: true, error: "", notFound: false };
  return { ...current, retry };
}

export function useDoctorDirectory() {
  const resource = usePublicResource("/api/doctors", parsePublicDirectory);
  return { ...resource, doctors: resource.data ?? [] };
}

export function usePublishedDoctor(slug?: string) {
  const resource = usePublicResource(`/api/doctors/${encodeURIComponent(slug || "")}`, parsePublicDoctorDetail);
  return { ...resource, doctor: resource.data };
}

/** Private, authenticated draft data; never fall back to a published resource. */
export function parseDraftDoctorDetail(value: unknown): PublicDoctorDetail {
  const body = value as Record<string, unknown>;
  if (!body || typeof body !== 'object' || body.preview !== true || !body.agent || typeof body.agent !== 'object') throw new Error('草稿预览数据无效，请返回后台重新打开。');
  const agent = body.agent as Record<string, unknown>;
  const config = agent.config && typeof agent.config === "object" ? agent.config as Record<string, unknown> : {};
  const contents = Array.isArray(body.contents) ? body.contents : [];
  return { ...parsePublicDoctor({ ...agent, welcomeMessage: config.welcomeMessage ?? agent.welcomeMessage, healthContextEnabled: config.healthContextEnabled ?? agent.healthContextEnabled, citationsEnabled: config.requireCitations === undefined ? agent.citationsEnabled : config.requireCitations !== false, preview: true, draftHash: body.draftHash }), content: parsePublishedContent(contents.map(item => ({ ...item, status: 'published' }))) };
}
export function parseTemplatePreviewDetail(templateId: string, session: unknown, storedValue: string | null, referenceTime = Date.now()): PublicDoctorDetail {
    if (!session || typeof session !== "object" || !(session as {user?:unknown}).user) throw new Error("请先登录后台再预览模板。");
    const stored = JSON.parse(storedValue || "null");
    if (!stored || typeof stored.ownerId !== "string" || !stored.ownerId || stored.ownerId !== (session as {user:{id?:unknown}}).user.id) throw new Error("模板预览账户已变化，请从模板库重新打开。");
    if (!stored || typeof stored.expiresAt !== "number" || stored.expiresAt < referenceTime || stored.expiresAt > referenceTime + 10 * 60000) throw new Error("模板预览已过期，请返回模板库重新打开。");
    const payload=stored.payload,agent=payload?.agent;
    if (!agent || payload.templateId !== templateId) throw new Error("模板预览数据不匹配。");
    return parseDraftDoctorDetail({...payload,agent:{...agent,slug:"template~"+templateId,builder:{...(agent.builder||{schemaVersion:1,components:DEFAULT_COMPONENTS,recordFields:[],assessments:[],servicePlans:[],requiresReview:true}),dataPermissions:{records:"read-only",assessments:"read-only",services:"read-only"},voice:{...agent.builder?.voice,enabled:false}}}});
}
export function useDoctorResource(slug?: string, preview = false, templateId?: string) {
  const parseTemplate = useCallback((session: unknown) => { const key="agent-template-preview:"+templateId;try{return parseTemplatePreviewDetail(templateId || "", session, window.sessionStorage.getItem(key));}catch(error){window.sessionStorage.removeItem(key);throw error;} }, [templateId]);
  const url = preview ? '/api/admin/agents/' + encodeURIComponent(slug || '') + '/preview' : '/api/doctors/' + encodeURIComponent(slug || '');
  const resource = usePublicResource(templateId ? "/api/admin/session" : url, templateId ? parseTemplate : preview ? parseDraftDoctorDetail : parsePublicDoctorDetail);
  return { ...resource, doctor: resource.data };
}
