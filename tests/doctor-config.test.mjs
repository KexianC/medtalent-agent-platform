import test from "node:test";
import assert from "node:assert/strict";
import { BLANK_DOCTOR_CONFIG, normalizeDoctorConfig } from "../src/lib/doctorConfig.ts";
import { DEFAULT_COMPONENTS, normalizeAgentBuilder } from "../src/lib/agentBuilder.ts";
import { doctorCustoms, noticeLines } from "../src/features/services/doctorCustom.ts";

// 只复用仓库已有的医生资料和样板文案，不编造医生介绍、医学出处或号码。
function filledBlank() {
  const config = structuredClone(BLANK_DOCTOR_CONFIG);
  config.slug = "tang-jinsong";
  config.profile.name = "唐劲松";
  return config;
}

function completeConfig() {
  const config = filledBlank();
  const custom = doctorCustoms[config.slug];
  config.status = "review";
  config.profile = {
    ...config.profile, ...structuredClone(custom.bio),
    displayDepartment: custom.bio.department,
    portrait: "/assets/doctors/portraits/tang-jinsong.png", portraitPosition: "50% 44%",
    introPhoto: "/assets/doctors/tang-jinsong-intro.jpeg",
    expertSections: structuredClone(custom.expertSections),
  };
  config.theme = { accent: "#2f8f65", accentSoft: "#eaf6ef", homeStyle: "tang-home", heroArtwork: "standard" };
  config.home = {
    heroTitle: "一起梳理困扰，找到下一步", showNotice: true, showStartCard: true,
    resourcesCollapsed: true, showExpertNote: false,
    quickQuestions: ["长期失眠需要关注哪些信号？", "焦虑和普通紧张有什么不同？", "家人情绪低落时怎样沟通？", "第一次精神科就诊要准备什么？"],
  };
  config.chat = {
    title: "健康问答", showTagline: false, aiLabel: config.chat.aiLabel, replyFooter: true,
    citations: { enabled: true, hideWhenEmpty: true, style: "tang" },
    welcomeMessage: config.chat.aiLabel, demoReplyWhenModelMissing: true,
  };
  config.modules = [
    ...DEFAULT_COMPONENTS.map(({ id, order }) => ({ id, order, enabled: id !== "wellness",
      ...(id === "records" ? { variant: "sleep-mood-function" } : {}),
      ...(id === "voice" ? { autoPlay: "text-and-voice", hint: "", requirePlaybackOptIn: true } : {}),
    })),
    { id: "visitSummary", enabled: true, order: 8, days: 30, numbersOnly: true },
    { id: "diaryAdvice", enabled: true, order: 9 },
  ];
  config.services = {
    intro: custom.servicesIntro, groups: structuredClone(custom.featureGroups), off: [...custom.off], showPlanStatus: false,
    assessmentPrompt: "我想了解最近的心理状态，请带我做一次非诊断性的自我观察。",
    shareHint: "这些内容默认不会发给 AI。点“带摘要咨询”后才放进问答输入框，你确认发送才会提交。",
  };
  config.records = {
    placeholder: "例如：入睡约 30 分钟、夜醒 2 次，焦虑 6/10，白天工作效率下降",
    steps: ["记录时长、入睡耗时与夜醒", "记录情绪稳定度与焦虑程度", "记录白天精力与生活影响"],
    askWithRecords: { label: "带近期记录咨询", prompt: "请结合我最近的睡眠、情绪和日常状态记录，帮我看看最值得先调整的一点。", share: "summary" },
    privacyHint: "将对话与心理自评保存在当前设备；关闭时清除本机副本。",
  };
  config.content = { articles: ["tjs-1", "tjs-2", "tjs-3"], videos: structuredClone(custom.videos), videoPlaceholders: [...custom.videoPlaceholders] };
  config.safety = { enabled: true, crisisCard: true, showHotlinesInBoundary: true, noticeLines: [...noticeLines], hotlines: ["120", "110", "12356"], extraRules: [] };
  return config;
}

test("合法完整 v2 配置保留所有分块及模块子选项，不修改输入", () => {
  const input = completeConfig();
  const original = structuredClone(input);
  const normalized = normalizeDoctorConfig(input);
  assert.deepEqual(normalized, original);
  assert.deepEqual(input, original);
  assert.deepEqual(normalizeDoctorConfig(normalized), normalized);
  normalized.safety.noticeLines.push("测试副本隔离");
  normalized.content.videos[0].keywords.push("测试副本隔离");
  assert.deepEqual(input, original);
});

test("空白模板仅填 slug 和姓名后可通过，并补齐不可关闭的平台安全默认", () => {
  assert.equal(BLANK_DOCTOR_CONFIG.slug, "");
  assert.equal(BLANK_DOCTOR_CONFIG.status, "draft");
  assert.deepEqual(BLANK_DOCTOR_CONFIG.safety, {});
  assert.throws(() => normalizeDoctorConfig(BLANK_DOCTOR_CONFIG), /医生标识.*不能为空/);
  const config = normalizeDoctorConfig(filledBlank());
  assert.equal(config.profile.verified, false);
  assert.deepEqual(config.modules.map(({ id, enabled }) => ({ id, enabled })), DEFAULT_COMPONENTS.map(({ id, enabled }) => ({ id, enabled })));
  assert.deepEqual(config.safety, {
    enabled: true, crisisCard: true, showHotlinesInBoundary: true,
    noticeLines: [...noticeLines], hotlines: ["120", "110", "12356"], extraRules: [],
  });
  assert.deepEqual(BLANK_DOCTOR_CONFIG.safety, {});
});

test("缺少、空值或非对象 safety 均报错，不能静默恢复缺失的安全块", () => {
  const missing = filledBlank();
  delete missing.safety;
  for (const input of [missing, ...[undefined, null, false, [], ""].map(safety => ({ ...filledBlank(), safety }))]) {
    assert.throws(() => normalizeDoctorConfig(input), /安全配置/);
  }
});

for (const field of ["crisisCard", "enabled", "showHotlinesInBoundary"]) {
  test(`安全开关 ${field} 不能关闭，也不能以其他类型绕过`, () => {
    for (const value of [false, null, 0, "false", "true", [], {}]) {
      assert.throws(() => normalizeDoctorConfig({ ...filledBlank(), safety: { [field]: value } }), /安全模块不能关闭或削弱/);
    }
  });
}

test("安全热线不能清空、删减、以空字符串或非数组替换", () => {
  for (const hotlines of [[], ["120"], ["120", "12356"], ["120", "110"], ["110", "12356"], [""], "120", null]) {
    assert.throws(() => normalizeDoctorConfig({ ...filledBlank(), safety: { hotlines } }), /安全热线/);
  }
});

test("平台安全说明不能清空、改写、删减或重排", () => {
  for (const lines of [[], noticeLines.slice(1), [...noticeLines].reverse(), ["无需就医"], "", null]) {
    assert.throws(() => normalizeDoctorConfig({ ...filledBlank(), safety: { noticeLines: lines } }), /安全说明/);
  }
});

test("extraRules 只能追加，保留平台说明、热线和全部安全开关", () => {
  const extraRules = ["查不到依据时明确说明没有找到依据。"];
  const config = normalizeDoctorConfig({ ...filledBlank(), safety: { extraRules } });
  assert.deepEqual(config.safety.extraRules, extraRules);
  assert.deepEqual(config.safety.noticeLines, noticeLines);
  assert.deepEqual(config.safety.hotlines, ["120", "110", "12356"]);
  assert.equal(config.safety.enabled, true);
  assert.equal(config.safety.crisisCard, true);
  assert.equal(config.safety.showHotlinesInBoundary, true);
  assert.deepEqual(normalizeDoctorConfig(config), config);
  for (const invalid of ["关闭安全模块", [false], [""], ["规则\u0000"], ["字".repeat(2001)]]) {
    assert.throws(() => normalizeDoctorConfig({ ...filledBlank(), safety: { extraRules: invalid } }), /追加安全规则/);
  }
});

test("未知字段在顶层、每个分块及嵌套对象均报错", () => {
  const paths = [
    [], ["profile"], ["profile", "bookingDepartments", 0], ["profile", "clinics", 0], ["profile", "expertSections", 0],
    ["theme"], ["home"], ["chat"], ["chat", "citations"], ["modules", 0], ["services"], ["services", "groups", 0],
    ["records"], ["records", "askWithRecords"], ["content"], ["content", "videos", 0], ["safety"], ["knowledgeBase"],
  ];
  for (const path of paths) {
    const config = completeConfig();
    const target = path.reduce((item, part) => item[part], config);
    target.unsupported = true;
    assert.throws(() => normalizeDoctorConfig(config), /不支持的字段/, path.join("."));
  }
  for (const key of ["lineage", "doctrine", "lectures"]) {
    assert.throws(() => normalizeDoctorConfig({ ...filledBlank(), [key]: {} }), /不支持的字段/);
  }
});

test("主题颜色必须为完整 #RRGGBB", () => {
  for (const key of ["accent", "accentSoft"]) {
    for (const value of ["green", "#fff", "#12345678", "#GG0000", "123456", "", null]) {
      const input = filledBlank();
      input.theme[key] = value;
      assert.throws(() => normalizeDoctorConfig(input), /主色|浅色/);
    }
  }
  const input = filledBlank();
  input.theme.accent = "#ABCDEF";
  assert.equal(normalizeDoctorConfig(input).theme.accent, "#ABCDEF");
});

test("slug 仅接受小写拼音与音节间连字符", () => {
  for (const slug of ["", "Tang-jinsong", "唐劲松", "tang_jinsong", "tang1", "-tang", "tang-", "tang--jinsong", "tang/jinsong", "tang.jinsong", "字".repeat(81)]) {
    assert.throws(() => normalizeDoctorConfig({ ...filledBlank(), slug }), /医生标识/);
  }
});

test("schemaVersion 必须显式为数字 2", () => {
  for (const schemaVersion of [undefined, 1, 3, "2", null]) {
    assert.throws(() => normalizeDoctorConfig({ ...filledBlank(), schemaVersion }), /版本必须为 2/);
  }
});

test("模块复用八个旧 ID，允许两个 v2 扩展，缺省顺序按数组补齐", () => {
  const input = completeConfig();
  input.modules.forEach(item => { delete item.order; });
  assert.deepEqual(normalizeDoctorConfig(input).modules.map(item => item.order), input.modules.map((_, i) => i));
  for (const module of [
    { id: "unknown" }, { id: "home", variant: "sleep-mood-function" }, { id: "records", variant: "unknown" },
    { id: "voice", autoPlay: true }, { id: "visitSummary", days: 0 }, { id: "visitSummary", days: 1.5 },
    { id: "diaryAdvice", numbersOnly: true }, { id: "chat", order: -1 }, { id: "chat", order: NaN },
    { id: "chat", order: 0.5 }, { id: "chat", enabled: "false" },
  ]) {
    assert.throws(() => normalizeDoctorConfig({ ...filledBlank(), modules: [module] }));
  }
  assert.throws(() => normalizeDoctorConfig({ ...filledBlank(), modules: [{ id: "home" }, { id: "home" }] }), /不能重复/);
});

test("字符串长度、控制字符和列表类型在嵌套字段也受检查", () => {
  for (const name of ["", "字".repeat(81), "唐\u0000劲松", "唐\u007f劲松"]) {
    const input = filledBlank();
    input.profile.name = name;
    assert.throws(() => normalizeDoctorConfig(input), /医生姓名/);
  }
  for (const mutate of [
    c => { c.profile.tags = ["标签\u0001"]; }, c => { c.home.quickQuestions = Array(5).fill("问题"); },
    c => { c.services.groups = false; }, c => { c.content.videos[0].keywords = [false]; },
    c => { c.profile.clinics[0].times = ["时间\u0000"]; }, c => { c.chat.welcomeMessage = "字".repeat(10001); },
    c => { c.records.askWithRecords.prompt = "文字\u000b"; },
  ]) {
    const config = completeConfig();
    mutate(config);
    assert.throws(() => normalizeDoctorConfig(config));
  }
});

test("模板和状态只允许约定值，名中医传承本步仅接受模板枚举", () => {
  for (const template of ["general", "tcm", "mingzhongyi"]) {
    assert.equal(normalizeDoctorConfig({ ...filledBlank(), template }).template, template);
  }
  for (const status of ["draft", "review", "online"]) {
    assert.equal(normalizeDoctorConfig({ ...filledBlank(), status }).status, status);
  }
  assert.throws(() => normalizeDoctorConfig({ ...filledBlank(), template: "other" }), /页面模板/);
  assert.throws(() => normalizeDoctorConfig({ ...filledBlank(), status: "published" }), /配置状态/);
});

test("文章支持现有结构或引用，文章对象仍严格检查字段", () => {
  const config = filledBlank();
  config.content.articles = [{ id: "tjs-1", title: "", summary: "", tag: "", readTime: "" }];
  assert.throws(() => normalizeDoctorConfig(config), /文章标题/);
  config.content.articles[0].title = "长期失眠需要关注哪些信号？";
  assert.deepEqual(normalizeDoctorConfig(config).content.articles, config.content.articles);
  config.content.articles[0].unsupported = true;
  assert.throws(() => normalizeDoctorConfig(config), /不支持的字段/);
});

test("非普通对象、空输入和污染原型字段报错", () => {
  for (const input of [undefined, null, [], "", 2, new Date(), Object.create({ safety: {} })]) {
    assert.throws(() => normalizeDoctorConfig(input), /医生配置/);
  }
  assert.throws(() => normalizeDoctorConfig({ ...filledBlank(), ...JSON.parse('{"__proto__":{}}') }), /不支持的字段/);
});

test("v1 校验及默认组件保持可用，v2 不接受旧配置", () => {
  assert.equal(normalizeAgentBuilder(undefined), undefined);
  const old = normalizeAgentBuilder({ schemaVersion: 1 });
  assert.equal(old.schemaVersion, 1);
  assert.equal(old.components.length, 8);
  assert.throws(() => normalizeDoctorConfig(old), /不支持的字段|版本/);
});
