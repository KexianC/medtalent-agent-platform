import { useNavigate } from "react-router-dom";
import { ArrowLeft, CheckCircle2, Apple, HeartPulse, MessagesSquare } from "lucide-react";

export default function AdDietitian() {
  const navigate = useNavigate();

  const features = [
    {
      icon: Apple,
      title: "定制专属食谱",
      desc: "根据个人体质、偏好与健康目标，量身定制三餐饮食方案。",
      color: "text-emerald-500",
      bg: "bg-emerald-50",
    },
    {
      icon: MessagesSquare,
      title: "一对一答疑解惑",
      desc: "专业营养师在线指导，随时解答日常饮食、营养搭配疑问。",
      color: "text-blue-500",
      bg: "bg-blue-50",
    },
    {
      icon: HeartPulse,
      title: "全方位健康追踪",
      desc: "记录每日打卡，监测健康指标变化，及时调整营养干预策略。",
      color: "text-rose-500",
      bg: "bg-rose-50",
    },
  ];

  return (
    <div className="flex flex-col h-full bg-white overflow-y-auto pb-safe relative">
      {/* Header */}
      <header className="fixed top-0 left-1/2 -translate-x-1/2 w-full max-w-[480px] pt-10 pb-4 px-5 bg-white/80 backdrop-blur-md shrink-0 border-b border-[#e8e6dc]/60 z-50">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="w-9 h-9 rounded-full bg-white border border-[#e8e6dc] shadow-sm flex items-center justify-center text-[#b0aea5] hover:text-[#6a9bcc] hover:border-[#6a9bcc]/30 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#6a9bcc]"
            aria-label="返回"
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
          <h1 className="text-[18px] font-semibold text-[#141413] tracking-tight font-heading">
            专属营养师计划
          </h1>
        </div>
      </header>

      {/* Hero Section */}
      <div className="pt-24 pb-8 px-5 bg-gradient-to-br from-[#6a9bcc]/10 to-transparent">
        <div className="mt-4">
          <span className="inline-block px-3 py-1 bg-[#6a9bcc]/10 text-[#6a9bcc] rounded-full text-[13px] font-medium mb-4">
            全面升级
          </span>
          <h2 className="text-[32px] leading-tight font-bold text-[#141413] mb-4 font-heading">
            科学营养管理<br />
            <span className="text-[#6a9bcc]">健康生活新起点</span>
          </h2>
          <p className="text-[15px] text-[#717069] leading-relaxed font-serif">
            打破传统节食观念，由专业国家级注册营养师为你提供全周期的科学饮食干预与陪伴。
          </p>
        </div>
      </div>

      {/* Main Content */}
      <div className="px-5 py-8 space-y-8 flex-1 pb-48">
        {/* Why Choose Us */}
        <section>
          <h3 className="text-[18px] font-bold text-[#141413] mb-6 font-heading">服务特色</h3>
          <div className="space-y-4">
            {features.map((feature, index) => {
              const Icon = feature.icon;
              return (
                <div key={index} className="flex items-start gap-4 p-4 rounded-[20px] border border-[#e8e6dc]/50 bg-[#faf9f5]">
                  <div className={`w-12 h-12 rounded-[16px] flex items-center justify-center shrink-0 ${feature.bg}`}>
                    <Icon size={24} className={feature.color} />
                  </div>
                  <div>
                    <h4 className="text-[16px] font-bold text-[#141413] mb-1 font-heading">{feature.title}</h4>
                    <p className="text-[13px] text-[#717069] leading-relaxed font-serif">{feature.desc}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Highlight Plan */}
        <section className="bg-[#6a9bcc] rounded-[24px] p-6 text-white relative overflow-hidden shadow-md">
          <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full blur-2xl -translate-y-1/2 translate-x-1/4" />
          <h3 className="text-[18px] font-bold mb-4 relative z-10 font-heading">计划包含</h3>
          <ul className="space-y-3 relative z-10">
            {["深度体质与健康史评估", "周期性定制三餐建议", "每日微信群饮食打卡点评", "月度健康报告与改进方案"].map((item, idx) => (
              <li key={idx} className="flex items-center gap-2.5 text-[14px] font-medium text-white/90">
                <CheckCircle2 size={18} className="text-white/80" />
                {item}
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* Bottom CTA Action Bar */}
      <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[480px] bg-white border-t border-[#e8e6dc]/60 p-4 pb-safe z-50">
        <div className="w-full flex items-center gap-4">
          <div className="flex-1">
            <p className="text-[12px] text-[#b0aea5] font-serif mb-0.5">限时特惠</p>
            <p className="text-[20px] font-bold text-[#f43f5e] leading-none">¥ 99 <span className="text-[12px] text-[#b0aea5] line-through font-normal">¥ 399</span></p>
          </div>
          <button
            type="button"
            onClick={() => {
              alert("加入计划功能正在开发中");
            }}
            className="bg-[#6a9bcc] text-white px-8 py-3.5 rounded-full text-[16px] font-bold shadow-md hover:bg-[#5b8cbf] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#6a9bcc] active:scale-95"
          >
            立即加入计划
          </button>
        </div>
      </div>
    </div>
  );
}
