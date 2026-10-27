import { AnswerFeedback } from '../features/feedback/AnswerFeedback';
import { DoctorTemplatePreviewContext, useDoctorTemplatePreview } from '../hooks/doctorPreview';
import { createTangRecordDraft, validateTangRecordDraft, mergeTangDailyRecords, upsertTangDailyRecord, tangScoreAnchors, type TangRecordDraft } from "../lib/tangHealthRecords";
import { ConsumerAccountCard, ConsumerDataBoundary } from '../features/account/ConsumerAccount';
import { useConsumerSession } from '../hooks/useConsumerSession';
import { consumerDataStore } from '../lib/consumerData';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeftIcon,
  ArrowClockwiseIcon,
  BabyIcon,
  BellSimpleIcon,
  BookmarkSimpleIcon,
  BoneIcon,
  BrainIcon,
  CalendarCheckIcon,
  CalendarDotsIcon,
  CaretRightIcon,
  ChartLineUpIcon,
  ChatCircleDotsIcon,
  CheckCircleIcon,
  ClipboardTextIcon,
  ClockCounterClockwiseIcon,
  CopyIcon,
  DropIcon,
  EarIcon,
  FileTextIcon,
  FirstAidKitIcon,
  FlowerTulipIcon,
  FloppyDiskIcon,
  ForkKnifeIcon,
  HeartIcon,
  HouseIcon,
  ImageSquareIcon,
  KeyboardIcon,
  LeafIcon,
  LockKeyIcon,
  MoonStarsIcon,
  MicrophoneIcon,
  NeedleIcon,
  NotePencilIcon,
  PaperPlaneTiltIcon,
  PersonSimpleRunIcon,
  PlusIcon,
  PulseIcon,
  RulerIcon,
  ShieldCheckIcon,
  SparkleIcon,
  SpeakerHighIcon,
  SquaresFourIcon,
  StethoscopeIcon,
  StopIcon,
  ThermometerIcon,
  UserCircleIcon,
  WaveSineIcon,
  XIcon,
  TrashIcon,
  type Icon,
} from "@phosphor-icons/react";
import { type DoctorProfile } from "../data/doctorProfiles";
import {
  doctorExperiences,
  type DoctorExperience,
  type JourneyIconKey,
} from "../data/doctorExperience";
import { useWavRecorder } from "../hooks/useWavRecorder";
import { useDoctorResource, type PublicDoctorDetail, type PublicDoctorProfile, type PublishedContent } from "../hooks/useDoctorDirectory";
import { getPcmStartTime, parseChatRetrieval, readAudioStream, readChatStream, stripChatCitationDetails, type ChatRetrievalMetadata } from "../lib/chatStream";
import { createSpeechQueue } from "../lib/speechQueue";
import { resumeSpeechContext, SpeechPlaybackError, waitForSpeechTimeline } from "../lib/speechPlayback";
import { CHAT_DISCLAIMER, createChatDisclaimerFilter, stripChatDisclaimer } from "../lib/chatDisclaimer";
import { doctorTabPath, resolveDoctorEntryTab, type DoctorTab } from "../lib/doctorEntry";
import { chatBottomOffset, createChatScrollFollow, resolveChatViewport } from "../lib/chatLayout";
import { formatMedicalText } from "../lib/medicalText";
import {
  DoctorPreviewContext,
  useDoctorPreview,
  previewStorageSlug,
  clearCurrentVisitorData,
  createLocalId,
  doctorSessionKey,
  doctorStorageKey,
  localDateKey,
  useDoctorLocalState,
  type DoctorChatMessage,
  type DoctorDailyTasks,
  type DoctorFavorite,
  type DoctorHealthMetrics,
  type DoctorHealthRecord,
  type DoctorPrivacySettings,
} from "../hooks/useDoctorLocalState";
import {
  buildHealthContextPayload,
  buildHealthTrend,
  calculateHealthStats,
  dailyTasksFromRecords,
  formatHealthMetricsSummary,
  healthRecordDateKey,
  normalizeHealthRecords,
  recentRecordDayCount,
  sortHealthRecords,
  upsertHealthRecord,
} from "../lib/healthRecords";
import { builderLayoutClass, componentEnabled, configuredNavigation, configuredRecordConfig, healthContextEnabled, realHealthReminder, usesTangRecords, usesWellness, voiceEnabled } from '../lib/builderRuntime';
import { getBuilderComponents } from '../lib/agentBuilder';
import { BuilderAssessments } from '../features/builder/BuilderAssessments';
import "./doctor-app.css";
import { WellnessProvider } from "../features/yuwen/WellnessStore";
import { WellnessHome, WellnessWorkspace, WellnessMeLinks } from "../features/yuwen/WellnessWorkspace";
import type { WellnessView } from "../features/yuwen/types";
import SpecialtyManagePanel from "../features/health/SpecialtyManagePanel";
import ConsumerReportsPanel from "../features/services/ConsumerReportsPanel";
import ConsumerServicesPanel from "../features/services/ConsumerServicesPanel";
import ServicePlanWorksheet from "../features/services/ServicePlanWorksheet";
import { emptyServicePlans, normalizeServicePlans } from "../lib/servicePlans";
import { buildSpecialtyStats, getSpecialtyRecordConfig } from "../lib/specialtyRecords";
import { useWellnessDay } from "../features/yuwen/useWellnessDay";
import { TangChatGuidance } from "../features/tang/TangChatGuidance";
import "../features/tang/tang-voice.css";

type Tab = DoctorTab;
type AskNavigator = (question?: string, shareHealthRecords?: boolean) => void;
type FeatureSheetProps = {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
};

const journeyIcons: Record<JourneyIconKey, Icon> = {
  ruler: RulerIcon,
  bone: BoneIcon,
  sparkle: SparkleIcon,
  ear: EarIcon,
  wave: WaveSineIcon,
  leaf: LeafIcon,
  pulse: PulseIcon,
  drop: DropIcon,
  heart: HeartIcon,
  fork: ForkKnifeIcon,
  run: PersonSimpleRunIcon,
  moon: MoonStarsIcon,
  flower: FlowerTulipIcon,
  calendar: CalendarDotsIcon,
  firstAid: FirstAidKitIcon,
  needle: NeedleIcon,
  clipboard: ClipboardTextIcon,
  thermometer: ThermometerIcon,
  stethoscope: StethoscopeIcon,
  brain: BrainIcon,
};

const navItems: { id: Tab; label: string; icon: Icon }[] = [
  { id: "home", label: "首页", icon: HouseIcon },
  { id: "ask", label: "问医生", icon: ChatCircleDotsIcon },
  { id: "manage", label: "管理", icon: ChartLineUpIcon },
  { id: "services", label: "服务", icon: SquaresFourIcon },
  { id: "me", label: "我的", icon: UserCircleIcon },
];

function createGenericExperience(doctor: DoctorProfile): DoctorExperience {
  const accent = /^#[0-9a-f]{6}$/i.test(doctor.accent) ? doctor.accent : "#4e988f";
  const accentRgb = [1, 3, 5].map((position) => parseInt(accent.slice(position, position + 2), 16)).join(", ");
  return {
    tagline: doctor.specialty || "健康知识 · 日常陪伴",
    eyebrow: "PERSONAL HEALTH JOURNEY",
    heroIcon: "clipboard",
    primaryTitle: "每日健康记录",
    primarySubtitle: "整理身体感受、生活习惯和想咨询的问题，帮助自己看清变化。",
    cta: "开始记录今天的状态",
    metric: { label: "近 7 日记录完成度", value: "0 / 7 天", note: "完成记录后显示真实进度", progress: 0 },
    steps: [
      { icon: "clipboard", title: "记录当前状态", description: "记下身体感受、出现时间与变化" },
      { icon: "calendar", title: "梳理生活习惯", description: "补充睡眠、饮食、活动等信息" },
      { icon: "stethoscope", title: "准备咨询问题", description: "整理需要向专业人员了解的事项" },
    ],
    concerns: (doctor.quickQuestions.length ? doctor.quickQuestions : ["如何整理健康问题，方便线下咨询？", "日常健康记录应该包含哪些信息？"]).slice(0, 2).map((title) => ({ icon: "clipboard", title, description: "进入智能问答，进一步了解相关信息" })),
    reminder: "记录仅供个人梳理和就医准备，不替代专业诊疗。",
    theme: { accent, accentStrong: "#31564f", accentRgb, surface: doctor.accentSoft || "#eaf5ef", canvas: "#f7f3ea", ink: "#143c38" },
  };
}

const fadeUp = (reduced: boolean | null) => ({
  initial: reduced ? false : { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: reduced ? 0 : 0.36, ease: "easeOut" as const },
});

function JourneyIcon({ name, size = 22, weight = "duotone" }: { name: JourneyIconKey; size?: number; weight?: "regular" | "duotone" | "fill" }) {
  const IconComponent = journeyIcons[name];
  return <IconComponent size={size} weight={weight} aria-hidden="true" />;
}

function DoctorPhoto({ doctor, className }: { doctor: DoctorProfile; className: string }) {
  const [failedPortrait, setFailedPortrait] = useState<string>();
  const failed = failedPortrait === doctor.portrait;
  const portraitStyle = {
    "--portrait-position": doctor.portraitPosition ?? "50% 50%",
    "--portrait-scale": doctor.portraitScale ?? 1,
    "--portrait-translate-y": doctor.portraitTranslateY ?? "0%",
    "--portrait-transform-origin": doctor.portraitTransformOrigin ?? "50% 50%",
    backgroundColor: doctor.portraitBackground,
  } as CSSProperties;

  return (
    <span className={className} style={portraitStyle}>
      {doctor.portrait && !failed ? (
        <img src={doctor.portrait} alt={`${doctor.name}头像`} onError={() => setFailedPortrait(doctor.portrait)} />
      ) : (
        <span className="journey-photo-fallback">{doctor.name.slice(0, 1)}</span>
      )}
    </span>
  );
}

function useDialogFocusTrap(sheetRef: RefObject<HTMLElement | null>, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const sheet = sheetRef.current;
    const focusableSelector = "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";
    window.requestAnimationFrame(() => sheet?.querySelector<HTMLElement>(focusableSelector)?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !sheet) return;
      const controls = Array.from(sheet.querySelectorAll<HTMLElement>(focusableSelector));
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [sheetRef]);
}

function FeatureSheet({ title, eyebrow = "MEDTALENT SERVICE", onClose, children }: FeatureSheetProps) {
  const sheetRef = useRef<HTMLElement>(null);
  useDialogFocusTrap(sheetRef, onClose);

  if (typeof document === "undefined") return null;
  return createPortal(
    <motion.div className="journey-sheet-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.section
        ref={sheetRef}
        className="journey-sheet journey-feature-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        initial={{ y: 54, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 54, opacity: 0 }}
        transition={{ type: "spring", damping: 28, stiffness: 320 }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="journey-sheet-handle" />
        <button className="journey-sheet-close" onClick={onClose} aria-label={`关闭${title}`}><XIcon size={18} /></button>
        <span className="journey-eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
        <div className="journey-feature-body">{children}</div>
      </motion.section>
    </motion.div>,
    document.querySelector(".journey-phone") ?? document.body,
  );
}

const contentTypeLabels: Record<PublishedContent["type"], string> = { article: "科普文章", faq: "常见问答", notice: "公告", service: "服务说明" };

const stripStoredCitationDetails = (messages: DoctorChatMessage[]) => {
  let changed = false;
  const sanitized = messages.map((message) => {
    const next = stripChatCitationDetails(message);
    if (next !== message) changed = true;
    return next;
  });
  return changed ? sanitized : messages;
};

function PublishedContentSection({ content, onAsk, title = "最新发布" }: { content: PublishedContent[]; onAsk: AskNavigator; title?: string }) {
  const [selected, setSelected] = useState<PublishedContent | null>(null);
  if (!content.length) return null;
  return <section className="journey-published-content" aria-label={title}>
    <header><span className="journey-eyebrow">PUBLISHED CONTENT</span><h2>{title}</h2></header>
    <div className="journey-published-list">
      {content.map((item) => <button type="button" key={item.id} onClick={() => setSelected(item)}>
        <span className="journey-content-type">{contentTypeLabels[item.type]}</span>
        <div><b>{item.title}</b>{item.summary && <p>{item.summary}</p>}</div>
        <CaretRightIcon size={17} aria-hidden="true" />
      </button>)}
    </div>
    <AnimatePresence>
      {selected && <FeatureSheet title={selected.title} eyebrow={contentTypeLabels[selected.type]} onClose={() => setSelected(null)}>
        {selected.summary && selected.summary !== selected.body && <p className="journey-feature-lead">{selected.summary}</p>}
        <div className="journey-published-body">{formatMedicalText(selected.body || selected.summary || "暂无补充正文。")}</div>
        <button type="button" className="journey-primary-button" onClick={() => { onAsk(`我想进一步了解“${selected.title}”。`); setSelected(null); }}><ChatCircleDotsIcon size={17} /> 继续了解相关问题</button>
        <p className="journey-sheet-disclaimer"><ShieldCheckIcon size={14} /> 内容仅用于健康科普与就医准备，不替代专业诊疗。</p>
      </FeatureSheet>}
    </AnimatePresence>
  </section>;
}

const chatMessageBody = (message: DoctorChatMessage) => message.role === "assistant" && !message.error
  ? stripChatDisclaimer(message.text) : message.text;

function MessageCitations({ message, showDisclaimer = false, enabled = true }: { message: DoctorChatMessage; showDisclaimer?: boolean; enabled?: boolean }) {
  const { citations, retrievalMode } = parseChatRetrieval(message);
  const [excerpt,setExcerpt] = useState<{title:string;excerpt:string;shareUrl:string}|null>(null);
  const [citationError,setCitationError] = useState("");
  const openExcerpt=async(shareUrl:string)=>{setCitationError("");try{const response=await fetch(shareUrl,{cache:"no-store"});const body=await response.json();if(!response.ok)throw new Error(body.error||"授权片段暂不可用。");setExcerpt({...body,shareUrl});}catch(error){setCitationError(error instanceof Error?error.message:"无法读取片段。");}};
  return <>
    {enabled && citations?.length ? <details className="journey-citations">
    <summary><span><FileTextIcon size={14} />参考资料</span><small>{citations.length} 项</small></summary>
    <ol>{citations.map((citation, index) => <li key={`${citation.title}:${index}`}><span>[{index + 1}]</span>{citation.title}{citation.shareUrl && <button type="button" onClick={()=>void openExcerpt(citation.shareUrl!)}>阅读授权片段</button>}</li>)}</ol>
    </details> : enabled && (retrievalMode === "none" || showDisclaimer) ? <p className="journey-no-citations">参考资料：本次回答未附知识库引用。</p> : null}
    {citationError && <p role="alert">{citationError}</p>}{excerpt && <FeatureSheet title={excerpt.title} onClose={()=>setExcerpt(null)}><p style={{whiteSpace:"pre-wrap"}}>{excerpt.excerpt}</p><p>经授权公开的引用片段，仅供科普参考。</p><button type="button" onClick={()=>void navigator.clipboard.writeText(window.location.origin+excerpt.shareUrl.replace("/api/citations/","/references/")).then(()=>setCitationError("分享链接已复制。"),()=>setCitationError("请手动复制阅读页链接。"))}>复制分享链接</button></FeatureSheet>}
    {showDisclaimer && <p className="journey-reply-disclaimer" role="note">{CHAT_DISCLAIMER}</p>}
  </>;
}

function AssessmentSheet({
  doctor,
  experience,
  onClose,
  onAsk,
  onSave,
  initialCompleted,
  initialNote,
}: {
  doctor: DoctorProfile;
  experience: DoctorExperience;
  onClose: () => void;
  onAsk: AskNavigator;
  onSave: (completedIndexes: number[], note: string) => void;
  initialCompleted: boolean[];
  initialNote: string;
}) {
  const sheetRef = useRef<HTMLElement>(null);
  useDialogFocusTrap(sheetRef, onClose);
  const [completed, setCompleted] = useState(() => experience.steps.map((_step, index) => Boolean(initialCompleted[index])));
  const [note, setNote] = useState(initialNote);
  const [saved, setSaved] = useState(false);
  const done = completed.filter(Boolean).length;

  const toggle = (index: number) => {
    setCompleted((current) => current.map((value, itemIndex) => itemIndex === index ? !value : value));
  };

  const save = () => {
    onSave(completed.flatMap((value, index) => value ? [index] : []), note.trim());
    setSaved(true);
  };

  return (
    <motion.div className="journey-sheet-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.section
        ref={sheetRef}
        className="journey-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={experience.primaryTitle}
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 60, opacity: 0 }}
        transition={{ type: "spring", damping: 28, stiffness: 320 }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="journey-sheet-handle" />
        <button className="journey-sheet-close" onClick={onClose} aria-label="关闭评估"><XIcon size={18} /></button>
        {!saved ? (
          <>
            <span className="journey-eyebrow">PRIVATE SELF-CHECK</span>
            <h2>{experience.primaryTitle}</h2>
            <p>先完成 3 项信息梳理，可随时在“管理”或“我的”中查看；登录微信后支持跨设备同步。</p>
            <div className="journey-sheet-progress"><i style={{ width: `${(done / experience.steps.length) * 100}%` }} /></div>
            <small>{done} / {experience.steps.length} 已完成</small>
            <div className="journey-sheet-steps">
              {experience.steps.map((step, index) => (
                <button className={completed[index] ? "is-complete" : ""} key={step.title} onClick={() => toggle(index)}>
                  <span><JourneyIcon name={step.icon} size={20} /></span>
                  <div><b>{step.title}</b><em>{step.description}</em></div>
                  <CheckCircleIcon size={23} weight={completed[index] ? "fill" : "regular"} />
                </button>
              ))}
            </div>
            <label className="journey-record-note">
              <span>补充本次记录（可选）</span>
              <textarea
                value={note}
                maxLength={300}
                onChange={(event) => setNote(event.target.value)}
                placeholder={doctor.slug === "tang-jinsong" ? "例如：入睡约 30 分钟、夜醒 2 次，焦虑 6/10，白天工作效率下降" : "可补充时间、程度、变化或其他想记录的信息"}
              />
              <small>{note.length} / 300</small>
            </label>
            <button className="journey-primary-button" onClick={save} disabled={done === 0}>
              保存评估记录 <CaretRightIcon size={18} weight="bold" />
            </button>
            <div className="journey-privacy"><LockKeyIcon size={14} /> 至少完成一项即可保存，结果不构成诊断</div>
          </>
        ) : (
          <div className="journey-sheet-success">
            <span><CheckCircleIcon size={42} weight="duotone" /></span>
            <h2>记录已保存</h2>
            <p>已为本次咨询整理 {done} 项信息。继续提问时，可补充具体时间、检查结果和变化趋势。</p>
            <button className="journey-primary-button" onClick={() => { onClose(); onAsk(`我刚完成${experience.primaryTitle}，想继续了解下一步应该关注什么？`); }}>
              带着记录继续咨询 <ChatCircleDotsIcon size={18} weight="fill" />
            </button>
            <button className="journey-secondary-button" onClick={onClose}>返回首页</button>
          </div>
        )}
      </motion.section>
    </motion.div>
  );
}

const createDailyTasks = (stepCount: number): DoctorDailyTasks => ({
  dateKey: localDateKey(),
  completed: Array.from({ length: stepCount }, () => false),
});

const normalizeDailyTasks = (value: DoctorDailyTasks | boolean[] | undefined, stepCount: number): DoctorDailyTasks => {
  const today = localDateKey();
  if (Array.isArray(value)) {
    return { dateKey: today, completed: Array.from({ length: stepCount }, (_item, index) => Boolean(value[index])) };
  }
  if (!value || value.dateKey !== today || !Array.isArray(value.completed)) return createDailyTasks(stepCount);
  return { dateKey: today, completed: Array.from({ length: stepCount }, (_item, index) => Boolean(value.completed[index])) };
};

const dailyTasksNeedMigration = (value: DoctorDailyTasks | boolean[] | undefined, normalized: DoctorDailyTasks) => {
  if (!value || Array.isArray(value) || !Array.isArray(value.completed)) return true;
  return value.dateKey !== normalized.dateKey || value.completed.length !== normalized.completed.length;
};

type TangRecordSection = "all" | "sleep" | "emotion" | "function";

function BuilderHomeSections({ doctor, experience, onAsk, onManage, onWellnessOpen, recordedDays }: { doctor: PublicDoctorDetail; experience: DoctorExperience; onAsk: AskNavigator; onManage: () => void; onWellnessOpen?: (view: WellnessView) => void; recordedDays: number }) {
  return <div className="builder-home-sections">{getBuilderComponents(doctor.builder).map(component => {
    if (component.id === 'home') return null;
    if (component.id === 'content') return <PublishedContentSection key={component.id} content={doctor.content} title={component.label || '健康科普'} onAsk={onAsk} />;
    if (component.id === 'assessments') return <BuilderAssessments key={component.id} doctor={doctor} onAsk={onAsk} />;
    if (component.id === 'services') return <ServicesPanel key={component.id} compact doctor={doctor} experience={experience} onAsk={onAsk} onManage={onManage} />;
    if (component.id === 'wellness' && onWellnessOpen) return <WellnessHome key={component.id} onOpen={onWellnessOpen} />;
    if (component.id === 'voice' && !voiceEnabled(doctor)) return null;
    return <section key={component.id} className="journey-assessment builder-home-module" data-component={component.id}><header className="journey-card-heading"><div><span className="journey-eyebrow">PERSONAL HEALTH SPACE</span><h2>{component.label || (component.id === 'records' ? '健康记录' : component.id === 'voice' ? '语音交流' : '健康问答')}</h2><p>{component.id === 'records' ? '近 7 日已记录 ' + recordedDays + ' 天；按实际情况补充指标与感受。' : component.id === 'voice' ? '可以用语音描述问题，也可以继续打字交流。' : doctor.welcomeMessage || '围绕健康问题进行科普问答与就医准备。'}</p></div></header>{component.id === 'records' && <div className="journey-specialty-tags">{doctor.builder?.recordFields.map(field => <span key={field.key}>{field.label}</span>)}</div>}<button type="button" className="journey-primary-button" onClick={() => component.id === 'records' ? onManage() : onAsk()}>{component.id === 'records' ? '填写记录与查看趋势' : '开始对话'}<CaretRightIcon size={18} /></button></section>;
  })}</div>;
}

function HomePanel({
  doctor,
  experience,
  onAsk,
  onWellnessOpen,
  onManage,
}: {
  doctor: PublicDoctorDetail;
  experience: DoctorExperience;
  onAsk: AskNavigator;
  onWellnessOpen?: (view: WellnessView) => void;
  onManage: () => void;
}) {
  const reduced = useReducedMotion();
  const [assessmentOpen, setAssessmentOpen] = useState(false);
  const [recordSection, setRecordSection] = useState<TangRecordSection>("all");
  const isTang = usesTangRecords(doctor);
  const today = useWellnessDay();
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [records, setRecords] = useDoctorLocalState<DoctorHealthRecord[]>(doctor.slug, "health-records", []);
  const [dailyTasks, setDailyTasks] = useDoctorLocalState<DoctorDailyTasks>(doctor.slug, "health-daily-tasks", createDailyTasks(experience.steps.length));
  const [privacy] = useDoctorLocalState<DoctorPrivacySettings>(doctor.slug, "privacy", { saveChat: true, voicePlayback: true, reminders: true });
  const HeroIcon = journeyIcons[experience.heroIcon];
  const usesGrowthArtwork = doctor.slug === "fu-junfen" && experience.primaryTitle.includes("生长");
  const tasks = normalizeDailyTasks(dailyTasks, experience.steps.length);
  const sortedRecords = useMemo(() => sortHealthRecords(records, new Date(), 370, doctor.builder ? configuredRecordConfig(doctor, getSpecialtyRecordConfig(doctor.slug)) : undefined), [records, doctor]);
  const todayHomeRecord = records.find((record) => record.source === "home" && healthRecordDateKey(record) === today);
  const todayTangRecord = usesTangRecords(doctor)
    ? mergeTangDailyRecords(sortedRecords, localDateKey())
    : undefined;
  const todayTangMetrics = usesTangRecords(doctor) ? buildHealthTrend(records, 1)[0]?.metrics : undefined;
  const specialtyConfig = configuredRecordConfig(doctor, getSpecialtyRecordConfig(doctor.slug));
  const isSpecialty = Boolean(doctor.builder) || !["tang-jinsong", "yu-wen"].includes(doctor.slug);
  const specialtyToday = buildSpecialtyStats(records, specialtyConfig, 1).trend[0]?.measurements;
  const homeSteps = isSpecialty ? specialtyConfig.fields.slice(0, 3).map((field) => ({
    icon: "clipboard" as JourneyIconKey,
    title: field.label,
    description: specialtyToday?.[field.key] === undefined ? field.hint || `按实际情况填写${field.unit ? `，单位：${field.unit}` : ""}`
      : `今日已填：${field.key === "menstrualStatus" ? (specialtyToday[field.key] === 1 ? "正在经期" : "不在经期") : `${specialtyToday[field.key]} ${field.unit}`}`,
  })) : isTang ? experience.steps.map((step, index) => ({ ...step, description: ["记录时长、入睡耗时与夜醒", "记录情绪稳定度与焦虑程度", "记录白天精力与生活影响"][index] || step.description })) : experience.steps;
  const displayedCompleted = usesTangRecords(doctor) ? [
    todayTangMetrics?.sleepDurationMinutes !== undefined || todayTangMetrics?.sleepLatencyMinutes !== undefined || todayTangMetrics?.nightAwakenings !== undefined,
    todayTangMetrics?.moodScore !== undefined || todayTangMetrics?.anxietyScore !== undefined,
    todayTangMetrics?.energyScore !== undefined || todayTangMetrics?.daytimeImpactScore !== undefined,
  ] : isSpecialty ? specialtyConfig.fields.slice(0, 3).map((field) => specialtyToday?.[field.key] !== undefined) : tasks.completed;
  const recordedDays = recentRecordDayCount(records);
  const metric = {
    label: "近 7 日记录完成度",
    value: `${recordedDays} / 7 天`,
    note: recordedDays ? "按实际填写日期统计，可在管理页查看趋势" : "填写第一条记录后，这里会显示实际进度",
    progress: Math.round((recordedDays / 7) * 100),
  };
  const openRecord = (section: TangRecordSection = "all") => {
    if (isSpecialty) return onManage();
    setRecordSection(section);
    setAssessmentOpen(true);
  };

  useEffect(() => {
    if (dailyTasksNeedMigration(dailyTasks, tasks)) setDailyTasks(tasks);
  }, [dailyTasks, setDailyTasks, tasks]);

  const saveAssessment = (completedIndexes: number[], note: string) => {
    const completedTitles = completedIndexes.map((index) => experience.steps[index]?.title).filter(Boolean);
    const createdAt = new Date().toISOString();
    const record: DoctorHealthRecord = { id: createLocalId("record"), createdAt, dateKey: localDateKey(), completedTitles, note, source: "home" };
    const nextRecords = upsertHealthRecord(records, record);
    setRecords(nextRecords);
    setDailyTasks(dailyTasksFromRecords(nextRecords, experience.steps));
  };

  const saveTangHomeRecord = (metrics: DoctorHealthMetrics, note: string) => {
    setRecords((currentRecords) => {
      const now = new Date().toISOString();
      const dateKey = localDateKey();
      const existing = mergeTangDailyRecords(currentRecords, dateKey);
      const record: DoctorHealthRecord = {
        schemaVersion: 2,
        id: existing?.id ?? createLocalId("record"),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        dateKey,
        completedTitles: [],
        ...(note ? { note } : {}),
        source: existing?.source ?? "home",
        metrics,
      };
      return upsertTangDailyRecord(currentRecords, record);
    });
  };

  const homeResources = <>
    <motion.section className="journey-concerns" {...fadeUp(reduced)}>
      <header><div><span className="journey-eyebrow">WEEKLY FOCUS</span><h2>本周大家最关心</h2></div><ChatCircleDotsIcon size={24} weight="duotone" /></header>
      {experience.concerns.map((item) => <button key={item.title} onClick={() => onAsk(item.title)}><span><JourneyIcon name={item.icon} size={22} /></span><div><b>{item.title}</b><p>{item.description}</p></div><CaretRightIcon size={18} /></button>)}
    </motion.section>
    {componentEnabled(doctor, "content") && <PublishedContentSection content={doctor.content} onAsk={onAsk} />}
  </>;

  return (
    <div className={`journey-home${isTang ? " journey-tang-home" : ""}`}>
      <section className="journey-hero">
        <div className="journey-topbar">
          <div className="journey-brandline"><span><BabyIcon size={17} weight="duotone" /></span><b>{experience.tagline}</b></div>
          {doctor.slug !== "yu-wen" && <div className="journey-notice-wrap">
            <button className="journey-icon-button" onClick={() => setNoticeOpen((value) => !value)} aria-label="查看提醒" aria-expanded={noticeOpen}>
              <BellSimpleIcon size={20} weight="regular" />
              {privacy.reminders && <i />}
            </button>
            <AnimatePresence>
              {noticeOpen && (
                <motion.div className="journey-notice" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
                  <b>健康提醒</b>
                  <p>{privacy.reminders ? realHealthReminder(recordedDays, records.some(record => healthRecordDateKey(record) === today)) : "健康提醒已关闭，可在“我的－隐私与设置”中重新开启。"}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>}
        </div>

        <motion.div className="journey-doctor-heading" {...fadeUp(reduced)}>
          <div className="journey-doctor-copy">
            <span className="journey-eyebrow">{experience.eyebrow}</span>
            <div className="journey-name-row"><h1>{doctor.name}</h1><span>{doctor.department}</span></div>
            <p>{doctor.hospital}</p>
            <h2>{isTang ? "一起梳理困扰，找到下一步" : doctor.specialty}</h2>
          </div>
          <div className={`journey-hero-art ${usesGrowthArtwork ? "has-image" : ""}`} aria-hidden="true">
            {usesGrowthArtwork ? (
              <img src="/assets/doctors/fu-growth-hero.png" alt="" />
            ) : (
              <><span><HeroIcon size={58} weight="duotone" /></span><i /><em /></>
            )}
          </div>
        </motion.div>
        <div className="journey-specialty-tags">
          {doctor.topics.slice(0, 3).map((topic) => <span key={topic}>{topic}</span>)}
        </div>
        {isTang && <div className="journey-tang-start">
          <button className="journey-primary-button" onClick={() => onAsk()}><ChatCircleDotsIcon size={20} weight="fill" /> 开始对话 <CaretRightIcon size={18} /></button>
          <p>聊聊最近的睡眠、情绪，或你正在经历的困扰。</p>
        </div>}
      </section>

      {doctor.builder ? <BuilderHomeSections doctor={doctor} experience={experience} onAsk={onAsk} onManage={onManage} onWellnessOpen={onWellnessOpen} recordedDays={recordedDays} /> : usesWellness(doctor) && onWellnessOpen ? <WellnessHome onOpen={onWellnessOpen} /> : componentEnabled(doctor, "records") && <motion.section className="journey-assessment" {...fadeUp(reduced)}>
        <header className="journey-card-heading">
          <div>
            <span className="journey-eyebrow">YOUR HEALTH JOURNEY</span>
            <h2>{isSpecialty ? specialtyConfig.title : experience.primaryTitle}</h2>
            <p>{isTang ? "每天一份记录，可随时补充或修改。" : isSpecialty ? specialtyConfig.description : experience.primarySubtitle}</p>
          </div>
          <span className="journey-live-badge"><i /> 关注健康每一步</span>
        </header>

        {isTang ? <div className="journey-tang-record-summary"><span>近7日已记录 <b>{recordedDays} / 7 天</b></span><button onClick={onManage}>查看趋势 <CaretRightIcon size={15} /></button></div> : <div className={`journey-metric ${usesGrowthArtwork ? "growth-metric" : ""}`}>
          <div className="journey-metric-copy">
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <p>{metric.note}</p>
          </div>
          {usesGrowthArtwork ? (
            <img src="/assets/doctors/fu-growth-curve.png" alt="儿童身高百分位趋势示意图" />
          ) : (
            <div className="journey-metric-progress" aria-label={`${metric.label} ${metric.progress}%`}>
              <div><i style={{ width: `${metric.progress}%` }}><span /></i></div>
              <small><span>起点</span><span>本周</span><span>目标</span></small>
            </div>
          )}
        </div>}

        <div className="journey-step-list">
          {homeSteps.map((step, index) => (
            <button className={displayedCompleted[index] ? "is-complete" : ""} key={step.title} onClick={() => openRecord(isTang ? (["sleep", "emotion", "function"] as const)[index] : "all")}>
              <span><JourneyIcon name={step.icon} size={22} /></span>
              <div><b>{step.title}</b><small>{step.description}</small></div>
              <em>0{index + 1}</em><CaretRightIcon size={17} />
            </button>
          ))}
        </div>

        <div className="journey-card-actions">
          <button className="journey-primary-button" onClick={() => openRecord()}>
            {isSpecialty ? "填写今日记录" : experience.cta} <CaretRightIcon size={18} weight="bold" />
          </button>
          <div className="journey-privacy"><ShieldCheckIcon size={15} weight="duotone" /> 信息仅用于健康记录与科普，不替代医生诊断</div>
          {sortedRecords[0] && <div className="journey-last-record"><ClockCounterClockwiseIcon size={14} /> 最近记录：{healthRecordDateKey(sortedRecords[0])}</div>}
        </div>
      </motion.section>}

      {!doctor.builder && (isTang ? <details className="journey-tang-disclosure journey-tang-resources"><summary>健康科普与近期关注 <CaretRightIcon size={18} /></summary>{homeResources}</details> : homeResources)}

      {isTang ? <details className="journey-tang-disclosure"><summary>了解{doctor.name}智能体 <CaretRightIcon size={18} /></summary><p>{doctor.title}</p><p>{doctor.specialty}</p><p>{doctor.intro}</p><p>信息仅用于健康科普与就医准备，不替代医生诊断。</p></details> : <section className="journey-expert-note">
        <span>{doctor.name.slice(0, 1)}</span>
        <div><b>{doctor.name}{doctorExperiences[doctor.slug] ? "医生智能体" : "智能体"}</b><p>{doctor.intro}</p></div>
        <button onClick={() => onAsk()}>立即提问</button>
      </section>}

      {typeof document !== "undefined" && createPortal(
        <AnimatePresence>
          {assessmentOpen && (usesTangRecords(doctor)
            ? <TangHomeRecordSheet doctor={doctor} initialRecord={todayTangRecord} initialSection={recordSection} onClose={() => setAssessmentOpen(false)} onAsk={onAsk} onSave={saveTangHomeRecord} />
            : <AssessmentSheet doctor={doctor} experience={experience} initialCompleted={tasks.completed} initialNote={todayHomeRecord?.note || ""} onClose={() => setAssessmentOpen(false)} onAsk={onAsk} onSave={saveAssessment} />)}
        </AnimatePresence>,
        document.querySelector(".journey-phone") ?? document.body,
      )}
    </div>
  );
}

type VoiceStatus = "ready" | "starting" | "recording" | "transcribing" | "thinking" | "speaking" | "error";
type CaptureOwner = "conversation" | null;

const voiceStatusText: Record<VoiceStatus, string> = {
  ready: "点击话筒开始说话",
  starting: "正在启用麦克风",
  recording: "正在聆听，说完点击发送",
  transcribing: "正在处理语音，请稍候",
  thinking: "正在认真听你的心事，整理回复",
  speaking: "正在播报回复",
  error: "语音对话暂时不可用",
};

const friendlyVoiceError = (error: unknown, feature = "语音对话") => {
  if (!(error instanceof Error)) return `${feature}暂时不可用，请稍后再试。`;
  if (error.name === "NotAllowedError" || /permission|denied/i.test(error.message)) return "麦克风权限未开启，请在微信或浏览器设置中允许使用麦克风后重试。";
  if (error.name === "NotFoundError") return "没有检测到可用麦克风，请检查设备后重试。";
  if (error.name === "NotReadableError") return "麦克风正被其他应用占用，请关闭占用麦克风的应用后重试。";
  if (error.name === "TimeoutError" || /timed?\s*out|timeout/i.test(error.message)) return `${feature}等待超时，请重试。`;
  if (error instanceof TypeError || /load failed|failed to fetch|networkerror|network request failed/i.test(error.message)) return "网络连接中断，请检查网络后重试；你的问题已保留。";
  return error.message || `${feature}暂时不可用，请稍后再试。`;
};

const transcribeRecording = async (recording: Blob, signal: AbortSignal) => {
  const response = await fetch("/api/asr", {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: recording,
    signal: mergeAbortSignals(signal, AbortSignal.timeout(100_000)),
  });
  const data = await response.json().catch(() => ({})) as { text?: string; error?: string };
  if (!response.ok || !data.text?.trim()) throw new Error(data.error || "没有识别到清晰语音，请再说一次。");
  return data.text.trim();
};

const mergeAbortSignals = (first: AbortSignal | undefined, second: AbortSignal) => {
  if (!first) return second;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([first, second]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (first.aborted || second.aborted) controller.abort();
  else {
    first.addEventListener("abort", abort, { once: true });
    second.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
};

function AskPanel({
  doctor,
  experience,
  initialQuestion,
  initialShareHealthRecords,
  onConsumeInitialQuestion,
}: {
  doctor: PublicDoctorProfile;
  experience: DoctorExperience;
  initialQuestion: string;
  initialShareHealthRecords: boolean;
  onConsumeInitialQuestion: () => void;
}) {
  const preview = useDoctorPreview();
  const templatePreview = useDoctorTemplatePreview();
  const greeting = useMemo<DoctorChatMessage>(() => ({
    id: `greeting-${doctor.slug}`,
    role: "assistant",
    text: doctor.welcomeMessage || (doctor.slug === "tang-jinsong"
      ? "你好，我先听你说。可以聊睡眠、情绪和日常状态；我会尽量用短话讲清楚，再给你一两个能做的建议。这里仅做科普，不能替代面诊。"
      : `您好，这里是${doctor.name}的健康问答。我可以围绕${doctor.specialty || "日常健康知识"}提供健康科普和就医准备建议。我的回复不能替代医生面诊、诊断或处方。`),
    createdAt: new Date().toISOString(),
  }), [doctor.name, doctor.slug, doctor.specialty, doctor.welcomeMessage]);
  const [privacy, setPrivacy] = useDoctorLocalState<DoctorPrivacySettings>(doctor.slug, "privacy", { saveChat: true, voicePlayback: true, reminders: true });
  const [voiceHintDismissed, setVoiceHintDismissed] = useDoctorLocalState<boolean>(doctor.slug, "voice-input-hint-dismissed", false);
  const voicePlaybackEnabled = useRef(privacy.voicePlayback);
  voicePlaybackEnabled.current = privacy.voicePlayback && (doctor.builder ? voiceEnabled(doctor) && doctor.builder.voice.autoPlay : true);
  const [messages, setMessages] = useDoctorLocalState<DoctorChatMessage[]>(doctor.slug, "chat-messages", [greeting], privacy.saveChat);
  const [favorites, setFavorites] = useDoctorLocalState<DoctorFavorite[]>(doctor.slug, "favorites", []);
  const [healthRecords] = useDoctorLocalState<DoctorHealthRecord[]>(doctor.slug, "health-records", []);
  const healthContext = useMemo(() => buildHealthContextPayload(healthRecords, new Date(), doctor.builder ? configuredRecordConfig(doctor, getSpecialtyRecordConfig(doctor.slug)) : undefined), [healthRecords, doctor]);
  const canShareHealthRecords = healthContextEnabled(doctor) && healthContext.records.length > 0;

  useEffect(() => setMessages(stripStoredCitationDetails), [setMessages]);
  const draftKey = useMemo(() => doctorSessionKey(preview ? previewStorageSlug(doctor.slug) : doctor.slug, "chat-draft"), [doctor.slug, preview]);
  const [input, setInput] = useState(() => {
    if (initialQuestion) return initialQuestion;
    try { return window.sessionStorage.getItem(draftKey) || ""; } catch { return ""; }
  });
  const [busy, setBusy] = useState(false);
  const [streamingReply, setStreamingReply] = useState("");
  const [copiedId, setCopiedId] = useState("");
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("ready");
  const [voiceError, setVoiceError] = useState("");
  const [voiceElapsed, setVoiceElapsed] = useState(0);
  const [playingMessageId, setPlayingMessageId] = useState("");
  const [playbackStatus, setPlaybackStatus] = useState<"idle" | "preparing" | "playing" | "blocked" | "error">("idle");
  const replayText = useRef("");
  const replyTiming = useRef({ started: 0, firstText: 0, firstAudio: 0 });
  const [shareHealthRecords, setShareHealthRecords] = useState(() => initialShareHealthRecords && canShareHealthRecords);
  const [healthContextNotice, setHealthContextNotice] = useState("");
  const messageScroll = useRef<HTMLDivElement>(null);
  const messageContent = useRef<HTMLDivElement>(null);
  const voiceErrorDetails = useRef<HTMLDetailsElement>(null);
  const scrollFollow = useRef(createChatScrollFollow(messages.some((message) => message.role === "user")));
  const touchY = useRef<number>();
  const [voiceErrorExpanded, setVoiceErrorExpanded] = useState(false);
  const audio = useRef<HTMLAudioElement>();
  const speechAudioContext = useRef<AudioContext>();
  const speechSources = useRef(new Set<AudioBufferSourceNode>());
  const speechScheduledUntil = useRef(0);
  const playbackCancel = useRef<() => void>();
  const ttsRequestController = useRef<AbortController>();
  const pendingSpeech = useRef<ReturnType<typeof createSpeechQueue>>();
  const playbackRunId = useRef(0);
  const chatRunId = useRef(0);
  const requestController = useRef<AbortController>();
  const voiceController = useRef<AbortController>();
  const voiceChatActive = useRef(false);
  const voiceLimitTimer = useRef<number>();
  const voiceElapsedTimer = useRef<number>();
  const voiceStartedAt = useRef(0);
  const healthContextNoticeTimer = useRef<number>();
  const finishVoiceRef = useRef<() => Promise<void>>(async () => undefined);
  const captureOwnerRef = useRef<CaptureOwner>(null);
  const captureFinishingRef = useRef<CaptureOwner>(null);
  const captureRunIdRef = useRef(0);
  const captureTransitionRef = useRef<Promise<unknown>>();
  const recorder = useWavRecorder();
  const cancelRecorder = recorder.cancel;
  const hasVoiceConversation = voiceEnabled(doctor);
  const showVoiceStatus = hasVoiceConversation && ((voiceHintDismissed !== true && (voiceMode || !messages.some((message) => message.role === "user"))) || voiceStatus !== "ready" || playbackStatus !== "idle" || Boolean(voiceError));
  const voiceCapturing = ["starting", "recording", "transcribing"].includes(voiceStatus);
  const interactionLocked = busy || voiceCapturing;
  const voiceElapsedLabel = (voiceElapsed === 60 ? "01:00" : "00:" + String(voiceElapsed).padStart(2, "0"));

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const scroll = messageScroll.current;
      if (scroll && scrollFollow.current.shouldFollow() && messages.some((message) => message.role === "user")) {
        scroll.scrollTo({ top: chatBottomOffset(scroll), behavior: "auto" });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, busy, streamingReply, showVoiceStatus, voiceError]);

  useEffect(() => {
    const scroll = messageScroll.current, content = messageContent.current;
    if (!scroll || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (scrollFollow.current.shouldFollow()) scroll.scrollTo({ top: chatBottomOffset(scroll), behavior: "auto" });
    });
    observer.observe(scroll);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  useEffect(() => setVoiceErrorExpanded(false), [voiceError]);

  const showVoiceErrorDetails = () => {
    scrollFollow.current.pause();
    const open = !voiceErrorExpanded;
    setVoiceErrorExpanded(open);
    if (!open) return;
    requestAnimationFrame(() => {
      const scroll = messageScroll.current, details = voiceErrorDetails.current;
      if (scroll && details) scroll.scrollTo({ top: scroll.scrollTop + details.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 8, behavior: "auto" });
    });
  };

  useEffect(() => {
    if (!messages.length) setMessages([{ ...greeting, createdAt: new Date().toISOString() }]);
    else if (messages.some((message) => message.id === greeting.id && message.text !== greeting.text)) {
      setMessages((current) => current.map((message) => message.id === greeting.id ? { ...message, text: greeting.text } : message));
    }
  }, [greeting, messages, setMessages]);

  useEffect(() => {
    if (!initialQuestion) return;
    setInput(initialQuestion);
    if (initialShareHealthRecords && canShareHealthRecords) setShareHealthRecords(true);
    onConsumeInitialQuestion();
  }, [canShareHealthRecords, initialQuestion, initialShareHealthRecords, onConsumeInitialQuestion]);

  useEffect(() => {
    try {
      if (input) window.sessionStorage.setItem(draftKey, input);
      else window.sessionStorage.removeItem(draftKey);
    } catch {
      // 受限 WebView 中保留当前组件会话即可。
    }
  }, [draftKey, input]);

  useEffect(() => () => {
    requestController.current?.abort();
    voiceController.current?.abort();
    captureRunIdRef.current += 1;
    captureOwnerRef.current = null;
    captureFinishingRef.current = null;
    if (voiceLimitTimer.current) window.clearTimeout(voiceLimitTimer.current);
    if (voiceElapsedTimer.current) window.clearInterval(voiceElapsedTimer.current);
    if (healthContextNoticeTimer.current) window.clearTimeout(healthContextNoticeTimer.current);
    void cancelRecorder();
    ttsRequestController.current?.abort();
    pendingSpeech.current?.cancel();
    playbackCancel.current?.();
    audio.current?.pause();
    for (const source of speechSources.current) {
      try { source.stop(); } catch { /* 已结束的音频节点无需重复停止。 */ }
    }
    speechSources.current.clear();
    if (speechAudioContext.current) speechAudioContext.current.onstatechange = null;
    void speechAudioContext.current?.close();
    window.speechSynthesis?.cancel();
  }, [cancelRecorder]);

  const toggleHealthContext = () => {
    if (!canShareHealthRecords) {
      if (healthContextNoticeTimer.current) window.clearTimeout(healthContextNoticeTimer.current);
      setHealthContextNotice("暂无健康记录，请先到“管理”添加");
      healthContextNoticeTimer.current = window.setTimeout(() => setHealthContextNotice(""), 1800);
      return;
    }
    setHealthContextNotice("");
    setShareHealthRecords((value) => !value);
  };

  const stopPlayback = () => {
    playbackRunId.current += 1;
    pendingSpeech.current?.cancel();
    pendingSpeech.current = undefined;
    ttsRequestController.current?.abort();
    ttsRequestController.current = undefined;
    playbackCancel.current?.();
    playbackCancel.current = undefined;
    audio.current?.pause();
    audio.current = undefined;
    for (const source of speechSources.current) {
      try { source.stop(); } catch { /* 已结束的音频节点无需重复停止。 */ }
    }
    speechSources.current.clear();
    if (speechAudioContext.current) speechScheduledUntil.current = speechAudioContext.current.currentTime;
    window.speechSynthesis?.cancel();
    setPlaybackStatus("idle");
  };

  const ensureSpeechAudioContext = async () => {
    const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return undefined;
    let context = speechAudioContext.current;
    if (!context || context.state === "closed") {
      context = new AudioContextClass();
      speechAudioContext.current = context;
      speechScheduledUntil.current = context.currentTime;
      context.onstatechange = () => {
        if (context.state !== "running" && context.state !== "closed" && speechSources.current.size > 0) {
          setPlaybackStatus("blocked");
          setVoiceError("浏览器暂停了声音播放，请点击“恢复播报”。");
        }
      };
    }
    await resumeSpeechContext(context);
    if (speechScheduledUntil.current < context.currentTime) speechScheduledUntil.current = context.currentTime;
    return context;
  };

  const schedulePcmAudio = (context: AudioContext, base64: string, sampleRate: number, runId: number) => {
    if (runId !== playbackRunId.current) return false;
    if (context.state !== "running") throw new SpeechPlaybackError("AUDIO_BLOCKED");
    const binary = window.atob(base64);
    const byteLength = binary.length - (binary.length % 2);
    if (!byteLength) return false;
    const bytes = new Uint8Array(byteLength);
    for (let index = 0; index < byteLength; index += 1) bytes[index] = binary.charCodeAt(index);
    const view = new DataView(bytes.buffer);
    const frameCount = byteLength / 2;
    const audioBuffer = context.createBuffer(1, frameCount, sampleRate || 24_000);
    const channel = audioBuffer.getChannelData(0);
    for (let index = 0; index < frameCount; index += 1) channel[index] = view.getInt16(index * 2, true) / 32_768;
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    const startsAt = getPcmStartTime(context.currentTime, speechScheduledUntil.current);
    speechScheduledUntil.current = startsAt + audioBuffer.duration;
    speechSources.current.add(source);
    source.onended = () => speechSources.current.delete(source);
    source.start(startsAt);
    setPlaybackStatus("playing");
    if (!replyTiming.current.firstAudio) {
      replyTiming.current.firstAudio = performance.now();
      performance.measure("tang-first-audio-scheduled", { start: replyTiming.current.started || replyTiming.current.firstAudio, end: replyTiming.current.firstAudio });
    }
    return true;
  };

  const waitForScheduledSpeech = async (runId: number, signal?: AbortSignal) => {
    const context = speechAudioContext.current;
    if (!context) return;
    await waitForSpeechTimeline({ context, scheduledUntil: () => speechScheduledUntil.current, isActive: () => runId === playbackRunId.current, signal });
  };

  const reportPlaybackFailure = (error: unknown, runId: number) => {
    if (runId !== playbackRunId.current) return;
    stopPlayback();
    setPlayingMessageId("");
    setPlaybackStatus(error instanceof SpeechPlaybackError ? "blocked" : "error");
    setVoiceError(error instanceof SpeechPlaybackError ? error.message : "暂时无法播报，回复文字已保留，可点击“重试播报”。");
  };

  const playSpeech = async (
    text: string,
    signal?: AbortSignal,
    replaceCurrent = true,
    expectedRunId?: number,
    speechSessionId = createLocalId("speech-manual"),
  ) => {
    if (captureOwnerRef.current && !captureFinishingRef.current) return;
    if (replaceCurrent) stopPlayback();
    const runId = expectedRunId ?? playbackRunId.current;
    if (signal?.aborted || runId !== playbackRunId.current) return;
    const speechText = formatMedicalText(stripChatDisclaimer(text))
      .replace(/^•\s+/gm, "")
      .replace(/\n+/g, "。")
      .trim();
    if (!speechText) return;
    setPlaybackStatus((current) => current === "playing" ? current : "preparing");
    const ttsController = new AbortController();
    ttsRequestController.current = ttsController;
    const activeSignal = mergeAbortSignals(signal, ttsController.signal);
    let streamedAudio = false;
    try {
      const context = await ensureSpeechAudioContext();
      if (context) {
        const streamResponse = await fetch(preview ? `/api/admin/agents/${encodeURIComponent(doctor.slug)}/tts/stream` : "/api/tts/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: speechText, doctorSlug: doctor.slug, ...(preview ? { draftHash: doctor.draftHash } : {}), speechRunId: speechSessionId }),
          signal: mergeAbortSignals(activeSignal, AbortSignal.timeout(30_000)),
        });
        if (!streamResponse.ok) throw new Error("流式语音合成不可用");
        let completed = false;
        for await (const event of readAudioStream(streamResponse)) {
          if (activeSignal.aborted || runId !== playbackRunId.current) return;
          if (event.type === "audio") streamedAudio = schedulePcmAudio(context, event.data, event.sampleRate, runId) || streamedAudio;
          else if (event.type === "error") throw new Error(event.error);
          else if (event.type === "done") completed = true;
        }
        if (!completed || !streamedAudio) throw new Error("流式语音未完整返回");
        if (ttsRequestController.current === ttsController) ttsRequestController.current = undefined;
        return;
      }
    } catch (error) {
      if (ttsRequestController.current === ttsController) ttsRequestController.current = undefined;
      if (activeSignal.aborted || runId !== playbackRunId.current) return;
      if (error instanceof SpeechPlaybackError) { reportPlaybackFailure(error, runId); return; }
      if (streamedAudio) { reportPlaybackFailure(error, runId); return; }
    }

    // A fallback segment must follow previously scheduled PCM, not overlap it.
    try {
      await waitForScheduledSpeech(runId, activeSignal);
    } catch (error) {
      reportPlaybackFailure(error, runId);
      return;
    }
    if (activeSignal.aborted || runId !== playbackRunId.current) return;
    ttsRequestController.current = ttsController;
    try {
      const response = await fetch(preview ? `/api/admin/agents/${encodeURIComponent(doctor.slug)}/tts` : "/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: speechText, doctorSlug: doctor.slug, ...(preview ? { draftHash: doctor.draftHash } : {}) }),
        signal: mergeAbortSignals(activeSignal, AbortSignal.timeout(30_000)),
      });
      if (!response.ok) throw new Error("语音合成不可用");
      const url = URL.createObjectURL(await response.blob());
      if (ttsRequestController.current === ttsController) ttsRequestController.current = undefined;
      if (activeSignal.aborted || runId !== playbackRunId.current) { URL.revokeObjectURL(url); return; }
      const player = new Audio(url);
      player.preload = "auto";
      audio.current = player;
      await new Promise<void>((resolve) => {
        let settled = false;
        const startDeadline = window.setTimeout(() => { reportPlaybackFailure(new SpeechPlaybackError("AUDIO_BLOCKED"), runId); finish(); }, 8000);
        const playbackDeadline = window.setTimeout(() => { reportPlaybackFailure(new SpeechPlaybackError("AUDIO_STALLED"), runId); finish(); }, 120_000);
        const finish = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(startDeadline);
          window.clearTimeout(playbackDeadline);
          activeSignal.removeEventListener("abort", finish);
          player.removeEventListener("ended", finish);
          player.removeEventListener("error", fail);
          player.pause();
          URL.revokeObjectURL(url);
          if (audio.current === player) audio.current = undefined;
          if (playbackCancel.current === finish) playbackCancel.current = undefined;
          resolve();
        };
        const fail = (error?: unknown) => {
          if (!activeSignal.aborted && runId === playbackRunId.current) reportPlaybackFailure(error instanceof Error && error.name === "NotAllowedError" ? new SpeechPlaybackError("AUDIO_BLOCKED") : error, runId);
          finish();
        };
        playbackCancel.current = finish;
        activeSignal.addEventListener("abort", finish, { once: true });
        player.addEventListener("ended", finish, { once: true });
        player.addEventListener("error", fail, { once: true });
        void player.play().then(() => { window.clearTimeout(startDeadline); if (runId === playbackRunId.current) setPlaybackStatus("playing"); }).catch(fail);
      });
    } catch {
      if (ttsRequestController.current === ttsController) ttsRequestController.current = undefined;
      if (activeSignal.aborted || runId !== playbackRunId.current) return;
      if (!("speechSynthesis" in window)) { reportPlaybackFailure(new Error("语音播放不可用"), runId); return; }
      await new Promise<void>((resolve) => {
        const utterance = new SpeechSynthesisUtterance(speechText);
        let settled = false;
        const startDeadline = window.setTimeout(() => { reportPlaybackFailure(new SpeechPlaybackError("AUDIO_BLOCKED"), runId); finish(); }, 8000);
        const playbackDeadline = window.setTimeout(() => { reportPlaybackFailure(new SpeechPlaybackError("AUDIO_STALLED"), runId); finish(); }, 120_000);
        const finish = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(startDeadline);
          window.clearTimeout(playbackDeadline);
          activeSignal.removeEventListener("abort", finish);
          if (playbackCancel.current === finish) playbackCancel.current = undefined;
          resolve();
        };
        utterance.lang = "zh-CN";
        utterance.rate = 0.96;
        utterance.onstart = () => { window.clearTimeout(startDeadline); if (runId === playbackRunId.current) setPlaybackStatus("playing"); };
        utterance.onend = finish;
        utterance.onerror = () => {
          if (!activeSignal.aborted && runId === playbackRunId.current) reportPlaybackFailure(new Error("语音播放不可用"), runId);
          finish();
        };
        playbackCancel.current = finish;
        activeSignal.addEventListener("abort", finish, { once: true });
        window.speechSynthesis.speak(utterance);
      });
    }
  };

  const send = async (text = input, voiceInput = false, retryMessageId = "", voiceDurationSeconds?: number) => {
    const question = text.trim();
    if (templatePreview) return undefined;
    if (!question || requestController.current || (captureOwnerRef.current && !voiceInput)) return undefined;
    scrollFollow.current.send();
    const shouldSpeak = (hasVoiceConversation || voiceInput) && voicePlaybackEnabled.current;
    const userMessage: DoctorChatMessage = { id: createLocalId("chat-user"), role: "user", text: question, createdAt: new Date().toISOString(), ...(voiceInput ? { inputMode: "voice" as const, voiceDurationSeconds } : {}) };
    const assistantMessageId = createLocalId("chat-assistant");
    setMessages((current) => (retryMessageId
      ? current.filter((message) => message.id !== retryMessageId)
      : [...current, userMessage].slice(-100)));
    if (!voiceInput && !retryMessageId && text === input) setInput("");
    stopPlayback();
    replayText.current = "";
    replyTiming.current = { started: performance.now(), firstText: 0, firstAudio: 0 };
    setPlayingMessageId("");
    setBusy(true);
    voiceChatActive.current = voiceInput || shouldSpeak;
    setVoiceError("");
    setVoiceStatus(voiceInput || shouldSpeak ? "thinking" : "ready");
    setStreamingReply("");
    const controller = new AbortController();
    const runId = chatRunId.current + 1;
    chatRunId.current = runId;
    requestController.current = controller;
    const sharedHealthContext = shareHealthRecords && canShareHealthRecords ? healthContext : undefined;
    const requestBody = JSON.stringify({
      doctorSlug: doctor.slug,
      ...(preview ? { draftHash: doctor.draftHash } : {}),
      message: question,
      history: messages.filter((message) => !message.error).slice(-12).map((message) => ({
        role: message.role,
        content: chatMessageBody(message),
      })),
      ...(sharedHealthContext ? { healthContext: sharedHealthContext } : {}),
    });
    const speechSignal = voiceInput ? voiceController.current?.signal : undefined;
    const speechSessionId = createLocalId("speech-run");
    let speechRunId = playbackRunId.current;
    if (shouldSpeak) {
      stopPlayback();
      speechRunId = playbackRunId.current;
      // Resume during the send gesture, before the network response arrives.
      void ensureSpeechAudioContext().catch(() => undefined);
    }
    const isCurrentRun = () => chatRunId.current === runId && !controller.signal.aborted;
    const speechQueue = shouldSpeak ? createSpeechQueue({
      isActive: () => isCurrentRun() && voicePlaybackEnabled.current && !speechSignal?.aborted && playbackRunId.current === speechRunId,
      speak: (chunk, signal) => playSpeech(chunk, mergeAbortSignals(speechSignal, signal), false, speechRunId, speechSessionId),
    }) : undefined;
    pendingSpeech.current = speechQueue;
    let speechHandedOff = false;
    const disclaimerFilter = createChatDisclaimerFilter();
    let receivedReplyText = false;
    let reply = "";
    let retrieval: ChatRetrievalMetadata = {};
    let presentedReply = "";
    let uiTimer: number | undefined;
    const flushStreamingUi = () => {
      uiTimer = undefined;
      if (!isCurrentRun() || reply === presentedReply) return;
      presentedReply = reply;
      setStreamingReply(reply);
    };
    const appendBody = (delta: string) => {
      if (!delta || !isCurrentRun()) return;
      reply += delta;
      replayText.current = reply;
      if (!replyTiming.current.firstText) {
        replyTiming.current.firstText = performance.now();
        performance.measure("tang-first-text", { start: replyTiming.current.started, end: replyTiming.current.firstText });
      }
      if (uiTimer === undefined) uiTimer = window.setTimeout(flushStreamingUi, 55);
      speechQueue?.push(delta);
    };
    const appendDelta = (delta: string) => {
      if (!delta || !isCurrentRun()) return;
      receivedReplyText = true;
      appendBody(disclaimerFilter.push(delta));
    };
    try {
      let response = await fetch(preview ? `/api/admin/agents/${encodeURIComponent(doctor.slug)}/chat` : "/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
        signal: controller.signal,
      });

      let completed = false;
      if (preview || response.status === 404 || response.status === 405) {
        if (!preview) response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
          signal: controller.signal,
        });
        const data = await response.json() as { reply?: string; error?: string } & ChatRetrievalMetadata;
        if (!response.ok || !data.reply) throw new Error(data.error || "智能问答服务暂时不可用，请稍后再试。");
        retrieval = parseChatRetrieval(data);
        appendDelta(data.reply);
        completed = true;
      } else {
        if (!response.ok) {
          const data = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(data.error || "智能问答服务暂时不可用，请稍后再试。");
        }
        for await (const event of readChatStream(response)) {
          if (!isCurrentRun()) throw new DOMException("Aborted", "AbortError");
          if (event.type === "delta") appendDelta(event.text);
          else if (event.type === "error") throw new Error(event.error);
          else if (event.type === "result") {
            retrieval = { ...retrieval, ...parseChatRetrieval(event) };
            const resultText = typeof event.reply === "string" ? event.reply : typeof event.text === "string" ? event.text : "";
            if (!receivedReplyText && resultText) appendDelta(resultText);
          } else if (event.type === "done") {
            retrieval = { ...retrieval, ...parseChatRetrieval(event) };
            completed = true;
          }
        }
      }

      if (!isCurrentRun()) return undefined;
      if (!completed) throw new Error("智能问答流意外中断，请点击重试。");
      appendBody(disclaimerFilter.finish());
      reply = reply.trim();
      if (!reply) throw new Error("智能问答流意外中断，请点击重试。");
      const speechFinished = speechQueue?.finish();
      if (uiTimer !== undefined) window.clearTimeout(uiTimer);
      flushStreamingUi();
      const assistantMessage: DoctorChatMessage = { id: assistantMessageId, role: "assistant", text: reply, createdAt: new Date().toISOString(), ...retrieval };
      setMessages((current) => [...current, assistantMessage].slice(-100));
      if (sharedHealthContext) setShareHealthRecords(false);
      setStreamingReply("");
      if (speechQueue) {
        speechHandedOff = true;
        // Text generation owns the conversation lock; playback has its own lifetime.
        void (async () => {
          try {
            await speechFinished;
            await waitForScheduledSpeech(speechRunId, speechSignal);
          } catch (error) {
            if (!speechSignal?.aborted) reportPlaybackFailure(error, speechRunId);
          } finally {
            speechQueue.cancel();
            if (pendingSpeech.current === speechQueue) pendingSpeech.current = undefined;
            if (playbackRunId.current === speechRunId) setPlaybackStatus((current) => current === "blocked" || current === "error" ? current : "idle");
          }
        })();
      }
      return reply;
    } catch (error) {
      if (uiTimer !== undefined) window.clearTimeout(uiTimer);
      if (chatRunId.current === runId) setStreamingReply("");
      if (!isCurrentRun() || (error instanceof DOMException && error.name === "AbortError")) return undefined;
      if (shouldSpeak) {
        stopPlayback();
      }
      const message = friendlyVoiceError(error, "智能问答");
      const fallback = `${message} 你可以点击“重试”，或稍后重新发送。`;
      const errorMessage: DoctorChatMessage = { id: createLocalId("chat-error"), role: "assistant", text: fallback, createdAt: new Date().toISOString(), error: true, retryText: question, ...(voiceInput ? { inputMode: "voice" as const } : {}) };
      setMessages((current) => [...current, errorMessage].slice(-100));
      return undefined;
    } finally {
      if (!speechHandedOff) {
        speechQueue?.cancel();
        if (pendingSpeech.current === speechQueue) pendingSpeech.current = undefined;
      }
      if (uiTimer !== undefined) window.clearTimeout(uiTimer);
      if (requestController.current === controller) requestController.current = undefined;
      if (chatRunId.current === runId) {
        voiceChatActive.current = false;
        setBusy(false);
        setVoiceStatus((current) => current === "speaking" || current === "thinking" ? "ready" : current);
      }
    }
  };

  const clearChat = () => {
    if (messages.length > 1 && !window.confirm("确定清空当前对话记录吗？")) return;
    cancelVoice();
    chatRunId.current += 1;
    requestController.current?.abort();
    requestController.current = undefined;
    stopPlayback();
    setStreamingReply("");
    setBusy(false);
    setMessages([{ ...greeting, createdAt: new Date().toISOString() }]);
  };

  const copyMessage = async (message: DoctorChatMessage) => {
    try {
      const text = chatMessageBody(message);
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      setCopiedId(message.id);
      window.setTimeout(() => setCopiedId(""), 1500);
    } catch {
      setCopiedId("");
    }
  };

  const toggleFavorite = (message: DoctorChatMessage) => {
    setFavorites((current) => current.some((item) => item.id === message.id)
      ? current.filter((item) => item.id !== message.id)
      : [{ id: message.id, text: chatMessageBody(message), createdAt: message.createdAt }, ...current].slice(0, 50));
  };

  const queueRecorderCancel = () => {
    const pending = captureTransitionRef.current;
    const cancellation = (pending ? pending.catch(() => undefined) : Promise.resolve())
      .then(() => recorder.cancel())
      .catch(() => undefined);
    captureTransitionRef.current = cancellation;
    void cancellation.finally(() => {
      if (captureTransitionRef.current === cancellation) captureTransitionRef.current = undefined;
    });
  };

  const startRecorderCapture = async (owner: Exclude<CaptureOwner, null>, runId: number) => {
    while (captureTransitionRef.current) {
      const pending = captureTransitionRef.current;
      await pending.catch(() => undefined);
      if (captureOwnerRef.current !== owner || captureRunIdRef.current !== runId) return false;
    }
    if (captureOwnerRef.current !== owner || captureRunIdRef.current !== runId) return false;
    const operation = recorder.start();
    captureTransitionRef.current = operation;
    try {
      await operation;
    } finally {
      if (captureTransitionRef.current === operation) captureTransitionRef.current = undefined;
    }
    if (captureOwnerRef.current !== owner || captureRunIdRef.current !== runId) {
      queueRecorderCancel();
      return false;
    }
    return true;
  };

  const stopRecorderCapture = async () => {
    const operation = recorder.stop();
    captureTransitionRef.current = operation;
    try {
      return await operation;
    } finally {
      if (captureTransitionRef.current === operation) captureTransitionRef.current = undefined;
    }
  };

  const clearVoiceTimers = () => {
    if (voiceLimitTimer.current) window.clearTimeout(voiceLimitTimer.current);
    if (voiceElapsedTimer.current) window.clearInterval(voiceElapsedTimer.current);
    voiceLimitTimer.current = undefined;
    voiceElapsedTimer.current = undefined;
  };

  const startVoice = async () => {
    if (requestController.current || captureOwnerRef.current) return;
    setVoiceMode(true);
    setVoiceError("");
    setVoiceElapsed(0);
    stopPlayback();
    setPlayingMessageId("");
    voiceController.current?.abort();
    setVoiceStatus("starting");
    void ensureSpeechAudioContext().catch(() => undefined);
    const runId = ++captureRunIdRef.current;
    captureOwnerRef.current = "conversation";
    try {
      const started = await startRecorderCapture("conversation", runId);
      if (!started) return;
      voiceStartedAt.current = Date.now();
      setVoiceStatus("recording");
      voiceElapsedTimer.current = window.setInterval(() => setVoiceElapsed(Math.min(60, Math.floor((Date.now() - voiceStartedAt.current) / 1000))), 1000);
      voiceLimitTimer.current = window.setTimeout(() => void finishVoiceRef.current(), 60_000);
    } catch (error) {
      if (captureRunIdRef.current !== runId) return;
      captureOwnerRef.current = null;
      clearVoiceTimers();
      setVoiceStatus("error");
      setVoiceError(friendlyVoiceError(error));
    }
  };

  const finishVoice = async () => {
    if (captureOwnerRef.current !== "conversation" || captureFinishingRef.current || !recorder.isRecording) return;
    const runId = captureRunIdRef.current;
    captureFinishingRef.current = "conversation";
    clearVoiceTimers();
    const duration = Math.min(60, Math.max(1, Math.round((Date.now() - voiceStartedAt.current) / 1000)));
    const controller = new AbortController();
    voiceController.current?.abort();
    voiceController.current = controller;
    try {
      setVoiceStatus("transcribing");
      const recording = await stopRecorderCapture();
      if (!recording) throw new Error("没有检测到录音，请再试一次。");
      if (captureRunIdRef.current !== runId || controller.signal.aborted) return;
      const transcript = await transcribeRecording(recording, controller.signal);
      if (captureRunIdRef.current !== runId || controller.signal.aborted) return;
      captureOwnerRef.current = null;
      captureFinishingRef.current = null;
      if (doctor.builder?.voice.autoSend === false) { setInput(transcript); setVoiceMode(false); setVoiceStatus("ready"); return; }
      setVoiceStatus("thinking");
      const reply = await send(transcript, true, "", duration);
      if (captureRunIdRef.current !== runId || controller.signal.aborted) return;
      if (!reply) throw new Error("回复暂时没有完成，请点击对话中的“重试”。");
      setVoiceStatus("ready");
    } catch (error) {
      if (captureRunIdRef.current !== runId || controller.signal.aborted) return;
      setVoiceStatus("error");
      setVoiceError(friendlyVoiceError(error));
    } finally {
      if (captureRunIdRef.current === runId) {
        captureFinishingRef.current = null;
        captureOwnerRef.current = null;
      }
      if (voiceController.current === controller) voiceController.current = undefined;
    }
  };
  finishVoiceRef.current = finishVoice;

  const cancelVoice = () => {
    const hasVoiceRequest = Boolean(captureOwnerRef.current || voiceController.current || voiceChatActive.current || requestController.current);
    captureRunIdRef.current += 1;
    captureOwnerRef.current = null;
    captureFinishingRef.current = null;
    clearVoiceTimers();
    voiceController.current?.abort();
    voiceController.current = undefined;
    if (hasVoiceRequest) {
      voiceChatActive.current = false;
      chatRunId.current += 1;
      requestController.current?.abort();
      requestController.current = undefined;
      setBusy(false);
      setStreamingReply("");
    }
    queueRecorderCancel();
    stopPlayback();
    setPlayingMessageId("");
    setVoiceStatus("ready");
    setVoiceError("");
  };

  const stopSpeaking = () => {
    stopPlayback();
    setPlayingMessageId("");
    setVoiceStatus((current) => current === "speaking" ? (requestController.current ? "thinking" : "ready") : current);
  };

  const readMessage = async (message: DoctorChatMessage) => {
    if (playingMessageId === message.id) { stopSpeaking(); return; }
    if (interactionLocked) return;
    setVoiceError("");
    stopPlayback();
    const runId = playbackRunId.current;
    replayText.current = message.text;
    setPlayingMessageId(message.id);
    try {
      await playSpeech(message.text, undefined, false, runId);
      await waitForScheduledSpeech(runId);
    } catch (error) {
      reportPlaybackFailure(error, runId);
    } finally {
      if (playbackRunId.current === runId) {
        setPlayingMessageId("");
        setVoiceStatus("ready");
        setPlaybackStatus((current) => current === "blocked" || current === "error" ? current : "idle");
      }
    }
  };

  const retryPlayback = async () => {
    const text = replayText.current.trim();
    if (!text || voiceCapturing) return;
    // Warm the context directly in this click, before awaiting synthesis.
    void ensureSpeechAudioContext().catch(() => undefined);
    setVoiceError("");
    stopPlayback();
    const runId = playbackRunId.current;
    try {
      await playSpeech(text, undefined, false, runId);
      await waitForScheduledSpeech(runId);
    } catch (error) {
      reportPlaybackFailure(error, runId);
    } finally {
      if (runId === playbackRunId.current) setPlaybackStatus((current) => current === "blocked" || current === "error" ? current : "idle");
    }
  };

  return (
    <div className={`journey-chat ${hasVoiceConversation ? "tang-chat" : ""}`}>
      <header className="journey-inner-header">
        <DoctorPhoto doctor={doctor} className="journey-mini-avatar" />
        <div className="journey-chat-identity"><span>{experience.tagline}</span><h1>{doctor.name}</h1><p><i /> 健康科普智能助手</p></div>
        <div className="journey-chat-tools">
          {hasVoiceConversation && <button className="journey-voice-entry" onClick={() => { setPrivacy((current) => ({ ...current, voicePlayback: !current.voicePlayback })); if (privacy.voicePlayback) stopSpeaking(); else { void ensureSpeechAudioContext().catch(() => undefined); setVoiceError(""); } }} aria-label="语音回复自动播报" aria-pressed={privacy.voicePlayback} title="控制后续回复的自动播报，已有回复可点击喇叭朗读"><SpeakerHighIcon size={16} /> 自动播报{privacy.voicePlayback ? "开" : "关"}</button>}
          <button className="journey-clear-chat" onClick={clearChat} aria-label="清空对话" disabled={messages.length <= 1 && !busy && !voiceCapturing}><TrashIcon size={17} /></button>
        </div>
      </header>
      <div className="journey-safety"><ShieldCheckIcon size={15} weight="duotone" /> 健康科普仅供参考，急症请立即拨打 120</div>
      <div className="journey-messages" ref={messageScroll} tabIndex={0} aria-label="聊天记录"
        onWheel={(event) => { if (event.deltaY) scrollFollow.current.gesture(event.deltaY < 0 ? "up" : "down"); }}
        onTouchStart={(event) => { touchY.current = event.touches[0]?.clientY; }}
        onTouchMove={(event) => {
          const nextY = event.touches[0]?.clientY;
          if (nextY !== undefined && touchY.current !== undefined && nextY !== touchY.current) scrollFollow.current.gesture(nextY > touchY.current ? "up" : "down");
          touchY.current = nextY;
        }}
        onTouchEnd={() => { touchY.current = undefined; }}
        onKeyDown={(event) => {
          if (event.target instanceof Element && event.target.matches("input, textarea, select")) return;
          if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) scrollFollow.current.gesture("up");
          else if (["ArrowDown", "PageDown", "End", " "].includes(event.key)) scrollFollow.current.gesture("down");
        }}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse" && event.target === event.currentTarget && event.clientX >= event.currentTarget.getBoundingClientRect().right - 18) scrollFollow.current.gesture("up");
        }}
        onScroll={(event) => { scrollFollow.current.scrolled(event.currentTarget); }} onClickCapture={(event) => {
        // Expanding a reference or transcript keeps its summary in view.
        if (event.target instanceof Element && event.target.closest("summary")) scrollFollow.current.pause();
      }}>
        <div className="journey-message-list" ref={messageContent}>
        {!doctor.builder && hasVoiceConversation && <TangChatGuidance disabled={interactionLocked} onSend={async (text) => Boolean(await send(text))} />}
        <details className="journey-quick-questions"><summary>推荐问题</summary><div className="journey-suggestions">
          {doctor.quickQuestions.slice(0, 3).map((question) => <button key={question} onClick={() => send(question)} disabled={interactionLocked}>{question}</button>)}
        </div></details>
        {messages.map((message) => (
          <motion.div className={`journey-bubble-row ${message.role} ${message.error ? "is-error" : ""}`} key={message.id} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}>
            {message.role === "assistant" ? <DoctorPhoto doctor={doctor} className="journey-bubble-avatar is-doctor" /> : <span className="journey-bubble-avatar"><UserCircleIcon size={18} /></span>}
            <div className="journey-bubble-content">
              <div className="journey-message-text">{message.role === "user" && message.inputMode === "voice" ? <><span className="tang-voice-message"><WaveSineIcon size={22} /> 语音消息{message.voiceDurationSeconds ? (" · " + message.voiceDurationSeconds + " 秒") : ""}</span><details><summary>查看识别内容</summary>{formatMedicalText(message.text)}</details></> : formatMedicalText(chatMessageBody(message))}</div>
              {message.role === "assistant" && !message.error && <MessageCitations enabled={doctor.citationsEnabled !== false} message={message} showDisclaimer={message.id !== greeting.id} />}
              {message.role === "assistant" && !message.error && message.id !== greeting.id && <AnswerFeedback doctorSlug={doctor.slug} messageId={message.id} answer={message.text} question={messages.slice(0,messages.indexOf(message)).reverse().find(item=>item.role==="user")?.text||""}/> }
              <div className="journey-message-actions">
                {message.role === "assistant" && !message.error && !templatePreview && (!doctor.builder || voiceEnabled(doctor)) && <button onClick={() => void readMessage(message)} aria-label={playingMessageId === message.id ? "停止朗读" : "朗读回复"} disabled={interactionLocked}>{playingMessageId === message.id ? <StopIcon size={14} /> : <SpeakerHighIcon size={14} />}</button>}
                {message.role === "assistant" && !message.error && <button className={favorites.some((item) => item.id === message.id) ? "is-active" : ""} onClick={() => toggleFavorite(message)} aria-label="收藏回复"><BookmarkSimpleIcon size={14} weight={favorites.some((item) => item.id === message.id) ? "fill" : "regular"} /></button>}
                <button onClick={() => copyMessage(message)} aria-label="复制内容"><CopyIcon size={14} />{copiedId === message.id && <span>已复制</span>}</button>
                {message.error && message.retryText && <button className="retry" disabled={interactionLocked} onClick={() => void send(message.retryText, message.inputMode === "voice", message.id)}><ArrowClockwiseIcon size={14} />重试</button>}
              </div>
            </div>
          </motion.div>
        ))}
        {streamingReply && (
          <div className="journey-bubble-row assistant is-streaming" role="status" aria-live="polite" aria-label="正在流式生成回复">
            <DoctorPhoto doctor={doctor} className="journey-bubble-avatar is-doctor" />
            <div className="journey-bubble-content"><div className="journey-message-text">{formatMedicalText(streamingReply)}<span className="journey-streaming-cursor" aria-hidden="true" /></div></div>
          </div>
        )}
        {busy && !streamingReply && <div className="journey-bubble-row assistant" role="status" aria-live="polite" aria-label="正在生成回复"><DoctorPhoto doctor={doctor} className="journey-bubble-avatar is-doctor" /><p className="journey-typing"><i /><i /><i /></p></div>}
        {voiceError && <details id="tang-voice-error-details" className="tang-voice-error-details" ref={voiceErrorDetails} open={voiceErrorExpanded} onToggle={(event) => setVoiceErrorExpanded(event.currentTarget.open)}>
          <summary>语音提示 · 查看完整说明</summary><p>{voiceError}</p>
        </details>}
        <div className="journey-chat-bottom" aria-hidden="true" />
        </div>
      </div>
      {showVoiceStatus && <div className={("tang-voice-status is-" + (voiceError ? "error" : voiceStatus))}>
        <div role={voiceError ? "alert" : "status"} aria-live={voiceStatus === "recording" ? "off" : "polite"}>
          <WaveSineIcon size={16} />
          {voiceError ? <button className="tang-voice-error-toggle" onClick={showVoiceErrorDetails} aria-expanded={voiceErrorExpanded} aria-controls="tang-voice-error-details">{playbackStatus === "blocked" ? "声音已暂停" : playbackStatus === "error" ? "播报失败" : "语音暂不可用"}<small>详情</small></button> : <span>{voiceStatus === "recording" ? ("录音 " + voiceElapsedLabel + " / 01:00") : voiceCapturing ? voiceStatusText[voiceStatus] : playbackStatus === "preparing" ? "正在准备播报" : playbackStatus === "playing" ? "正在播报，可继续打字" : voiceStatus === "ready" ? (voiceMode ? "点击说话，说完点发送" : "可打字，或点话筒录音") : voiceStatusText[voiceStatus]}</span>}
        </div>
        {(playbackStatus === "blocked" || playbackStatus === "error") && <button onClick={() => void retryPlayback()} aria-label={playbackStatus === "blocked" ? "恢复播报" : "重试播报"} disabled={voiceCapturing || !replayText.current.trim()}>{playbackStatus === "blocked" ? "恢复" : "重试"}</button>}
        {playbackStatus === "preparing" || playbackStatus === "playing" ? <button onClick={stopSpeaking}>停止播报</button> : (voiceCapturing || busy) ? <button onClick={cancelVoice}>取消</button> : voiceError ? <button className="tang-voice-hint-close" aria-label="关闭语音提示" onClick={() => { setVoiceError(""); setVoiceStatus("ready"); setPlaybackStatus("idle"); setVoiceHintDismissed(true); }}><XIcon size={16} aria-hidden="true" /></button> : voiceStatus === "ready" ? <button className="tang-voice-hint-close" type="button" aria-label="关闭输入提示" title="关闭输入提示" onClick={() => setVoiceHintDismissed(true)}><XIcon size={15} aria-hidden="true" /></button> : null}
      </div>}
      {templatePreview && <p className="journey-preview-note">模板仅供界面预览，创建草稿后可实际问答。</p>}<div className="journey-chat-input" aria-busy={interactionLocked}>
        {healthContextNotice && <div className="journey-context-notice" role="status">{healthContextNotice}</div>}
        {hasVoiceConversation ? <button className="voice" type="button" onClick={() => { if (voiceMode) { if (voiceCapturing) cancelVoice(); setVoiceMode(false); } else { setVoiceMode(true); void startVoice(); } }} aria-label={voiceMode ? "切换键盘输入" : "开始语音对话"} title={voiceMode ? "切换键盘，可边听边写" : "点击开始录音，说完点发送"} disabled={busy && !voiceMode}>
          {voiceMode ? <KeyboardIcon size={23} /> : <MicrophoneIcon size={23} weight="fill" />}
        </button> : <button type="button" aria-label="暂不支持报告上传，请使用文字描述" disabled><ImageSquareIcon size={21} /></button>}
        {healthContextEnabled(doctor) && !voiceMode && <button className={("context " + (shareHealthRecords ? "is-active " : "") + (!canShareHealthRecords ? "is-unavailable" : ""))} type="button" aria-label={shareHealthRecords ? "本次已参考健康记录" : "本次参考健康记录"} aria-pressed={shareHealthRecords} aria-disabled={!canShareHealthRecords} disabled={interactionLocked} onClick={toggleHealthContext}><ChartLineUpIcon size={20} />{canShareHealthRecords && <span aria-hidden="true">{healthContext.records.length}</span>}</button>}
        {hasVoiceConversation && voiceMode ? <button className={("tang-speak-button is-" + voiceStatus)} type="button" onClick={() => voiceStatus === "recording" ? void finishVoice() : void startVoice()} disabled={busy || voiceStatus === "starting" || voiceStatus === "transcribing"}>
          {voiceStatus === "recording" ? <PaperPlaneTiltIcon size={20} weight="fill" /> : <MicrophoneIcon size={20} />}
          {voiceStatus === "recording" ? "说完了，发送" : voiceStatus === "starting" ? "正在开启麦克风…" : voiceStatus === "transcribing" || busy ? "请稍候…" : "点击说话"}
        </button> : <>
          <input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => event.key === "Enter" && !event.nativeEvent.isComposing && void send()} placeholder={hasVoiceConversation ? "聊聊最近的睡眠、情绪或困扰…" : "描述你的健康问题…"} aria-label="对话内容" maxLength={2000} disabled={hasVoiceConversation ? voiceCapturing : interactionLocked} />
          <button className="send" onClick={() => void send()} aria-label="发送" disabled={templatePreview || interactionLocked || !input.trim()}><PaperPlaneTiltIcon size={18} weight="fill" /></button>
        </>}
      </div>
    </div>
  );
}

type TangTrendMetric = "sleepDurationMinutes" | "moodScore" | "anxietyScore" | "energyScore";

const trendMetricOptions: { key: TangTrendMetric; label: string; max: number; format: (value: number) => string }[] = [
  { key: "sleepDurationMinutes", label: "睡眠", max: 720, format: (value) => `${(value / 60).toFixed(1)}小时` },
  { key: "moodScore", label: "情绪", max: 10, format: (value) => `${value}/10` },
  { key: "anxietyScore", label: "焦虑", max: 10, format: (value) => `${value}/10` },
  { key: "energyScore", label: "精力", max: 10, format: (value) => `${value}/10` },
];

function TangScoreGuide({ metric }: { metric: keyof typeof tangScoreAnchors }) {
  return <small className="journey-score-guide">{tangScoreAnchors[metric].map((anchor) => <span key={anchor}>{anchor}</span>)}</small>;
}

function TangHomeRecordSheet({
  doctor,
  initialRecord,
  initialSection,
  onClose,
  onAsk,
  onSave,
}: {
  doctor: DoctorProfile;
  initialRecord?: DoctorHealthRecord;
  initialSection: TangRecordSection;
  onClose: () => void;
  onAsk: AskNavigator;
  onSave: (metrics: DoctorHealthMetrics, note: string) => void;
}) {
  const sheetRef = useRef<HTMLElement>(null);
  const sectionRefs = useRef<Partial<Record<TangRecordSection, HTMLDivElement | null>>>({});
  useDialogFocusTrap(sheetRef, onClose);
  const [draft, setDraft] = useState<TangRecordDraft>(() => createTangRecordDraft(initialRecord));
  const [formError, setFormError] = useState("");
  const [saved, setSaved] = useState(false);
  const [savedMetricCount, setSavedMetricCount] = useState(0);

  useEffect(() => {
    if (initialSection === "all") return;
    const timer = window.setTimeout(() => {
      const section = sectionRefs.current[initialSection];
      const sheet = sheetRef.current;
      if (!section || !sheet) return;
      sheet.scrollTo({ top: section.offsetTop - 24, behavior: "auto" });
      section.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [initialSection]);

  const updateDraft = <K extends keyof TangRecordDraft>(key: K, value: TangRecordDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setFormError("");
  };

  const save = () => {
    const validated = validateTangRecordDraft({ ...draft, dateKey: localDateKey() });
    if (validated.error || !validated.metrics) {
      setFormError(validated.error || "记录内容无效，请检查后重试。");
      return;
    }
    const metrics = Object.fromEntries(Object.entries(validated.metrics).filter(([, value]) => value !== undefined)) as DoctorHealthMetrics;
    onSave(metrics, draft.note.trim());
    setSavedMetricCount(Object.keys(metrics).length);
    setSaved(true);
  };

  return (
    <motion.div className="journey-sheet-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.section
        ref={sheetRef}
        className="journey-sheet journey-tang-home-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="今日睡眠与状态记录"
        tabIndex={-1}
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 60, opacity: 0 }}
        transition={{ type: "spring", damping: 28, stiffness: 320 }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="journey-sheet-handle" />
        <button className="journey-sheet-close" onClick={onClose} aria-label="关闭睡眠与状态记录"><XIcon size={18} /></button>
        {!saved ? (
          <>
            <span className="journey-eyebrow">DAILY HEALTH CHECK-IN</span>
            <h2>今日睡眠与状态记录</h2>
            <p>按实际情况填写，不清楚的项目可以留空。同一天的睡眠、情绪和日常功能保存在一份记录中，可随时补充。</p>

            <div className="journey-record-section" ref={(node) => { sectionRefs.current.sleep = node; }}>
            <div className="journey-record-section-title"><MoonStarsIcon size={20} weight="duotone" /><div><b>睡眠变化</b><small>记录昨晚实际睡眠情况</small></div></div>
            <div className="journey-record-grid">
              <label className="journey-record-field"><span>睡眠时长</span><div><input type="number" inputMode="decimal" min="0" max="24" step="0.5" value={draft.sleepDurationHours} onChange={(event) => updateDraft("sleepDurationHours", event.target.value)} placeholder="例如 6.5" /><em>小时</em></div></label>
              <label className="journey-record-field"><span>入睡耗时</span><div><input type="number" inputMode="numeric" min="0" max="720" step="1" value={draft.sleepLatencyMinutes} onChange={(event) => updateDraft("sleepLatencyMinutes", event.target.value)} placeholder="例如 40" /><em>分钟</em></div></label>
              <label className="journey-record-field"><span>夜醒次数</span><div><input type="number" inputMode="numeric" min="0" max="20" step="1" value={draft.nightAwakenings} onChange={(event) => updateDraft("nightAwakenings", event.target.value)} placeholder="例如 2" /><em>次</em></div></label>
            </div>
            </div>

            <div className="journey-record-section" ref={(node) => { sectionRefs.current.emotion = node; }}>
            <div className="journey-record-section-title"><HeartIcon size={20} weight="duotone" /><div><b>情绪感受</b><small>按今天的感受选择 0–10 分；未填保持空白</small></div></div>
            <div className="journey-record-grid is-scores">
              <label className="journey-record-field"><span>情绪稳定度</span><div><input type="number" inputMode="numeric" min="0" max="10" step="1" value={draft.moodScore} onChange={(event) => updateDraft("moodScore", event.target.value)} placeholder="0–10" /><em>分</em></div><TangScoreGuide metric="moodScore" /></label>
              <label className="journey-record-field"><span>焦虑程度</span><div><input type="number" inputMode="numeric" min="0" max="10" step="1" value={draft.anxietyScore} onChange={(event) => updateDraft("anxietyScore", event.target.value)} placeholder="0–10" /><em>分</em></div><TangScoreGuide metric="anxietyScore" /></label>
            </div>
            </div>
            <div className="journey-record-section" ref={(node) => { sectionRefs.current.function = node; }}>
            <div className="journey-record-section-title"><BrainIcon size={20} weight="duotone" /><div><b>日常功能</b><small>按今天的精力和生活影响选择 0–10 分</small></div></div>
            <div className="journey-record-grid is-scores">
              <label className="journey-record-field"><span>白天精力</span><div><input type="number" inputMode="numeric" min="0" max="10" step="1" value={draft.energyScore} onChange={(event) => updateDraft("energyScore", event.target.value)} placeholder="0–10" /><em>分</em></div><TangScoreGuide metric="energyScore" /></label>
              <label className="journey-record-field"><span>日常受影响</span><div><input type="number" inputMode="numeric" min="0" max="10" step="1" value={draft.daytimeImpactScore} onChange={(event) => updateDraft("daytimeImpactScore", event.target.value)} placeholder="0–10" /><em>分</em></div><TangScoreGuide metric="daytimeImpactScore" /></label>
            </div>
            </div>

            <label className="journey-record-note journey-tang-home-note"><span>补充备注（可选）</span><textarea value={draft.note} maxLength={300} onChange={(event) => updateDraft("note", event.target.value)} placeholder="例如：昨晚加班后入睡较慢，今天下午精力较差" /><small>{draft.note.length} / 300</small></label>
            {formError && <p className="journey-form-error" role="alert">{formError}</p>}
            <div className="journey-tang-home-actions">
              <button className="journey-primary-button" onClick={save}><FloppyDiskIcon size={18} /> 保存今日记录</button>
              <div className="journey-privacy"><LockKeyIcon size={14} /> 游客记录保存在本机，微信登录后保存到账户；仅在你主动选择时提供给{doctor.name}智能体</div>
            </div>
          </>
        ) : (
          <div className="journey-sheet-success">
            <span><CheckCircleIcon size={42} weight="duotone" /></span>
            <h2>今日记录已保存</h2>
            <p>{savedMetricCount ? `已记录 ${savedMetricCount} 项实际数据，并同步到管理页统计。` : "备注已保存，并同步到管理页历史记录。"}</p>
            <button className="journey-primary-button" onClick={() => { onClose(); onAsk("请结合我今天记录的睡眠和状态，告诉我最值得先调整的一点。", true); }}><ChatCircleDotsIcon size={18} weight="fill" /> 带着记录去问智能体</button>
            <button className="journey-secondary-button" onClick={onClose}>返回首页</button>
          </div>
        )}
      </motion.section>
    </motion.div>
  );
}

function TangManagePanel({ doctor, onAsk }: { doctor: DoctorProfile; onAsk: AskNavigator }) {
  const [records, setRecords, persistence] = useDoctorLocalState<DoctorHealthRecord[]>(doctor.slug, "health-records", []);
  const initialTodayRecord = mergeTangDailyRecords(records, localDateKey());
  const [draft, setDraft] = useState<TangRecordDraft>(() => createTangRecordDraft(initialTodayRecord));
  const [editingId, setEditingId] = useState(() => initialTodayRecord?.id ?? "");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [formError, setFormError] = useState("");
  const [savedAt, setSavedAt] = useState("");
  const [recordEditorVisible, setRecordEditorVisible] = useState(false);
  const [trendDays, setTrendDays] = useState<7 | 30>(7);
  const [trendMetric, setTrendMetric] = useState<TangTrendMetric>("sleepDurationMinutes");
  const recordEditorRef = useRef<HTMLElement>(null);
  const trend = useMemo(() => buildHealthTrend(records, trendDays), [records, trendDays]);
  const stats = useMemo(() => calculateHealthStats(records, trendDays), [records, trendDays]);
  const recordedDays = useMemo(() => recentRecordDayCount(records, trendDays), [records, trendDays]);
  const sortedRecords = useMemo(() => sortHealthRecords(records, new Date(), 370, doctor.builder ? configuredRecordConfig(doctor, getSpecialtyRecordConfig(doctor.slug)) : undefined), [records, doctor]);
  const recentHealthContext = useMemo(() => buildHealthContextPayload(sortedRecords), [sortedRecords]);
  const selectedTrend = trendMetricOptions.find((item) => item.key === trendMetric) ?? trendMetricOptions[0];
  const structuredRecords = sortedRecords.filter((record) => record.metrics && Object.values(record.metrics).some((value) => value !== undefined));
  const selectedTrendHasData = trend.some((point) => typeof point.metrics?.[trendMetric] === "number");
  const minDate = useMemo(() => {
    const date = new Date();
    date.setFullYear(date.getFullYear() - 1);
    return localDateKey(date);
  }, []);

  useEffect(() => {
    const editor = recordEditorRef.current;
    if (!editor || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => setRecordEditorVisible(entry.isIntersecting),
      { root: editor.closest(".journey-content"), threshold: 0.02 },
    );
    observer.observe(editor);
    return () => observer.disconnect();
  }, []);

  const updateDraft = <K extends keyof TangRecordDraft>(key: K, value: TangRecordDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setFormError("");
    setSavedAt("");
  };

  const saveRecord = () => {
    const validated = validateTangRecordDraft(draft);
    if (validated.error || !validated.metrics) {
      setFormError(validated.error || "记录内容无效，请检查后重试。");
      return;
    }
    const now = new Date().toISOString();
    const existing = editingId ? records.find((record) => record.id === editingId) : undefined;
    const sameDayRecords = sortedRecords.filter((record) => healthRecordDateKey(record) === draft.dateKey);
    const isMovingToDifferentDate = Boolean(existing && healthRecordDateKey(existing) !== draft.dateKey);
    const conflictingRecord = isMovingToDifferentDate ? sameDayRecords.find((record) => record.id !== existing?.id) : undefined;
    if (conflictingRecord) {
      setFormError(`${draft.dateKey} 已有一条记录，请从历史记录中编辑该记录，或改选其他日期。`);
      return;
    }
    const effectiveExisting = existing ?? sameDayRecords[0];
    const record: DoctorHealthRecord = {
      schemaVersion: 2,
      id: effectiveExisting?.id ?? createLocalId("record"),
      createdAt: effectiveExisting?.createdAt ?? now,
      updatedAt: now,
      dateKey: draft.dateKey,
      completedTitles: [],
      note: draft.note.trim(),
      source: "manage",
      metrics: validated.metrics,
    };
    const nextRecords = upsertTangDailyRecord(records, record);
    const savedRecord = nextRecords.find((item) => item.source === "manage" && healthRecordDateKey(item) === draft.dateKey);
    setRecords(nextRecords);
    setEditingId(savedRecord?.id ?? record.id);
    setSavedAt(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
    setFormError("");
  };

  const startNewRecord = () => {
    const recordedDateKeys = new Set(sortedRecords.map(healthRecordDateKey));
    let availableDateKey = localDateKey();
    for (let offset = 0; offset < 370; offset += 1) {
      const candidate = new Date();
      candidate.setHours(12, 0, 0, 0);
      candidate.setDate(candidate.getDate() - offset);
      const candidateKey = localDateKey(candidate);
      if (!recordedDateKeys.has(candidateKey)) {
        availableDateKey = candidateKey;
        break;
      }
    }
    setDraft({ ...createTangRecordDraft(), dateKey: availableDateKey });
    setEditingId("");
    setFormError("");
    setSavedAt("");
  };

  const addNewRecord = () => {
    setHistoryOpen(false);
    startNewRecord();
    window.setTimeout(() => recordEditorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  };

  const editRecord = (record: DoctorHealthRecord) => {
    const mergedRecord = mergeTangDailyRecords(records, healthRecordDateKey(record)) ?? record;
    setDraft(createTangRecordDraft(mergedRecord));
    setEditingId(mergedRecord.id);
    setHistoryOpen(false);
    setFormError("");
    setSavedAt("");
    window.setTimeout(() => recordEditorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  };

  const changeRecordDate = (dateKey: string) => {
    const existingRecord = mergeTangDailyRecords(records, dateKey);
    setDraft(existingRecord ? createTangRecordDraft(existingRecord) : { ...createTangRecordDraft(), dateKey });
    setEditingId(existingRecord?.id ?? "");
    setFormError("");
    setSavedAt("");
  };

  const deleteRecord = (recordId: string) => {
    const record = records.find((item) => item.id === recordId);
    const label = record ? healthRecordDateKey(record) : "这一天";
    if (!window.confirm(`确定删除 ${label} 的健康记录吗？`)) return;
    const nextRecords = records.filter((item) => item.id !== recordId);
    setRecords(nextRecords);
    if (editingId === recordId) startNewRecord();
  };

  const clearRecords = () => {
    if (!window.confirm("确定清空全部健康记录吗？此操作无法恢复。")) return;
    setRecords([]);
    startNewRecord();
  };

  const askWithRecords = () => {
    setHistoryOpen(false);
    onAsk("请结合我最近记录的睡眠、情绪、焦虑和白天状态，帮我看看最值得先调整的一点。", true);
  };

  const summaryItems = [
    { label: `${trendDays}日记录`, value: `${recordedDays}天`, note: recordedDays >= 3 ? "含首页状态记录，可观察变化" : "首页与管理页记录会同步计入" },
    { label: "平均睡眠", value: stats.averageSleepDurationMinutes === undefined ? "暂无" : `${(stats.averageSleepDurationMinutes / 60).toFixed(1)}h`, note: "仅统计已填写日期" },
    { label: "平均焦虑", value: stats.averageAnxietyScore === undefined ? "暂无" : `${stats.averageAnxietyScore.toFixed(1)}/10`, note: "分数越高表示越明显" },
    { label: "平均精力", value: stats.averageEnergyScore === undefined ? "暂无" : `${stats.averageEnergyScore.toFixed(1)}/10`, note: "分数越高表示越充足" },
  ];

  return (
    <div className="journey-simple-panel journey-tang-manage">
      <header><span className="journey-eyebrow">PERSONAL HEALTH LOG</span><h1>睡眠与情绪管理</h1><p>按天记录睡眠、情绪和日常状态；登录微信后可跨设备查看，并可选择让智能体参考摘要。</p></header>

      {persistence.status !== "ready" && (
        <section className={`journey-storage-status is-${persistence.status}`} role="alert">
          <ShieldCheckIcon size={22} weight="duotone" />
          <div><b>{persistence.storage === "cloud" ? "云端记录尚未同步完成" : persistence.status === "memory-only" ? "当前记录仅临时保存" : "本机记录读取异常"}</b><p>{persistence.storage === "cloud" ? "请检查网络后重试；记录冲突可在“我的”中处理。" : "请检查微信存储权限或设备空间，重新打开页面前不要清理当前会话。"}</p></div>
          <button onClick={persistence.retry}>重试保存</button>
        </section>
      )}

      <div className="journey-range-switch" aria-label="统计时间范围">
        <button className={trendDays === 7 ? "is-active" : ""} onClick={() => setTrendDays(7)}>近7日</button>
        <button className={trendDays === 30 ? "is-active" : ""} onClick={() => setTrendDays(30)}>近30日</button>
      </div>

      <section className="journey-health-overview" aria-label={`${trendDays}日健康记录统计`}>
        {summaryItems.map((item) => <article key={item.label}><span>{item.label}</span><strong>{item.value}</strong><small>{item.note}</small></article>)}
      </section>

      <section className="journey-trend-card">
        <header><div><span className="journey-eyebrow">TREND</span><h2>自填趋势</h2></div><small>{structuredRecords.length ? `已有 ${structuredRecords.length} 条结构化记录` : "暂无可统计记录"}</small></header>
        <div className="journey-trend-selector" aria-label="选择趋势指标">
          {trendMetricOptions.map((item) => <button key={item.key} className={trendMetric === item.key ? "is-active" : ""} onClick={() => setTrendMetric(item.key)}>{item.label}</button>)}
        </div>
        {selectedTrendHasData ? (
          <div className={`journey-trend-scroll ${trendDays === 30 ? "is-long" : ""}`}>
            <div className="journey-trend-bars" role="img" aria-label={`${selectedTrend.label}${trendDays}日趋势图`}>
              {trend.map((point, index) => {
                const rawValue = point.metrics?.[trendMetric];
                const value = typeof rawValue === "number" ? rawValue : undefined;
                const height = value === undefined ? 0 : Math.max(8, Math.min(100, (value / selectedTrend.max) * 100));
                return <div className={`journey-trend-bar ${value === undefined ? "is-empty" : ""}`} key={point.dateKey} aria-label={`${point.label} ${value === undefined ? "未记录" : selectedTrend.format(value)}`}><span>{value === undefined ? "—" : selectedTrend.format(value)}</span><i><b style={{ height: `${height}%` }} /></i><small>{trendDays === 7 || index % 5 === 0 || index === trend.length - 1 ? point.label : ""}</small></div>;
              })}
            </div>
          </div>
        ) : <div className="journey-inline-empty"><ChartLineUpIcon size={30} weight="duotone" /><b>暂无{selectedTrend.label}记录</b><p>填写该项后会生成趋势；缺失日期不会按 0 计算。</p></div>}
        <p className="journey-stat-note">记录天数包含首页状态记录；均值和趋势仅统计量化自填数据，不代表诊断或疗效判断。</p>
      </section>

      <section className="journey-record-editor" id="tang-record-editor" ref={recordEditorRef}>
        <header className="journey-editor-heading"><div><span className="journey-eyebrow">DAILY CHECK-IN</span><h2>{editingId ? "编辑健康记录" : "新增健康记录"}</h2></div>{editingId && <button onClick={addNewRecord}><NotePencilIcon size={16} /> 新增/补录</button>}</header>
        <label className="journey-record-field is-date"><span>记录日期</span><input type="date" value={draft.dateKey} min={minDate} max={localDateKey()} onChange={(event) => changeRecordDate(event.target.value)} /></label>

        <div className="journey-record-section-title"><MoonStarsIcon size={20} weight="duotone" /><div><b>睡眠情况</b><small>不知道的项目可以留空</small></div></div>
        <div className="journey-record-grid">
          <label className="journey-record-field"><span>睡眠时长</span><div><input type="number" inputMode="decimal" min="0" max="24" step="0.5" value={draft.sleepDurationHours} onChange={(event) => updateDraft("sleepDurationHours", event.target.value)} placeholder="例如 6.5" /><em>小时</em></div></label>
          <label className="journey-record-field"><span>入睡耗时</span><div><input type="number" inputMode="numeric" min="0" max="720" step="1" value={draft.sleepLatencyMinutes} onChange={(event) => updateDraft("sleepLatencyMinutes", event.target.value)} placeholder="例如 40" /><em>分钟</em></div></label>
          <label className="journey-record-field"><span>夜醒次数</span><div><input type="number" inputMode="numeric" min="0" max="20" step="1" value={draft.nightAwakenings} onChange={(event) => updateDraft("nightAwakenings", event.target.value)} placeholder="例如 2" /><em>次</em></div></label>
        </div>

        <div className="journey-record-section-title"><BrainIcon size={20} weight="duotone" /><div><b>白天状态</b><small>均为 0–10 分的自我感受</small></div></div>
        <div className="journey-record-grid is-scores">
          <label className="journey-record-field"><span>情绪稳定度</span><div><input type="number" inputMode="decimal" min="0" max="10" step="1" value={draft.moodScore} onChange={(event) => updateDraft("moodScore", event.target.value)} placeholder="0–10" /><em>分</em></div><TangScoreGuide metric="moodScore" /></label>
          <label className="journey-record-field"><span>焦虑程度</span><div><input type="number" inputMode="decimal" min="0" max="10" step="1" value={draft.anxietyScore} onChange={(event) => updateDraft("anxietyScore", event.target.value)} placeholder="0–10" /><em>分</em></div><TangScoreGuide metric="anxietyScore" /></label>
          <label className="journey-record-field"><span>白天精力</span><div><input type="number" inputMode="decimal" min="0" max="10" step="1" value={draft.energyScore} onChange={(event) => updateDraft("energyScore", event.target.value)} placeholder="0–10" /><em>分</em></div><TangScoreGuide metric="energyScore" /></label>
          <label className="journey-record-field"><span>日常受影响</span><div><input type="number" inputMode="decimal" min="0" max="10" step="1" value={draft.daytimeImpactScore} onChange={(event) => updateDraft("daytimeImpactScore", event.target.value)} placeholder="0–10" /><em>分</em></div><TangScoreGuide metric="daytimeImpactScore" /></label>
        </div>

        <label className="journey-record-note"><span>补充备注（可选）</span><textarea value={draft.note} maxLength={300} onChange={(event) => updateDraft("note", event.target.value)} placeholder="例如：昨晚加班后入睡困难，今天下午精力较差" /><small>{draft.note.length} / 300</small></label>
        {formError && <p className="journey-form-error" role="alert">{formError}</p>}
        {savedAt && <p className="journey-save-success" role="status" aria-live="polite"><CheckCircleIcon size={17} weight="fill" /> {persistence.status === "ready" ? `已于 ${savedAt} 保存到${persistence.storage === "cloud" ? "账户" : "本机"}` : `已于 ${savedAt} 更新，等待保存完成`}</p>}
        <div className="journey-manage-actions">
          <button className="journey-primary-button" onClick={saveRecord}><FloppyDiskIcon size={18} /> {editingId ? "更新这条记录" : "保存健康记录"}</button>
          <button className="journey-secondary-button" onClick={() => setHistoryOpen(true)}><ClockCounterClockwiseIcon size={17} /> 查看历史记录（{records.length}）</button>
        </div>
      </section>

      <section className="journey-ai-record-card">
        <SparkleIcon size={25} weight="duotone" />
        <div><b>让智能体参考近期记录</b><p>点击后会进入问答页；发送前仍可关闭。只提交最近记录的结构化摘要，不包含游客编号和记录 ID。</p></div>
        <button disabled={!recentHealthContext.records.length} onClick={askWithRecords}>带记录提问 <CaretRightIcon size={16} /></button>
      </section>

      <AnimatePresence>
        {historyOpen && <FeatureSheet title="健康记录" eyebrow="PRIVATE HEALTH LOG" onClose={() => setHistoryOpen(false)}>
          {sortedRecords.length ? <><div className="journey-record-list journey-structured-records">{sortedRecords.map((record) => <article key={record.id}><span>{healthRecordDateKey(record)} · {new Date(record.updatedAt || record.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} · {record.source === "home" ? "首页状态记录" : "管理记录"}</span><b>{formatHealthMetricsSummary(record, doctor.builder ? configuredRecordConfig(doctor, getSpecialtyRecordConfig(doctor.slug)) : undefined) || record.completedTitles.join("、") || "自我记录"}</b>{record.note && <p>{record.note}</p>}{record.completedTitles.length > 0 && <small>已记录：{record.completedTitles.join("、")}</small>}<div className="journey-list-actions"><button onClick={() => editRecord(record)}><NotePencilIcon size={15} />编辑</button><button onClick={askWithRecords}><ChatCircleDotsIcon size={15} />带近期记录咨询</button><button className="danger" onClick={() => deleteRecord(record.id)} aria-label={`删除 ${healthRecordDateKey(record)} 的健康记录`}><TrashIcon size={15} />删除</button></div></article>)}</div><button className="journey-danger-button" onClick={clearRecords}><TrashIcon size={16} /> 清空全部健康记录</button></> : <div className="journey-empty-state"><ClipboardTextIcon size={34} weight="duotone" /><b>暂无健康记录</b><p>关闭本页后填写第一条睡眠或情绪记录。</p></div>}
          <p className="journey-sheet-disclaimer"><ShieldCheckIcon size={14} /> 游客记录保存在本机，微信登录后保存到账户；仅在你主动选择时向智能体发送摘要。</p>
        </FeatureSheet>}
      </AnimatePresence>
      {!recordEditorVisible && typeof document !== "undefined" && createPortal(
        <motion.button
          className="journey-add-record-fab"
          type="button"
          aria-label="添加健康记录"
          title="添加健康记录"
          onClick={addNewRecord}
          initial={{ opacity: 0, scale: 0.82 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.82 }}
          whileTap={{ scale: 0.92 }}
        >
          <PlusIcon size={25} weight="bold" />
        </motion.button>,
        document.querySelector(".journey-phone") ?? document.body,
      )}
    </div>
  );
}

function ManagePanel({ doctor, experience, onAsk, wellnessView = null, onWellnessView = () => undefined }: { doctor: DoctorProfile; experience: DoctorExperience; onAsk: AskNavigator; wellnessView?: WellnessView | null; onWellnessView?: (view: WellnessView | null) => void }) {
  if (doctor.builder) return <>{getBuilderComponents(doctor.builder).map(component => component.id === 'records' ? <SpecialtyManagePanel key={component.id} doctor={doctor} experience={experience} onAsk={onAsk} /> : component.id === 'assessments' ? <BuilderAssessments key={component.id} doctor={doctor} onAsk={onAsk} /> : component.id === 'wellness' ? <WellnessWorkspace key={component.id} section="manage" view={wellnessView} onView={onWellnessView} onAsk={onAsk} /> : null)}</>;
  if (usesTangRecords(doctor)) return <TangManagePanel doctor={doctor} onAsk={onAsk} />;
  return <SpecialtyManagePanel key={doctor.slug} doctor={doctor} experience={experience} onAsk={onAsk} />;
}

function ServicesPanel({ doctor, experience, onAsk, onManage, compact = false }: { doctor: PublicDoctorDetail; experience: DoctorExperience; onAsk: AskNavigator; onManage: () => void; compact?: boolean }) {
  const preview = useDoctorPreview();
  const serviceIcons: Icon[] = [StethoscopeIcon, FileTextIcon, HeartIcon, CalendarCheckIcon];
  const [selected, setSelected] = useState<{ id: string; service: string } | null>(null);
  const [selectedDirty, setSelectedDirty] = useState(false);
  const [stored, setStored, servicePersistence] = useDoctorLocalState(doctor.slug, "service-plans-v1", emptyServicePlans());
  const plans = normalizeServicePlans(stored).plans;
  const canLeave = () => !selectedDirty || window.confirm("当前计划尚未保存，离开后未保存的修改会丢失。确定继续吗？");
  const closeService = () => { if (canLeave()) { setSelected(null); setSelectedDirty(false); } };
  return (
    <div className={compact ? "journey-services-panel service-plans-compact" : "journey-simple-panel journey-services-panel"}>
      <header><span className="journey-eyebrow">PROFESSIONAL SERVICES</span>{compact ? <h2>服务资料与计划</h2> : <h1>专业健康服务</h1>}<p>整理专科资料与问题，保存准备进度，再带摘要进入咨询。</p></header>
      {!compact && <button className="journey-primary-button" onClick={onManage}><ClipboardTextIcon size={18} /> 填写记录与查看统计</button>}
      <ConsumerServicesPanel doctorSlug={doctor.slug} preview={preview} />
      <ConsumerReportsPanel doctorSlug={doctor.slug} preview={preview} onUseText={text => onAsk(text)} />
      <div className="journey-service-grid">
        {(doctor.builder ? doctor.builder.servicePlans.map(item => item.title) : doctor.services).map((service, index) => {
          const ServiceIcon = serviceIcons[index % serviceIcons.length];
          const plan = plans.find(item => item.service === service);
          return <button key={service} onClick={() => setSelected({ id: plan?.id || doctor.builder?.servicePlans.find(item => item.title === service)?.id || service, service })}><span><ServiceIcon size={25} weight="duotone" /></span><b>{service}</b><small>{plan ? `已保存 · 已整理${plan.completed.length}项` : "打开清单与记录"}</small><CaretRightIcon size={17} /></button>;
        })}
      </div>
      {plans.filter(plan => !(doctor.builder ? doctor.builder.servicePlans.map(item => item.title) : doctor.services).includes(plan.service) || plans.find(item => item.service === plan.service)?.id !== plan.id).map(plan => <button className="journey-secondary-button" key={plan.id} onClick={() => setSelected({ id: plan.id, service: plan.service })}>查看已保存计划：{plan.service}</button>)}
      {!compact && componentEnabled(doctor, "content") && <PublishedContentSection content={doctor.content.filter((item) => item.type === "service")} title="已发布服务" onAsk={onAsk} />}
      {!compact && <section className="journey-boundary"><ShieldCheckIcon size={23} weight="duotone" /><div><b>{experience.tagline}</b><p>线上内容用于健康教育和就医准备，不提供诊断、处方或急救服务。</p></div></section>}
      <AnimatePresence>
        {selected && <FeatureSheet title={selected.service} eyebrow="PROFESSIONAL SERVICE" onClose={closeService}>
          <ServicePlanWorksheet key={selected.id} doctor={doctor} service={selected.service} planId={selected.id} stored={stored} setStored={setStored} persistence={servicePersistence} onDirtyChange={setSelectedDirty} onManage={() => { if (canLeave()) { setSelected(null); onManage(); } }} onAsk={question => { if (canLeave()) { setSelected(null); onAsk(question); } }} />
        </FeatureSheet>}
      </AnimatePresence>
    </div>
  );
}

function MePanel({ doctor, experience, onAsk, onWellnessOpen, onManage }: { doctor: DoctorProfile; experience: DoctorExperience; onAsk: AskNavigator; onWellnessOpen?: (view: WellnessView) => void; onManage: () => void }) {
  const preview = useDoctorPreview();
  const templatePreview = useDoctorTemplatePreview();
  const consumerAccount = useConsumerSession();
  const account = preview ? { ...consumerAccount, user: null } : consumerAccount;
  const [profileName, setProfileName] = useDoctorLocalState(doctor.slug, "profile-name", "游客账户");
  const [draftName, setDraftName] = useState(profileName);
  const [privacy, setPrivacy] = useDoctorLocalState<DoctorPrivacySettings>(doctor.slug, "privacy", { saveChat: true, voicePlayback: true, reminders: true });
  const [favorites, setFavorites] = useDoctorLocalState<DoctorFavorite[]>(doctor.slug, "favorites", []);
  const [messages, setMessages] = useDoctorLocalState<DoctorChatMessage[]>(doctor.slug, "chat-messages", [], privacy.saveChat);
  const [records, setRecords] = useDoctorLocalState<DoctorHealthRecord[]>(doctor.slug, "health-records", []);
  const [, setDailyTasks] = useDoctorLocalState<DoctorDailyTasks>(doctor.slug, "health-daily-tasks", createDailyTasks(experience.steps.length));
  const [activePanel, setActivePanel] = useState<"profile" | "favorites" | "history" | "records" | "privacy" | "about" | null>(null);
  const [copiedFavoriteId, setCopiedFavoriteId] = useState("");
  const userQuestions = messages.filter((message) => message.role === "user").reverse();
  const sortedHealthRecords = useMemo(() => normalizeHealthRecords(records, doctor.builder ? configuredRecordConfig(doctor, getSpecialtyRecordConfig(doctor.slug)) : undefined).sort((left, right) =>
    healthRecordDateKey(right).localeCompare(healthRecordDateKey(left))
    || Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt)), [records, doctor]);
  const canShareRecentHealthRecords = healthContextEnabled(doctor) && buildHealthContextPayload(sortedHealthRecords, new Date(), doctor.builder ? configuredRecordConfig(doctor, getSpecialtyRecordConfig(doctor.slug)) : undefined).records.length > 0;

  useEffect(() => setMessages(stripStoredCitationDetails), [setMessages]);

  useEffect(() => {
    if (profileName === "微信用户") setProfileName("游客账户");
  }, [profileName, setProfileName]);

  const openProfile = () => {
    setDraftName(profileName);
    setActivePanel("profile");
  };

  const closePanel = () => setActivePanel(null);

  const continueQuestion = (question: string) => {
    closePanel();
    onAsk(question);
  };

  const copyFavorite = async (favorite: DoctorFavorite) => {
    try {
      await navigator.clipboard.writeText(stripChatDisclaimer(favorite.text));
      setCopiedFavoriteId(favorite.id);
      window.setTimeout(() => setCopiedFavoriteId(""), 1500);
    } catch {
      setCopiedFavoriteId("");
    }
  };

  const changeSaveChat = (saveChat: boolean) => {
    if (!saveChat && messages.length > 0 && !window.confirm(account.user ? "关闭后将清除账户中保存的对话与心理自评，其他设备也会同步此设置。确定继续吗？" : "关闭后将立即清除本机对话记录，确定继续吗？")) return;
    if (!saveChat) {
      setMessages([]);
      if (doctor.slug === "tang-jinsong") {
        if (account.user) consumerDataStore.set(doctor.slug, "chat-assessments-v1", null);
        try { window.localStorage.removeItem(doctorStorageKey(preview ? previewStorageSlug(doctor.slug) : doctor.slug, "chat-assessments-v1")); } catch { /* Storage may be unavailable. */ }
      }
    }
    setPrivacy((current) => ({ ...current, saveChat }));
  };

  const startNewGuest = () => {
    if (!window.confirm("这将清除本机保存的对话、收藏、健康记录、任务和游客资料，且无法恢复。确定开始新的游客体验吗？")) return;
    if (preview) {
      for (let index = window.localStorage.length - 1; index >= 0; index -= 1) { const key = window.localStorage.key(index); if (key?.includes(":" + previewStorageSlug(doctor.slug) + ":")) window.localStorage.removeItem(key); }
    } else clearCurrentVisitorData();
    window.location.reload();
  };

  const deleteHealthRecord = (recordId: string) => {
    if (!window.confirm("确定删除这条健康记录吗？")) return;
    const nextRecords = records.filter((record) => record.id !== recordId);
    setRecords(nextRecords);
    setDailyTasks(dailyTasksFromRecords(nextRecords, experience.steps));
  };

  const clearHealthRecords = () => {
    if (!window.confirm("确定清空全部健康档案吗？")) return;
    setRecords([]);
    setDailyTasks(createDailyTasks(experience.steps.length));
  };

  return (
    <div className="journey-simple-panel journey-me-panel">
      <header><span className="journey-eyebrow">PERSONAL CENTER</span><h1>我的</h1><p>管理你的健康记录、收藏与隐私设置。</p></header>
      <section className="journey-user-card">
        <span><UserCircleIcon size={48} weight="duotone" /></span>
        <div><h2>{account.user && ["游客账户", "微信用户"].includes(profileName) ? "微信用户" : profileName}</h2><p>{account.user ? "微信账户 · 支持跨设备同步" : "游客体验 · 记录保存在本机"}</p></div>
        <button disabled={templatePreview} onClick={openProfile}><NotePencilIcon size={16} /> 编辑</button>
      </section>
      {preview ? <p className="journey-preview-note">{templatePreview ? "模板只读预览：创建草稿后可使用账户、记录和交互功能。" : "草稿体验账户：记录仅保存在独立的本机预览空间，微信登录与云同步不可用。"}</p> : <ConsumerAccountCard doctorSlug={doctor.slug} />}
      {usesWellness(doctor) && onWellnessOpen && <WellnessMeLinks onOpen={onWellnessOpen} />}
      <div className="journey-menu-list">
        {(["我的收藏", "浏览记录", "健康档案", "隐私与设置", `关于${doctor.name}智能体`] as const).map((item, index) => (
          <button key={item} onClick={() => index === 2 && doctor.slug === "yu-wen" && onWellnessOpen ? onWellnessOpen('report') : setActivePanel((["favorites", "history", "records", "privacy", "about"] as const)[index])}><span>{index === 3 ? <LockKeyIcon size={19} /> : index === 4 ? <SparkleIcon size={19} /> : <FileTextIcon size={19} />}</span><b>{item}</b><em>{index === 0 ? favorites.length : index === 1 ? userQuestions.length : index === 2 && doctor.slug !== "yu-wen" ? records.length : ""}</em><CaretRightIcon size={17} /></button>
        ))}
      </div>
      {doctor.slug === 'yu-wen' && records.length > 0 && <button className="yw-text-button" onClick={() => setActivePanel('records')}>查看旧版健康记录（{records.length}）</button>}
      <p className="journey-version">{experience.eyebrow} · H5 / 微信 WebView</p>

      <AnimatePresence>
        {activePanel === "profile" && <FeatureSheet title="编辑个人资料" eyebrow="PERSONAL PROFILE" onClose={closePanel}>
          <label className="journey-field"><span>显示名称</span><input disabled={templatePreview} value={draftName} maxLength={16} onChange={(event) => setDraftName(event.target.value)} placeholder="请输入名称" /></label>
          <button className="journey-primary-button" disabled={templatePreview} onClick={() => { const next = draftName.trim() || "游客账户"; setProfileName(next); closePanel(); }}><FloppyDiskIcon size={18} /> 保存资料</button>
          <p className="journey-sheet-disclaimer"><LockKeyIcon size={14} /> {account.user ? "名称保存在你的账户中，可跨设备使用。" : "名称仅保存在当前设备，不会提交给医生。"}</p>
        </FeatureSheet>}

        {activePanel === "favorites" && <FeatureSheet title="我的收藏" eyebrow="SAVED ANSWERS" onClose={closePanel}>
          {favorites.length ? <><div className="journey-saved-list">{favorites.map((item) => <article key={item.id}><div className="journey-saved-markdown">{formatMedicalText(stripChatDisclaimer(item.text))}</div><p className="journey-reply-disclaimer" role="note">{CHAT_DISCLAIMER}</p><small>{new Date(item.createdAt).toLocaleString("zh-CN")}</small><div className="journey-list-actions"><button onClick={() => copyFavorite(item)}><CopyIcon size={15} />{copiedFavoriteId === item.id ? "已复制" : "复制"}</button><button onClick={() => continueQuestion(`请基于这条收藏内容继续说明：${formatMedicalText(stripChatDisclaimer(item.text)).slice(0, 160)}`)}><ChatCircleDotsIcon size={15} />继续咨询</button><button className="danger" onClick={() => setFavorites((current) => current.filter((favorite) => favorite.id !== item.id))} aria-label="取消收藏"><TrashIcon size={15} /></button></div></article>)}</div><button className="journey-danger-button" onClick={() => window.confirm("确定清空全部收藏吗？") && setFavorites([])}><TrashIcon size={16} /> 清空收藏</button></> : <div className="journey-empty-state"><BookmarkSimpleIcon size={34} weight="duotone" /><b>暂无收藏</b><p>在问医生页面点击回复下方的收藏按钮即可保存。</p></div>}
        </FeatureSheet>}

        {activePanel === "history" && <FeatureSheet title="浏览记录" eyebrow="QUESTION HISTORY" onClose={closePanel}>
          {userQuestions.length ? <><div className="journey-history-list">{userQuestions.map((item) => <article key={item.id}><ChatCircleDotsIcon size={18} /><div><b>{item.text}</b><small>{new Date(item.createdAt).toLocaleString("zh-CN")}</small></div><button className="journey-inline-action" onClick={() => continueQuestion(item.text)}>继续咨询</button></article>)}</div><button className="journey-danger-button" onClick={() => window.confirm("确定清空全部对话记录吗？") && setMessages([])}><TrashIcon size={16} /> 清空对话记录</button></> : <div className="journey-empty-state"><ClockCounterClockwiseIcon size={34} weight="duotone" /><b>暂无浏览记录</b><p>你在智能问答中发送的问题会显示在这里。</p></div>}
        </FeatureSheet>}

        {activePanel === "records" && <FeatureSheet title="健康档案" eyebrow="HEALTH RECORDS" onClose={closePanel}>
          <button className="journey-primary-button" onClick={() => { closePanel(); onManage(); }}><NotePencilIcon size={18} /> 填写记录与查看统计</button>
          {sortedHealthRecords.length ? <><div className="journey-record-list">{sortedHealthRecords.map((record) => <article key={record.id}><span>{healthRecordDateKey(record)}</span><b>{formatHealthMetricsSummary(record, doctor.builder ? configuredRecordConfig(doctor, getSpecialtyRecordConfig(doctor.slug)) : undefined) || record.completedTitles.join("、") || "自我记录"}</b>{record.note && <p>{record.note}</p>}<small>{record.source === "home" ? "状态记录" : "健康管理"}</small><div className="journey-list-actions">{doctor.slug === "tang-jinsong" ? <button disabled={!canShareRecentHealthRecords} onClick={() => { closePanel(); onAsk("请结合我最近的睡眠、情绪和日常状态记录，帮我看看最值得先调整的一点。", true); }}><ChatCircleDotsIcon size={15} />带近期记录咨询</button> : <button onClick={() => continueQuestion(`我想继续了解这次健康记录（${healthRecordDateKey(record)}）：${formatHealthMetricsSummary(record, doctor.builder ? configuredRecordConfig(doctor, getSpecialtyRecordConfig(doctor.slug)) : undefined) || record.completedTitles.join("、")}${record.note ? `；补充：${record.note}` : ""}`)}><ChatCircleDotsIcon size={15} />带记录咨询</button>}<button className="danger" onClick={() => deleteHealthRecord(record.id)}><TrashIcon size={15} />删除</button></div></article>)}</div><button className="journey-danger-button" onClick={clearHealthRecords}><TrashIcon size={16} /> 清空健康档案</button></> : <div className="journey-empty-state"><ClipboardTextIcon size={34} weight="duotone" /><b>暂无健康档案</b><p>完成首页状态记录后会自动保存到这里。</p></div>}
          <p className="journey-sheet-disclaimer"><ShieldCheckIcon size={14} /> {account.user ? "健康档案保存在你的账户中；" : "健康档案保存在当前设备；"}只有你主动选择咨询时，才会向 AI 提交{doctor.slug === "tang-jinsong" ? "近期结构化摘要" : "所选记录内容"}。</p>
        </FeatureSheet>}

        {activePanel === "privacy" && <FeatureSheet title="隐私与设置" eyebrow="PRIVACY SETTINGS" onClose={closePanel}>
          <div className="journey-settings-list">
            <label><div><b>保存对话记录</b><p>{account.user ? "将对话与心理自评保存在账户中，关闭时清除对应云端记录。" : doctor.slug === "tang-jinsong" ? "将对话与心理自评保存在当前设备；关闭时清除本机副本。" : "将对话历史保存在当前设备；关闭时会立即清除本机副本。"}</p></div><input type="checkbox" disabled={templatePreview} checked={privacy.saveChat} onChange={(event) => changeSaveChat(event.target.checked)} /></label>
            <label><div><b>自动语音播报</b><p>{doctor.slug === "tang-jinsong" ? "文字或语音提问后自动播放科普回复。" : "语音提问后自动播放科普回复。"}</p></div><input type="checkbox" checked={privacy.voicePlayback} onChange={(event) => setPrivacy((current) => ({ ...current, voicePlayback: event.target.checked }))} /></label>
            <label><div><b>健康提醒</b><p>显示首页健康记录提醒。</p></div><input type="checkbox" checked={privacy.reminders} onChange={(event) => setPrivacy((current) => ({ ...current, reminders: event.target.checked }))} /></label>
          </div>
          {!account.user && <button className="journey-danger-button" disabled={templatePreview} onClick={startNewGuest}><TrashIcon size={16} /> 清除数据并开始新游客体验</button>}
          <div className="journey-privacy-explanation">
            <p className="journey-sheet-disclaimer"><LockKeyIcon size={14} /> 问答时，当前问题与相关对话历史会发送给配置的 AI 服务。你主动选择的健康记录摘要或记录内容会一并发送。</p>
            <p className="journey-sheet-disclaimer">游客对话保存在本机。微信登录并开启保存后，对话与所保存的记录会存入账户数据库，用于跨设备查看。</p>
            <p className="journey-sheet-disclaimer">使用在线语音功能时，录音或待播报文本会发送至配置的语音服务，外部服务按其隐私政策处理数据。</p>
            <p className="journey-sheet-disclaimer">请勿发送身份证号、联系方式等不必要的敏感信息。保存设置和历史记录可在本页随时管理。</p>
          </div>
        </FeatureSheet>}

        {activePanel === "about" && <FeatureSheet title={`关于${doctor.name}智能体`} eyebrow="ABOUT THIS AGENT" onClose={closePanel}>
          <div className="journey-about-doctor"><DoctorPhoto doctor={doctor} className="journey-voice-avatar" /><div><b>{doctor.name}</b><span>{doctor.hospital}</span><span>{doctor.department}</span></div></div>
          <p className="journey-feature-lead">本智能体围绕{doctor.specialty}提供健康科普、信息梳理和就医准备建议。</p>
          <div className="journey-feature-checklist"><div><ShieldCheckIcon size={20} /><span>不提供诊断、处方或急救服务</span></div><div><LockKeyIcon size={20} /><span>记录可在各项历史或设置中删除</span></div><div><SparkleIcon size={20} /><span>AI 回复可能存在局限，请结合专业意见判断</span></div></div>
          <p className="journey-sheet-disclaimer">Medtalent 智能体平台 · 当前版本 1.3.0 · 支持微信账户同步</p>
        </FeatureSheet>}
      </AnimatePresence>
    </div>
  );
}

export default function DoctorApp({ preview = false, templatePreview = false }: { preview?: boolean; templatePreview?: boolean }) {
  const { slug, id: templateId } = useParams();
  const body = <DoctorTemplatePreviewContext.Provider value={templatePreview}><DoctorPreviewContext.Provider value={preview || templatePreview}><DoctorAppBody key={templatePreview ? templateId : slug} /></DoctorPreviewContext.Provider></DoctorTemplatePreviewContext.Provider>;
  return preview || templatePreview ? body : <ConsumerDataBoundary doctorSlug={slug || 'unknown'}>{body}</ConsumerDataBoundary>;
}

function DoctorAppBody() {
  const { slug, id: templateId } = useParams();
  const templatePreview = useDoctorTemplatePreview();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const preview = useDoctorPreview();
  const { doctor, loading, error, notFound, retry } = useDoctorResource(slug, preview, templatePreview ? templateId : undefined);
  const experience = useMemo(() => doctor ? doctorExperiences[doctor.slug] || createGenericExperience(doctor) : null, [doctor]);
  const tabStorageKey = useMemo(() => doctorSessionKey(preview ? previewStorageSlug(templatePreview ? "template~" + templateId : slug || "unknown") : slug || "unknown", "active-tab"), [slug, preview, templatePreview, templateId]);
  const [tab, setTab] = useState<Tab>(() => resolveDoctorEntryTab(preview ? pathname.replace("/admin/preview/", "/d/") : pathname, slug || "unknown", () => window.sessionStorage.getItem(tabStorageKey)));
  const [initialQuestion, setInitialQuestion] = useState("");
  const [initialShareHealthRecords, setInitialShareHealthRecords] = useState(false);
  const [wellnessView, setWellnessView] = useState<WellnessView | null>(null);
  const pendingTabNavigation = useRef<{ pathname: string; tab: Tab } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const [chatViewport, setChatViewport] = useState(() => resolveChatViewport({ layoutHeight: window.innerHeight }));

  useEffect(() => {
    if (tab !== "ask") return;
    const viewport = window.visualViewport;
    let baselineHeight = window.innerHeight, baselineWidth = window.innerWidth, frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const editorFocused = document.activeElement instanceof Element && Boolean(document.activeElement.closest(".journey-chat-input"));
        if (window.innerWidth !== baselineWidth) { baselineWidth = window.innerWidth; baselineHeight = window.innerHeight; }
        setChatViewport((previous) => {
          if (!editorFocused && !previous.keyboardOpen) baselineHeight = window.innerHeight;
          return resolveChatViewport({ layoutHeight: window.innerHeight, visibleHeight: viewport?.height, offsetTop: viewport?.offsetTop, scale: viewport?.scale, baselineHeight, editorActive: editorFocused || previous.keyboardOpen });
        });
      });
    };
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
    };
  }, [tab]);

  useEffect(() => {
    const pending = pendingTabNavigation.current;
    pendingTabNavigation.current = null;
    setTab(pending?.pathname === pathname ? pending.tab : resolveDoctorEntryTab(pathname, slug || "unknown", () => window.sessionStorage.getItem(tabStorageKey)));
  }, [pathname, slug, tabStorageKey]);

  useEffect(() => {
    try { window.sessionStorage.setItem(tabStorageKey, tab); } catch { /* 当前会话仍可使用。 */ }
    const frame = window.requestAnimationFrame(() => contentRef.current?.scrollTo({ top: 0, behavior: "auto" }));
    return () => window.cancelAnimationFrame(frame);
  }, [tab, tabStorageKey]);

  if (loading) {
    return <div className="journey-not-found" role="status" aria-live="polite"><StethoscopeIcon size={44} weight="duotone" /><h1>正在加载智能体</h1><p>正在获取最新发布的资料，请稍候。</p><Link to="/"><ArrowLeftIcon size={17} /> 返回智能体矩阵</Link></div>;
  }

  if (!doctor || !experience) {
    return <div className="journey-not-found" role="alert"><StethoscopeIcon size={44} weight="duotone" /><h1>{notFound ? "智能体不存在或已下线" : "暂时无法加载智能体"}</h1><p>{error || "请稍后重试。"}</p><button type="button" className="journey-load-retry" onClick={retry}><ArrowClockwiseIcon size={17} /> 重新加载</button><Link to="/"><ArrowLeftIcon size={17} /> 返回智能体矩阵</Link></div>;
  }

  const switchTab = (nextTab: Tab) => {
    if (!configuredNavigation(doctor, navItems).some(item => item.id === nextTab)) return;
    setWellnessView(null);
    setTab(nextTab);
    // Save the explicit choice before changing the URL so leaving /ask cannot restore the old tab.
    try { window.sessionStorage.setItem(tabStorageKey, nextTab); } catch { /* The current tab remains usable. */ }
    const nextPath = templatePreview ? `/admin/template-preview/${encodeURIComponent(templateId || "")}${nextTab === "ask" ? "/ask" : ""}` : preview ? `/admin/preview/${encodeURIComponent(doctor.slug)}${nextTab === "ask" ? "/ask" : ""}` : doctorTabPath(doctor.slug, nextTab);
    if (pathname !== nextPath) {
      pendingTabNavigation.current = { pathname: nextPath, tab: nextTab };
      navigate(nextPath, { replace: true });
    }
  };

  const openWellness = (view: WellnessView) => {
    switchTab(['diary', 'health', 'report', 'goals'].includes(view) ? 'manage' : 'services');
    setWellnessView(view);
  };

  const goAsk: AskNavigator = (question = "", shareHealthRecords = false) => {
    if (!componentEnabled(doctor, "chat")) return;
    setInitialQuestion(question);
    setInitialShareHealthRecords(shareHealthRecords);
    switchTab("ask");
  };

  const availableNavigation = configuredNavigation(doctor, navItems);
  const visibleTab = availableNavigation.some(item => item.id === tab) ? tab : (availableNavigation[0]?.id || "me");
  const themeStyle = {
    "--journey-accent": experience.theme.accent,
    "--journey-accent-strong": experience.theme.accentStrong,
    "--journey-accent-rgb": experience.theme.accentRgb,
    "--journey-surface": experience.theme.surface,
    "--journey-canvas": experience.theme.canvas,
    "--journey-ink": experience.theme.ink,
    "--journey-viewport-height": `${chatViewport.height}px`,
    "--journey-viewport-top": `${chatViewport.top}px`,
  } as CSSProperties;

  const app = (
    <main className={`journey-stage ${builderLayoutClass(doctor)}${doctor.slug === "tang-jinsong" ? " is-tang-agent" : ""}${doctorExperiences[doctor.slug] ? "" : " is-generic-agent"}${visibleTab === "ask" ? " is-chat-active" : ""}${visibleTab === "ask" && chatViewport.keyboardOpen ? " is-keyboard-open" : ""}`} style={themeStyle}>
      <div className={preview ? "journey-phone is-preview" : "journey-phone"}>
        {!preview && <Link className="journey-back" to="/"><ArrowLeftIcon size={16} /> 智能体矩阵</Link>}
        {preview && <div className="journey-preview-banner" role="status"><Link className="journey-preview-return" to="/admin"><ArrowLeftIcon size={14} /> 返回后台</Link><b>{templatePreview ? "模板预览 · 尚未创建智能体" : "草稿预览 · 尚未发布"}</b><span>{templatePreview ? "仅展示完整界面；创建草稿后才能保存、问答或使用语音。" : "使用后台当前草稿；体验数据独立保存在本机，不同步消费者账户。账号操作已停用。"}</span></div>}
        <div className={`journey-content${visibleTab === "ask" ? " is-chat-content" : ""}`} ref={contentRef}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              className={`journey-tab-panel ${visibleTab === "ask" ? "is-chat" : ""}`}
              key={`${doctor.slug}:${visibleTab}`}
              initial={reduced ? false : { opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduced ? undefined : { opacity: 0, x: -6 }}
              transition={{ duration: reduced ? 0 : 0.2 }}
            >
              {visibleTab === "home" && <HomePanel doctor={doctor} experience={experience} onAsk={goAsk} onWellnessOpen={openWellness} onManage={() => switchTab("manage")} />}
              {visibleTab === "ask" && <AskPanel key={doctor.slug} doctor={doctor} experience={experience} initialQuestion={initialQuestion} initialShareHealthRecords={initialShareHealthRecords} onConsumeInitialQuestion={() => { setInitialQuestion(""); setInitialShareHealthRecords(false); }} />}
              {visibleTab === "manage" && (usesWellness(doctor) && !doctor.builder ? <WellnessWorkspace section="manage" view={wellnessView} onView={setWellnessView} onAsk={goAsk} /> : <ManagePanel doctor={doctor} experience={experience} onAsk={goAsk} wellnessView={wellnessView} onWellnessView={setWellnessView} />)}
              {visibleTab === "services" && (usesWellness(doctor) ? <WellnessWorkspace section="services" view={wellnessView} onView={setWellnessView} onAsk={goAsk} servicePlans={componentEnabled(doctor, "services") && <ServicesPanel compact doctor={doctor} experience={experience} onAsk={goAsk} onManage={() => openWellness('diary')} />} /> : <ServicesPanel doctor={doctor} experience={experience} onAsk={goAsk} onManage={() => switchTab("manage")} />)}
              {visibleTab === "me" && <MePanel doctor={doctor} experience={experience} onAsk={goAsk} onWellnessOpen={openWellness} onManage={() => switchTab("manage")} />}
            </motion.div>
          </AnimatePresence>
        </div>
        <nav className="journey-nav" aria-label="医生智能体主导航">
          {availableNavigation.map((item) => {
            const NavIcon = item.icon;
            const active = visibleTab === item.id;
            return (
              <button className={active ? "is-active" : ""} onClick={() => switchTab(item.id)} key={item.id} aria-current={active ? "page" : undefined}>
                <span><NavIcon size={22} weight={active ? "fill" : "regular"} /></span>
                <em>{item.id === "ask" && !doctor.builder && !doctorExperiences[doctor.slug] ? "问智能体" : item.label}</em>
              </button>
            );
          })}
        </nav>
      </div>
    </main>
  );
  return usesWellness(doctor) ? <WellnessProvider doctorSlug={doctor.slug} doctorName={doctor.name}>{app}</WellnessProvider> : app;
}
