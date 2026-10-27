import {
  ArrowRight,
  Baby,
  Brain,
  Drop,
  Ear,
  FirstAid,
  GenderFemale,
  Wind,
  MagnifyingGlass,
  PlusCircle,
  ShieldCheck,
} from "@phosphor-icons/react";
import { type CSSProperties, type FormEvent, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useDoctorDirectory } from "../hooks/useDoctorDirectory";
import { doctorTopics, matchesDoctorTopic, type TopicKey } from "../lib/doctorTopics";

const knowledgeFocus: Record<string, string> = {
  "fu-junfen": "儿童糖尿病与生长发育科普",
  "chen-zhiling": "鼻炎、听力与耳鼻喉健康科普",
  "gong-wenbo": "代谢健康与中医生活调养科普",
  "chen-jinbiao": "肿瘤健康知识与康复科普",
  "wu-yuqin": "体重管理与健康生活方式科普",
  "lin-jinfang": "女性生殖内分泌健康科普",
  "luo-jun": "肝胆肿瘤介入知识科普",
  "yu-weihua": "胃肠肝胆与代谢健康科普",
  "zhou-yong": "呼吸健康与肺部疾病科普",
  "yu-wen": "睡眠、情绪与认知健康科普",
  "tang-jinsong": "精神心理、睡眠与早期干预科普",
};

const topicIcons = { child: Baby, endocrine: Drop, ent: Ear, respiratory: Wind, oncology: PlusCircle, digestive: FirstAid, women: GenderFemale, mental: Brain };
const topicOptions = doctorTopics.map((topic) => ({ ...topic, Icon: topicIcons[topic.key] }));

export default function DoctorHub() {
  const { doctors, loading, error, retry } = useDoctorDirectory();
  const [query, setQuery] = useState("");
  const [activeTopic, setActiveTopic] = useState<TopicKey>("all");
  const doctorSectionRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const activeTopicLabel = topicOptions.find((topic) => topic.key === activeTopic)?.label;

  const filteredDoctors = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");

    return doctors.filter((doctor) => {
      const searchable = [doctor.name, doctor.department, doctor.specialty, knowledgeFocus[doctor.slug], ...doctor.topics]
        .join(" ")
        .toLocaleLowerCase("zh-CN");
      const matchesQuery = !normalizedQuery || searchable.includes(normalizedQuery);
      return matchesQuery && matchesDoctorTopic(doctor, activeTopic);
    });
  }, [activeTopic, doctors, query]);

  const scrollToDoctors = () => {
    window.requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      doctorSectionRef.current?.scrollIntoView({ behavior: reduceMotion ? "instant" : "smooth", block: "start" });
    });
  };

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    searchInputRef.current?.blur();
    scrollToDoctors();
  };

  const chooseTopic = (key: TopicKey) => {
    setActiveTopic((current) => current === key ? "all" : key);
    // Keep the mobile topic controls visible while users compare categories.
    if (!window.matchMedia("(max-width: 640px)").matches) scrollToDoctors();
  };

  const clearFilters = () => {
    setQuery("");
    setActiveTopic("all");
  };

  return (
    <main className="hub-shell">
      <header className="hub-header">
        <Link to="/" className="hub-brand" aria-label="Medtalent智能体平台首页">
          <img src="/assets/brand/medtalent-logo.png" alt="Medtalent 标志" />
          <span className="hub-brand-desktop">Medtalent智能体平台</span>
          <span className="hub-brand-mobile"><strong>Medtalent</strong><small>智能体广场</small></span>
        </Link>
        <nav className="hub-nav" aria-label="首页导航">
          <a href="#health-topics">健康主题</a>
          <a href="#doctor-agents">科普智能体</a>
        </nav>
        <span className="hub-mobile-badge"><ShieldCheck size={15} aria-hidden="true" />健康科普</span>
      </header>

      <section className="hub-hero" aria-labelledby="hub-title">
        <div className="hub-hero-inner">
          <div className="hub-copy">
            <h1 id="hub-title"><span className="hub-desktop-title">可信医生知识，<span className="hub-title-break">智能科普陪伴</span></span><span className="hub-mobile-title">健康知识，随时了解</span></h1>
            <p className="hub-question"><span className="hub-desktop-title">想了解哪方面健康知识？</span><span className="hub-mobile-title">选择科普智能体，了解你关心的健康话题</span></p>
            <form className="hub-search" role="search" onSubmit={handleSearch}>
              <MagnifyingGlass size={25} aria-hidden="true" />
              <label className="sr-only" htmlFor="hub-search-input">搜索疾病知识、健康主题或医生</label>
              <input
                id="hub-search-input"
                ref={searchInputRef}
                type="search"
                enterKeyHint="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索健康知识或医生"
                aria-controls="doctor-agents"
                autoComplete="off"
              />
              <button type="submit">搜索</button>
            </form>
            <div className="hub-disclaimer" role="note">
              <ShieldCheck size={19} weight="duotone" aria-hidden="true" />
              <span>本平台不提供诊疗服务，仅提供健康科普与一般性建议，回答仅供参考。</span>
            </div>
          </div>
        </div>
      </section>

      <section className="hub-topics" id="health-topics" aria-labelledby="topic-title">
        <div className="hub-section-heading hub-topic-heading">
          <div>
            <h2 id="topic-title">热门健康主题</h2>
          </div>
          <button type="button" onClick={() => chooseTopic("all")} className={activeTopic === "all" ? "active" : ""} aria-pressed={activeTopic === "all"} aria-controls="doctor-agents">
            全部主题 <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="hub-topic-grid">
          {topicOptions.map(({ key, label, Icon }, index) => (
            <button
              type="button"
              key={key}
              className={activeTopic === key ? "active" : ""}
              onClick={() => chooseTopic(key)}
              aria-pressed={activeTopic === key}
              aria-controls="doctor-agents"
              style={{ "--delay": `${index * 40}ms` } as CSSProperties}
            >
              <Icon size={28} weight="duotone" aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="hub-doctors" id="doctor-agents" ref={doctorSectionRef} aria-labelledby="doctor-title" aria-busy={loading}>
        <div className="hub-section-heading">
          <div>
            <h2 id="doctor-title">{activeTopicLabel ? `${activeTopicLabel}智能体` : "健康科普智能体"}</h2>
            <p>由专业医生整理健康知识与一般性建议，帮助您更容易理解健康信息。</p>
          </div>
          <div className="hub-result-meta" aria-live="polite">
            <span>{loading ? "正在加载智能体…" : error ? "目录暂不可用" : `${filteredDoctors.length} 位科普智能体`}</span>
            {(query || activeTopic !== "all") && <button type="button" onClick={clearFilters}>清除筛选</button>}
          </div>
        </div>

        {loading ? (
          <div className="hub-empty" role="status"><Brain size={30} aria-hidden="true" /><h3>正在加载科普智能体</h3><p>正在获取最新发布的智能体目录，请稍候。</p></div>
        ) : error ? (
          <div className="hub-empty" role="alert"><ShieldCheck size={30} aria-hidden="true" /><h3>暂时无法加载智能体</h3><p>{error}</p><button type="button" onClick={retry}>重新加载</button></div>
        ) : filteredDoctors.length > 0 ? (
          <div className="hub-doctor-grid">
            {filteredDoctors.map((doctor, index) => (
              <article
                key={doctor.slug}
                className="hub-doctor-card"
                style={{ "--accent": doctor.accent, "--soft": doctor.accentSoft, "--delay": `${index * 38}ms` } as CSSProperties}
              >
                <div className="hub-doctor-portrait" style={{ background: doctor.portraitBackground ?? doctor.accentSoft }}>
                  {doctor.portrait ? <img
                    src={doctor.portrait}
                    alt={`${doctor.name}头像`}
                    loading={index < 5 ? "eager" : "lazy"}
                    decoding="async"
                    style={{
                      objectPosition: doctor.portraitPosition ?? "50% 50%",
                      transform: `translateY(${doctor.portraitTranslateY ?? "0"}) scale(${doctor.portraitScale ?? 1})`,
                      transformOrigin: doctor.portraitTransformOrigin ?? "50% 50%",
                    }}
                  /> : <span aria-label={`${doctor.name}头像`} style={{ display: "grid", placeItems: "center", height: "100%", color: doctor.accent, fontSize: 54, fontWeight: 600 }}>{doctor.name.slice(0, 1)}</span>}
                </div>
                <div className="hub-doctor-copy">
                  <span className="hub-doctor-department">{doctor.department}</span>
                  <div className="hub-doctor-name"><h3>{doctor.name}</h3><span className="hub-doctor-department-inline">{doctor.department}</span></div>
                  {doctor.hospital && <p className="hub-doctor-hospital">{doctor.hospital}</p>}
                  <p className="hub-doctor-focus">{knowledgeFocus[doctor.slug] || doctor.specialty || doctor.intro}</p>
                </div>
                <Link to={`/d/${doctor.slug}`} className="hub-doctor-link" aria-label={`进入${doctor.name}的健康科普智能体`}>
                  <span className="hub-desktop-title">进入科普智能体</span><span className="hub-mobile-title">进入智能体</span> <ArrowRight size={15} aria-hidden="true" />
                </Link>
              </article>
            ))}
          </div>
        ) : (
          <div className="hub-empty" role="status">
            <MagnifyingGlass size={30} aria-hidden="true" />
            <h3>{doctors.length ? "暂未找到匹配内容" : "暂无已发布的智能体"}</h3>
            <p>{doctors.length ? "可以换一个健康主题或医生姓名试试。" : "智能体发布后会出现在这里，请稍后再来。"}</p>
            {doctors.length ? <button type="button" onClick={clearFilters}>查看全部科普智能体</button> : <button type="button" onClick={retry}>刷新目录</button>}
          </div>
        )}
      </section>

      <footer className="hub-footer-note">
        <ShieldCheck size={18} weight="duotone" aria-hidden="true" />
        <span>本平台不提供诊疗服务，仅提供健康科普与一般性建议，回答仅供参考。</span>
      </footer>
    </main>
  );
}
