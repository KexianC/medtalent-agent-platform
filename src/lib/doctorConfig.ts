import { SPECIALTY_FIELD_KEYS } from "../data/specialtyRecordFields.ts";
import { DEFAULT_COMPONENTS, type BuilderComponentId } from "./agentBuilder.ts";
import { noticeLines } from "../data/doctorCustomData.ts";
import type { Article } from "../data/doctorProfiles.ts";
import type { DoctorVideo } from "../data/doctorCustomData.ts";

type ModuleBase<Id extends string> = { [Key in Id]: { id: Key; enabled: boolean; order: number } }[Id];
/** 保留 v1 的八个 ID；日记建议和复诊摘要仅在 v2 扩展，不修改搭建器。 */
export type DoctorModule =
  | ModuleBase<Exclude<BuilderComponentId, "records" | "voice">>
  | (ModuleBase<"records"> & { variant?: "standard" | "sleep-mood-function" | "legacy" })
  | (ModuleBase<"voice"> & { autoPlay?: "off" | "voice-only" | "text-and-voice"; hint?: string; requirePlaybackOptIn?: boolean })
  | ModuleBase<"diaryAdvice">
  | (ModuleBase<"visitSummary"> & { days?: number; numbersOnly?: boolean });

export type DoctorConfig = {
  schemaVersion: 2;
  slug: string;
  template: "general" | "tcm" | "mingzhongyi";
  status: "draft" | "review" | "online";
  profile: {
    name: string; hospital: string; department: string; displayDepartment: string; title: string;
    tags: string[]; specialty: string; topics: string[]; portrait: string; portraitPosition?: string;
    introPhoto?: string; career?: string; academic?: string[]; achievements?: string[];
    bookingDepartments: { campus: string; department: string; hospital?: string }[];
    clinics: { campus: string; times: string[]; image?: string }[];
    expertSections: { title: string; body: string }[];
    verified: boolean;
  };
  theme: { accent: string; accentSoft: string; homeStyle: "standard" | "tang-home"; heroArtwork?: "standard" | "growth" };
  home: { heroTitle: string; showNotice: boolean; quickQuestions: string[]; knowledgeFocus?: string; startHint?: string; showStartCard?: boolean; resourcesCollapsed?: boolean; showExpertNote?: boolean };
  chat: {
    title: string; aiLabel: string; showAiLabel?: boolean; showTagline?: boolean; replyFooter?: boolean;
    citations: { enabled: boolean; hideWhenEmpty?: boolean; style?: "standard" | "tang" };
    welcomeMessage?: string; demoReplyWhenModelMissing?: boolean; demoReplyStyle?: "mental" | "ent"; quickQuestions?: string[];
  };
  modules: DoctorModule[];
  services: {
    intro?: string; groups: { title: string; items: string[] }[]; off: string[]; showPlanStatus?: boolean;
    /** 服务计划内的自评入口及分享说明，对应第四节最后一行。 */
    assessmentPrompt?: string; shareHint?: string; preparation?: string[]; showBoundaryTagline?: boolean;
  };
  records: {
    placeholder?: string; steps: string[]; privacyHint?: string; specialty?: { title: string; description: string; fieldKeys: string[] }; exportPrefix?: string; accountHint?: string; assessmentLabel?: string;
    askWithRecords?: { label: string; prompt: string; share: "summary" | "none" };
  };
  content: { articles: (string | Article)[]; videos: DoctorVideo[]; videoPlaceholders?: string[] };
  /** 空对象表示平台默认；显式配置只能保留默认保护、追加规则和热线。 */
  safety: {
    enabled?: true; crisisCard?: true; showHotlinesInBoundary?: true;
    noticeLines?: string[]; hotlines?: string[]; extraRules?: string[];
  };
  knowledgeBase: { id: string; source: string; status: string };
};

const fail = (message: string): never => { throw new Error(message); };
const object = (input: unknown, keys: readonly string[], name: string): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Reflect.ownKeys(input).some(key => typeof key !== "string" || !keys.includes(key))) {
    fail(name + "含不支持的字段或格式无效。");
  }
  return input as Record<string, unknown>;
};
const str = (input: unknown, name: string, max = 2000, required = false): string => {
  if (input === undefined && !required) return "";
  // eslint-disable-next-line no-control-regex -- 与 v1 一致：允许制表符和换行，拒绝其他 ASCII 控制字符。
  if (typeof input !== "string" || input.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input)) fail(name + "格式无效或文字过长。");
  const value = (input as string).trim();
  if (required && !value) fail(name + "不能为空。");
  return value;
};
const bool = (input: unknown, name: string, fallback: boolean): boolean => input === undefined ? fallback
  : typeof input === "boolean" ? input : fail(name + "须为布尔值。");
const list = (input: unknown, name: string, max = 100): unknown[] => input === undefined ? []
  : Array.isArray(input) && input.length <= max ? Array.from(input) : fail(name + "须为数组，最多支持 " + max + " 项。");
const strings = (input: unknown, name: string, max = 100, length = 2000): string[] => list(input, name, max).map(item => str(item, name, length, true));
const choice = <T extends string>(input: unknown, allowed: readonly T[], name: string, fallback: T): T => input === undefined ? fallback
  : typeof input === "string" && (allowed as readonly string[]).includes(input) ? input as T : fail(name + "无效。");
const integer = (input: unknown, name: string, min: number, max: number, fallback: number): number => input === undefined ? fallback
  : typeof input === "number" && Number.isInteger(input) && input >= min && input <= max ? input : fail(name + "须为 " + min + " 至 " + max + " 的整数。");
const unique = <T>(items: T[], key: (item: T) => string, name: string): T[] => {
  if (new Set(items.map(key)).size !== items.length) fail(name + "不能重复。");
  return items;
};
const textOption = <K extends string>(input: Record<string, unknown>, key: K, name: string, max = 2000): Partial<Record<K, string>> =>
  input[key] === undefined ? {} : { [key]: str(input[key], name, max) } as Record<K, string>;
const boolOption = <K extends string>(input: Record<string, unknown>, key: K, name: string): Partial<Record<K, boolean>> =>
  input[key] === undefined ? {} : { [key]: bool(input[key], name, false) } as Record<K, boolean>;

// 复用 doctorCustom.ts 的使用前说明；号码沿用 server/chat-core.mjs 的
// CRISIS_SUPPORT_REPLY（120、110、全国统一心理援助热线 12356）。该模块不引入服务端运行依赖。
const PLATFORM_NOTICES: readonly string[] = Object.freeze([...noticeLines]);
const PLATFORM_HOTLINES: readonly string[] = Object.freeze(["120", "110", "12356"]);

function normalizeSafety(input: unknown): DoctorConfig["safety"] {
  const value = object(input, ["enabled", "noticeLines", "crisisCard", "hotlines", "showHotlinesInBoundary", "extraRules"], "安全配置（必须存在）");
  for (const key of ["enabled", "crisisCard", "showHotlinesInBoundary"]) {
    if (value[key] !== undefined && value[key] !== true) fail("安全模块不能关闭或削弱：" + key + " 必须为 true。");
  }
  // 默认说明不得被替换、删减或重排；额外规则统一通过 extraRules 追加。
  if (value.noticeLines !== undefined) {
    const supplied = strings(value.noticeLines, "安全说明", 10);
    if (supplied.length !== PLATFORM_NOTICES.length || supplied.some((line, i) => line !== PLATFORM_NOTICES[i])) {
      fail("平台安全说明不能修改或删减，请使用 extraRules 追加安全规则。");
    }
  }
  const hotlines = value.hotlines === undefined ? [...PLATFORM_HOTLINES] : unique(strings(value.hotlines, "安全热线", 20, 80), item => item, "安全热线");
  if (PLATFORM_HOTLINES.some(number => !hotlines.includes(number))) fail("安全热线不能为空，也不能删减平台默认热线。");
  return { enabled: true, crisisCard: true, showHotlinesInBoundary: true, noticeLines: [...PLATFORM_NOTICES], hotlines,
    extraRules: strings(value.extraRules, "追加安全规则", 50) };
}

const MODULE_IDS = [...DEFAULT_COMPONENTS.map(item => item.id), "diaryAdvice", "visitSummary"] as const;
function normalizeModules(input: unknown): DoctorModule[] {
  if (input === undefined) return DEFAULT_COMPONENTS.map(({ id, enabled, order }) => ({ id, enabled, order }));
  return unique(list(input, "模块", 10).map((entry, index): DoctorModule => {
    // 先读取 ID，再按各模块各自的选项白名单检查，避免拼错选项被静默忽略。
    const header = object(entry, ["id", "enabled", "order", "variant", "autoPlay", "hint", "requirePlaybackOptIn", "days", "numbersOnly"], "模块");
    if (!MODULE_IDS.includes(header.id as typeof MODULE_IDS[number])) fail("模块类型无效。");
    const id = header.id as typeof MODULE_IDS[number];
    const options = id === "records" ? ["variant"] : id === "voice" ? ["autoPlay", "hint", "requirePlaybackOptIn"] : id === "visitSummary" ? ["days", "numbersOnly"] : [];
    const value = object(entry, ["id", "enabled", "order", ...options], "模块 " + id);
    const base = { enabled: bool(value.enabled, "模块开关", true), order: integer(value.order, "模块顺序", 0, 100, index) };
    if (id === "records") return { ...base, id, ...(value.variant === undefined ? {} : { variant: choice(value.variant, ["standard", "sleep-mood-function", "legacy"] as const, "记录样式", "standard") }) };
    if (id === "voice") return { ...base, id,
      ...(value.autoPlay === undefined ? {} : { autoPlay: choice(value.autoPlay, ["off", "voice-only", "text-and-voice"] as const, "语音自动播报", "off") }),
      ...textOption(value, "hint", "语音提示"), ...boolOption(value, "requirePlaybackOptIn", "语音播报主动授权") };
    if (id === "visitSummary") return { ...base, id,
      ...(value.days === undefined ? {} : { days: integer(value.days, "复诊摘要天数", 1, 365, 30) }), ...boolOption(value, "numbersOnly", "仅列数字") };
    return { ...base, id };
  }), item => item.id, "模块标识");
}

/** 独立的 v2 校验入口，不读取、不迁移、不改变 schemaVersion 1 的配置。 */
export function normalizeDoctorConfig(input: unknown): DoctorConfig {
  const value = object(input, ["schemaVersion", "slug", "template", "status", "profile", "theme", "home", "chat", "modules", "services", "records", "content", "safety", "knowledgeBase"], "医生配置");
  if (value.schemaVersion !== 2) fail("医生配置版本必须为 2。");
  // 即使其他字段尚未填好，也优先检查安全块，避免缺失时悄悄补成启用。
  const safety = normalizeSafety(value.safety);
  const slug = str(value.slug, "医生标识", 80, true);
  if (!/^[a-z]+(?:-[a-z]+)*$/.test(slug)) fail("医生标识须为小写拼音，音节间使用连字符。");
  const profile = object(value.profile, ["name", "hospital", "department", "displayDepartment", "title", "tags", "specialty", "topics", "portrait", "portraitPosition", "introPhoto", "career", "academic", "achievements", "bookingDepartments", "clinics", "expertSections", "verified"], "医生资料");
  const theme = object(value.theme, ["accent", "accentSoft", "homeStyle", "heroArtwork"], "主题");
  const color = (input: unknown, name: string): string => {
    const value = str(input, name, 7, true);
    if (!/^#[0-9a-fA-F]{6}$/.test(value)) fail(name + "须为 #RRGGBB 颜色。");
    return value;
  };
  const home = object(value.home, ["heroTitle", "showNotice", "showStartCard", "resourcesCollapsed", "showExpertNote", "quickQuestions", "knowledgeFocus", "startHint"], "首页");
  const chat = object(value.chat, ["title", "showTagline", "showAiLabel", "aiLabel", "replyFooter", "citations", "welcomeMessage", "demoReplyWhenModelMissing", "demoReplyStyle", "quickQuestions"], "问答");
  const citations = object(chat.citations, ["enabled", "hideWhenEmpty", "style"], "出处");
  const services = object(value.services, ["intro", "groups", "off", "showPlanStatus", "assessmentPrompt", "shareHint", "preparation", "showBoundaryTagline"], "服务");
  const records = object(value.records, ["placeholder", "steps", "askWithRecords", "privacyHint", "specialty", "exportPrefix", "accountHint", "assessmentLabel"], "记录");
  let specialty: DoctorConfig["records"]["specialty"];
  if (records.specialty !== undefined) {
    const item = object(records.specialty, ["title", "description", "fieldKeys"], "专科记录");
    specialty = { title: str(item.title, "专科记录标题", 200, true), description: str(item.description, "专科记录说明"),
      fieldKeys: unique(strings(item.fieldKeys, "记录字段", 30, 80), key => key, "记录字段") };
    if (!specialty.fieldKeys.length || specialty.fieldKeys.some(key => !SPECIALTY_FIELD_KEYS.includes(key))) fail("专科记录字段无效。");
  }
  let askWithRecords: DoctorConfig["records"]["askWithRecords"];
  if (records.askWithRecords !== undefined) {
    const ask = object(records.askWithRecords, ["label", "prompt", "share"], "带记录咨询");
    askWithRecords = { label: str(ask.label, "咨询入口名称", 80, true), prompt: str(ask.prompt, "带记录咨询问法", 2000, true), share: choice(ask.share, ["summary", "none"] as const, "记录分享范围", "summary") };
  }
  const content = object(value.content, ["articles", "videos", "videoPlaceholders"], "科普内容");
  const kb = object(value.knowledgeBase, ["id", "source", "status"], "知识库");
  return {
    schemaVersion: 2, slug, template: choice(value.template, ["general", "tcm", "mingzhongyi"] as const, "页面模板", "general"),
    status: choice(value.status, ["draft", "review", "online"] as const, "配置状态", "draft"),
    profile: {
      name: str(profile.name, "医生姓名", 80, true), hospital: str(profile.hospital, "医院", 200), department: str(profile.department, "科室", 120),
      displayDepartment: str(profile.displayDepartment, "显示科室", 120), title: str(profile.title, "职称", 200),
      tags: strings(profile.tags, "医生标签", 30, 200), specialty: str(profile.specialty, "专长", 5000), topics: strings(profile.topics, "专业话题", 30, 200),
      portrait: str(profile.portrait, "头像地址"), ...textOption(profile, "portraitPosition", "头像位置", 80), ...textOption(profile, "introPhoto", "介绍图片"),
      ...textOption(profile, "career", "医生经历", 10000),
      ...(profile.academic === undefined ? {} : { academic: strings(profile.academic, "学术任职") }),
      ...(profile.achievements === undefined ? {} : { achievements: strings(profile.achievements, "成果") }),
      bookingDepartments: list(profile.bookingDepartments, "挂号科室").map(entry => {
        const item = object(entry, ["campus", "department", "hospital"], "挂号科室");
        return { campus: str(item.campus, "挂号院区", 200, true), department: str(item.department, "挂号科室", 200, true), ...textOption(item, "hospital", "挂号医院", 200) };
      }),
      clinics: list(profile.clinics, "门诊").map(entry => {
        const item = object(entry, ["campus", "times", "image"], "门诊");
        return { campus: str(item.campus, "门诊院区", 200, true), times: strings(item.times, "门诊时间", 30, 200), ...textOption(item, "image", "门诊图片") };
      }),
      expertSections: list(profile.expertSections, "专家介绍", 30).map(entry => {
        const item = object(entry, ["title", "body"], "专家介绍");
        return { title: str(item.title, "介绍标题", 200, true), body: str(item.body, "介绍内容", 10000, true) };
      }), verified: bool(profile.verified, "资料已核对", false),
    },
    theme: { accent: color(theme.accent, "主色"), accentSoft: color(theme.accentSoft, "浅色"), homeStyle: choice(theme.homeStyle, ["standard", "tang-home"] as const, "首页样式", "standard"),
      ...(theme.heroArtwork === undefined ? {} : { heroArtwork: choice(theme.heroArtwork, ["standard", "growth"] as const, "首页插图", "standard") }) },
    home: { heroTitle: str(home.heroTitle, "首页标题", 200), showNotice: bool(home.showNotice, "首页提示条", true), quickQuestions: strings(home.quickQuestions, "推荐问题", 4, 500),
      ...textOption(home, "knowledgeFocus", "知识库展示方向"), ...textOption(home, "startHint", "开始卡说明"), ...boolOption(home, "showStartCard", "开始卡"), ...boolOption(home, "resourcesCollapsed", "近期关注折叠"), ...boolOption(home, "showExpertNote", "专家寄语") },
    chat: { title: str(chat.title, "问答标题", 120, true), aiLabel: str(chat.aiLabel, "人工智能标识", 500, true),
      ...boolOption(chat, "showAiLabel", "显示人工智能标识"), ...boolOption(chat, "showTagline", "问答标语"), ...boolOption(chat, "replyFooter", "回复底栏"),
      citations: { enabled: bool(citations.enabled, "显示出处", true), ...boolOption(citations, "hideWhenEmpty", "无出处时隐藏"),
        ...(citations.style === undefined ? {} : { style: choice(citations.style, ["standard", "tang"] as const, "出处样式", "standard") }) },
      ...(chat.quickQuestions === undefined ? {} : { quickQuestions: strings(chat.quickQuestions, "问答推荐问题", 10, 500) }),
      ...(chat.demoReplyStyle === undefined ? {} : { demoReplyStyle: choice(chat.demoReplyStyle, ["mental", "ent"] as const, "演示回答样式", "mental") }),
      ...textOption(chat, "welcomeMessage", "欢迎语", 10000), ...boolOption(chat, "demoReplyWhenModelMissing", "未接模型演示") },
    modules: normalizeModules(value.modules),
    services: { ...textOption(services, "intro", "服务介绍"), off: strings(services.off, "关闭的服务", 100, 120),
      groups: list(services.groups, "服务分组", 30).map(entry => {
        const item = object(entry, ["title", "items"], "服务分组");
        return { title: str(item.title, "服务分组名称", 120, true), items: strings(item.items, "服务名称", 100, 120) };
      }), ...(services.preparation === undefined ? {} : { preparation: strings(services.preparation, "就诊准备", 20, 500) }),
      ...boolOption(services, "showBoundaryTagline", "服务边界标语"), ...boolOption(services, "showPlanStatus", "显示服务状态"), ...textOption(services, "assessmentPrompt", "服务计划自评问法"), ...textOption(services, "shareHint", "服务计划分享说明") },
    records: { ...(specialty === undefined ? {} : { specialty }), ...textOption(records, "exportPrefix", "记录导出前缀", 80),
      ...textOption(records, "accountHint", "账户保存说明"), ...textOption(records, "assessmentLabel", "自评名称", 80), steps: strings(records.steps, "记录步骤", 20, 500), ...textOption(records, "placeholder", "记录输入提示"), ...textOption(records, "privacyHint", "隐私说明"),
      ...(askWithRecords === undefined ? {} : { askWithRecords }) },
    content: {
      articles: list(content.articles, "科普文章").map(entry => {
        if (typeof entry === "string") return str(entry, "文章引用", 200, true);
        const item = object(entry, ["id", "title", "summary", "tag", "readTime"], "科普文章");
        return { id: str(item.id, "文章标识", 80, true), title: str(item.title, "文章标题", 200, true), summary: str(item.summary, "文章摘要", 5000), tag: str(item.tag, "文章标签", 80), readTime: str(item.readTime, "阅读时间", 80) };
      }),
      videos: list(content.videos, "科普视频").map(entry => {
        const item = object(entry, ["title", "url", "platform", "keywords"], "科普视频");
        return { title: str(item.title, "视频标题", 200, true), url: str(item.url, "视频地址"), platform: str(item.platform, "视频平台", 200), keywords: strings(item.keywords, "视频关键词", 30, 120) };
      }), ...(content.videoPlaceholders === undefined ? {} : { videoPlaceholders: strings(content.videoPlaceholders, "待提供视频", 100, 200) }),
    },
    safety, knowledgeBase: { id: str(kb.id, "知识库标识", 120, true), source: str(kb.source, "知识库来源", 500), status: str(kb.status, "知识库状态", 120, true) },
  };
}

/** 这是待填写的草稿；填入 slug 和姓名后再调用 normalizeDoctorConfig。 */
export const BLANK_DOCTOR_CONFIG: DoctorConfig = {
  schemaVersion: 2, slug: "", template: "general", status: "draft",
  profile: { name: "", hospital: "", department: "", displayDepartment: "", title: "", tags: [], specialty: "", topics: [], portrait: "", bookingDepartments: [], clinics: [], expertSections: [], verified: false },
  theme: { accent: "#2f8f65", accentSoft: "#eaf6ef", homeStyle: "standard" },
  home: { heroTitle: "", showNotice: true, quickQuestions: [] },
  chat: { title: "健康问答", aiLabel: "内容由大模型生成，不是医生本人回复。", citations: { enabled: true } },
  modules: DEFAULT_COMPONENTS.map(({ id, enabled, order }) => ({ id, enabled, order })),
  services: { groups: [], off: [] }, records: { steps: [] }, content: { articles: [], videos: [] },
  safety: {}, knowledgeBase: { id: "kb-", source: "", status: "待清洗" },
};
