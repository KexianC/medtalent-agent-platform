/** Versioned portable configuration shared by the builder API and runtimes. */
export type BuilderComponentId = "home" | "chat" | "records" | "services" | "content" | "assessments" | "wellness" | "voice";
export type BuilderComponent = { id: BuilderComponentId; enabled: boolean; order: number; label?: string; version?: string; dependsOn?: BuilderComponentId[] };
export type BuilderRecordField = { key: string; label: string; type?: "number" | "text" | "select"; group?: string; options?: string[]; unit?: string; min?: number; max?: number; step?: number };
export type BuilderAssessmentResultBand = { min: number; max: number; label: string; description?: string };
export type BuilderAssessment = { id: string; title: string; description?: string; source?: string; version?: string; resultBands?: BuilderAssessmentResultBand[]; questions: { id: string; text: string; options: { label: string; value: number }[] }[] };
export type BuilderServiceStepField = { key: string; label: string; type: "text" | "number"; required: boolean };
export type BuilderServiceStep = { id: string; title: string; description?: string; dependsOn?: string[]; required?: boolean; fields?: BuilderServiceStepField[] };
export type BuilderServicePlan = { id: string; title: string; description?: string; completionRule?: "all-required" | "all-steps"; steps: BuilderServiceStep[] };
export type TemplateEvaluationCase = { id: string; prompt: string; expected: string; category: "education" | "boundary" | "knowledge" | "abnormal" };
export type AgentBuilderConfig = {
  schemaVersion: 1; components: BuilderComponent[]; recordFields: BuilderRecordField[];
  assessments: BuilderAssessment[]; servicePlans: BuilderServicePlan[];
  dataPermissions?: { records: "read-write" | "read-only"; assessments: "read-write" | "read-only"; services: "read-write" | "read-only" };
  layout?: { density: "comfortable" | "compact"; cards: "grid" | "list" };
  voice: { enabled: boolean; autoSend: boolean; autoPlay: boolean; speaker?: string };
  healthContext: boolean; requiresReview: boolean;
};
export type AgentTemplate = {
  id: string; name: string; description: string; category: string; version: number; builtIn: boolean;
  parameters: { key: "name" | "hospital" | "department" | "specialty"; label: string; required: boolean; defaultValue: string }[];
  agentSnapshot: { slug: string; name: string; hospital: string; department: string; specialty: string; [key: string]: unknown };
  status?: "draft" | "published" | "retired"; publishedVersion?: number; evaluationCases?: TemplateEvaluationCase[]; createdAt?: string; updatedAt?: string;
};
export const BUILDER_COMPONENT_LABELS: Record<BuilderComponentId, string> = {
  home: "首页", chat: "智能问答", records: "健康记录", services: "服务计划", content: "科普内容", assessments: "自评问卷", wellness: "身心练习", voice: "语音交互",
};
export const DEFAULT_COMPONENTS: BuilderComponent[] = (Object.keys(BUILDER_COMPONENT_LABELS) as BuilderComponentId[]).map((id, order) => ({
  id, order, enabled: ["home", "chat", "records", "services", "content"].includes(id), label: BUILDER_COMPONENT_LABELS[id],
}));
const plain = (input: unknown): input is Record<string, unknown> => Boolean(input && typeof input === "object" && !Array.isArray(input) && [Object.prototype, null].includes(Object.getPrototypeOf(input)));
const fail = (message: string): never => { throw new Error(message); };
const object = (input: unknown, keys: string[], name: string): Record<string, unknown> => {
  if (!plain(input) || Object.keys(input).some(key => !keys.includes(key))) fail(name + "含不支持的字段或格式无效。");
  return input as Record<string, unknown>;
};
const str = (input: unknown, name: string, max: number, required = false): string => {
  if (input === undefined && !required) return "";
  // eslint-disable-next-line no-control-regex -- Imported text must reject ASCII control characters while allowing tabs and line breaks.
  if (typeof input !== "string" || input.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input)) fail(name + "格式无效。");
  const value = (input as string).trim();
  if (required && !value) fail(name + "不能为空。");
  return value;
};
const key = (input: unknown, name: string) => {
  const value = str(input, name, 64, true);
  if (!/^[a-z][A-Za-z0-9_-]{0,63}$/.test(value) || ["__proto__", "constructor", "prototype"].includes(value)) fail(name + "须为安全的英文标识。");
  return value;
};
const bool = (input: unknown, fallback: boolean): boolean => input === undefined ? fallback : typeof input === "boolean" ? input : fail("配置开关须为布尔值。");
const num = (input: unknown, name: string, min: number, max: number, fallback?: number): number | undefined => {
  if (input === undefined) return fallback;
  if (typeof input !== "number" || !Number.isFinite(input) || input < min || input > max) fail(name + "超出范围。");
  return input as number;
};
const list = (input: unknown, name: string, max: number): unknown[] => input === undefined ? [] : Array.isArray(input) && input.length <= max ? input : fail(name + "最多支持 " + max + " 项。");
const unique = <T>(items: T[], id: (item: T) => string, name: string): T[] => {
  if (new Set(items.map(id)).size !== items.length) fail(name + "标识不能重复。");
  return items;
};
const choice = <T extends string>(input: unknown, allowed: readonly T[], name: string, fallback: T): T => input === undefined ? fallback : typeof input === "string" && (allowed as readonly string[]).includes(input) ? input as T : fail(name + "无效。");

/** Template questions are data, never executable expressions or a claim of medical validation. */
export function normalizeTemplateEvaluationCases(input: unknown): TemplateEvaluationCase[] | undefined {
  if (input === undefined) return undefined;
  const cases = unique(list(input, "模板评测题", 40).map(entry => {
    const item = object(entry, ["id", "prompt", "expected", "category"], "模板评测题");
    return { id: key(item.id, "题目标识"), prompt: str(item.prompt, "评测问题", 2000, true), expected: str(item.expected, "预期要点", 2000, true),
      category: choice(item.category, ["education", "boundary", "knowledge", "abnormal"] as const, "评测题类别", "education") };
  }), item => item.id, "模板评测题");
  unique(cases, item => item.prompt, "评测问题");
  return cases;
}

/** Undefined deliberately preserves historical doctors' existing experiences and JSON shape. */
export function normalizeAgentBuilder(input: unknown): AgentBuilderConfig | undefined {
  if (input === undefined) return undefined;
  const value = object(input, ["schemaVersion", "components", "recordFields", "assessments", "servicePlans", "voice", "healthContext", "requiresReview", "layout", "dataPermissions"], "组件配置");
  if (value.schemaVersion !== 1) fail("组件配置版本不受支持。");
  const components: BuilderComponent[] = value.components === undefined ? DEFAULT_COMPONENTS.map(item => ({ ...item })) : unique(list(value.components, "组件", 8).map(entry => {
    const item = object(entry, ["id", "enabled", "order", "label", "version", "dependsOn"], "组件");
    if (typeof item.id !== "string" || !Object.prototype.hasOwnProperty.call(BUILDER_COMPONENT_LABELS, item.id)) fail("组件类型无效。");
    const order = num(item.order, "组件顺序", 0, 100, 0)!;
    if (!Number.isInteger(order)) fail("组件顺序须为整数。");
    const component: BuilderComponent = { id: item.id as BuilderComponentId, enabled: bool(item.enabled, true), order, ...(item.label === undefined ? {} : { label: str(item.label, "组件名称", 40) }) };
    if (item.version !== undefined) { component.version = str(item.version, "组件版本", 40, true); if (!/^\d+\.\d+\.\d+$/.test(component.version)) fail("组件版本须为主版本.次版本.修订号。"); }
    if (item.dependsOn !== undefined) component.dependsOn = unique(list(item.dependsOn, "组件依赖", 8).map(dependency => { if (typeof dependency !== "string" || !Object.prototype.hasOwnProperty.call(BUILDER_COMPONENT_LABELS, dependency) || dependency === item.id) fail("组件依赖无效。"); return dependency as BuilderComponentId; }), dependency => dependency, "组件依赖");
    return component;
  }), item => item.id, "组件");
  if (!components.some(item => item.enabled && (item.id === "home" || item.id === "chat"))) fail("首页或智能问答至少保留一项。");
  const recordFields = unique(list(value.recordFields, "记录字段", 20).map(entry => {
    const item = object(entry, ["key", "label", "type", "group", "options", "unit", "min", "max", "step"], "记录字段");
    const type = choice(item.type, ["number", "text", "select"] as const, "记录字段类型", "number");
    const field: BuilderRecordField = { key: key(item.key, "字段标识"), label: str(item.label, "字段名称", 60, true) };
    if (item.type !== undefined) field.type = type;
    if (item.group !== undefined) field.group = str(item.group, "字段分组", 60);
    if (type === "number") {
      if (item.options !== undefined) fail("数值记录不支持选项。");
      if (item.unit !== undefined) field.unit = str(item.unit, "单位", 30);
      if (item.min !== undefined) field.min = num(item.min, "最小值", -1000000000, 1000000000);
      if (item.max !== undefined) field.max = num(item.max, "最大值", -1000000000, 1000000000);
      if (item.step !== undefined) field.step = num(item.step, "步长", 0.000001, 1000000000);
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) fail("记录最小值不能大于最大值。");
    } else {
      if (["unit", "min", "max", "step"].some(name => item[name] !== undefined)) fail("文本或单选记录不能配置数值单位或边界。");
      if (type === "select") {
        const options = list(item.options, "记录选项", 30).map(option => str(option, "记录选项", 120, true));
        if (options.length < 2) fail("单选记录至少需要两个选项。");
        field.options = unique(options, option => option, "记录选项");
      } else if (item.options !== undefined) fail("文本记录不支持选项。");
    }
    return field;
  }), item => item.key, "记录字段");
  const assessments = unique(list(value.assessments, "问卷", 10).map(entry => {
    const item = object(entry, ["id", "title", "description", "questions", "source", "version", "resultBands"], "问卷");
    const questions = unique(list(item.questions, "问卷题目", 30).map(entry => {
      const question = object(entry, ["id", "text", "options"], "问卷题目");
      const options = list(question.options, "问卷选项", 10).map(entry => {
        const option = object(entry, ["label", "value"], "问卷选项");
        return { label: str(option.label, "选项", 120, true), value: num(option.value, "选项分值", -1000, 1000, 0)! };
      });
      if (options.length < 2) fail("每个问卷题目至少需要两个选项。");
      return { id: key(question.id, "题目标识"), text: str(question.text, "题目", 500, true), options };
    }), item => item.id, "问卷题目");
    if (!questions.length) fail("问卷至少需要一个题目。");
    const assessment: BuilderAssessment = { id: key(item.id, "问卷标识"), title: str(item.title, "问卷名称", 120, true), description: str(item.description, "问卷说明", 1000), questions };
    if (item.source !== undefined) assessment.source = str(item.source, "问卷来源", 1500);
    if (item.version !== undefined) assessment.version = str(item.version, "问卷版本", 80);
    if (item.resultBands !== undefined) {
      const possibleMin = questions.reduce((total, question) => total + Math.min(...question.options.map(option => option.value)), 0);
      const possibleMax = questions.reduce((total, question) => total + Math.max(...question.options.map(option => option.value)), 0);
      const bands = list(item.resultBands, "结果区间", 30).map(entry => {
        const band = object(entry, ["min", "max", "label", "description"], "结果区间");
        if (band.min === undefined || band.max === undefined) fail("结果区间必须设置上下界。");
        const min = num(band.min, "结果区间下界", possibleMin, possibleMax)!;
        const max = num(band.max, "结果区间上界", possibleMin, possibleMax)!;
        if (min > max) fail("结果区间下界不能大于上界。");
        return { min, max, label: str(band.label, "结果名称", 120, true), ...(band.description === undefined ? {} : { description: str(band.description, "结果说明", 1500) }) };
      }).sort((a, b) => a.min - b.min);
      if (bands.some((band, index) => index > 0 && band.min <= bands[index - 1].max)) fail("结果区间不能重叠（包含上下界）。");
      assessment.resultBands = bands;
    }
    return assessment;
  }), item => item.id, "问卷");
  const servicePlans = unique(list(value.servicePlans, "服务计划", 20).map(entry => {
    const item = object(entry, ["id", "title", "description", "steps", "completionRule"], "服务计划");
    const steps: BuilderServiceStep[] = unique(list(item.steps, "服务步骤", 16).map(entry => {
      const step = object(entry, ["id", "title", "description", "dependsOn", "required", "fields"], "服务步骤");
      const result: BuilderServiceStep = { id: key(step.id, "步骤标识"), title: str(step.title, "步骤名称", 120, true), description: str(step.description, "步骤说明", 1000) };
      if (step.required !== undefined) result.required = bool(step.required, true);
      if (step.dependsOn !== undefined) result.dependsOn = unique(list(step.dependsOn, "前置步骤", 16).map(value => key(value, "前置步骤")), value => value, "前置步骤");
      if (step.fields !== undefined) result.fields = unique(list(step.fields, "步骤字段", 10).map(entry => {
        const field = object(entry, ["key", "label", "type", "required"], "步骤字段");
        return { key: key(field.key, "步骤字段标识"), label: str(field.label, "步骤字段名称", 100, true), type: choice(field.type, ["text", "number"] as const, "步骤字段类型", "text"), required: bool(field.required, false) };
      }), field => field.key, "步骤字段");
      return result;
    }), item => item.id, "服务步骤");
    if (!steps.length) fail("服务计划至少需要一个步骤。");
    unique(steps, step => step.title, "步骤名称");
    const byId = new Map(steps.map(step => [step.id, step]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (stepId: string): void => {
      if (visiting.has(stepId)) fail("服务步骤不能形成循环依赖。");
      if (visited.has(stepId)) return;
      visiting.add(stepId);
      for (const dependency of byId.get(stepId)?.dependsOn || []) {
        if (!byId.has(dependency) || dependency === stepId) fail("前置步骤必须存在且不能是自身。");
        visit(dependency);
      }
      visiting.delete(stepId); visited.add(stepId);
    };
    steps.forEach(step => visit(step.id));
    const plan: BuilderServicePlan = { id: key(item.id, "计划标识"), title: str(item.title, "计划名称", 120, true), description: str(item.description, "计划说明", 1000), steps };
    if (item.completionRule !== undefined) {
      plan.completionRule = choice(item.completionRule, ["all-required", "all-steps"] as const, "完成规则", "all-steps");
      if (plan.completionRule === "all-required" && !steps.some(step => step.required !== false)) fail("按必需步骤完成的计划至少需要一个必需步骤。");
    }
    return plan;
  }), item => item.id, "服务计划");
  unique(servicePlans, item => item.title, "服务名称");
  let layout: AgentBuilderConfig["layout"];
  if (value.layout !== undefined) {
    const input = object(value.layout, ["density", "cards"], "布局配置");
    layout = { density: choice(input.density, ["comfortable", "compact"] as const, "内容密度", "comfortable"), cards: choice(input.cards, ["grid", "list"] as const, "卡片布局", "grid") };
  }
  let dataPermissions: AgentBuilderConfig["dataPermissions"];
  if (value.dataPermissions !== undefined) {
    const input = object(value.dataPermissions, ["records", "assessments", "services"], "组件数据权限");
    dataPermissions = { records: choice(input.records, ["read-write", "read-only"] as const, "记录权限", "read-write"), assessments: choice(input.assessments, ["read-write", "read-only"] as const, "自评权限", "read-write"), services: choice(input.services, ["read-write", "read-only"] as const, "计划权限", "read-write") };
  }
  const voice = object(value.voice ?? {}, ["enabled", "autoSend", "autoPlay", "speaker"], "语音配置");
  return { schemaVersion: 1, components, recordFields, assessments, servicePlans, ...(layout ? { layout } : {}), ...(dataPermissions ? { dataPermissions } : {}),
    voice: { enabled: bool(voice.enabled, false), autoSend: bool(voice.autoSend, true), autoPlay: bool(voice.autoPlay, false), ...(voice.speaker === undefined ? {} : { speaker: str(voice.speaker, "音色", 100) }) },
    healthContext: bool(value.healthContext, true), requiresReview: bool(value.requiresReview, true) };
}
export function getBuilderComponents(builder?: AgentBuilderConfig): BuilderComponent[] {
  return (builder?.components ?? DEFAULT_COMPONENTS).filter(item => item.enabled).slice().sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
