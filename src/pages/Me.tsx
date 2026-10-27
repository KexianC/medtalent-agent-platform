import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { 
  User, 
  Settings, 
  Bookmark, 
  Clock, 
  HelpCircle, 
  Info, 
  ChevronRight,
  CheckCircle2,
  BellRing,
  Target,
  ArrowRight,
  UserCheck
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { listNotices } from "@/data/noticeCatalog";

export default function Me() {
  const navigate = useNavigate();
  const [checkedIn, setCheckedIn] = useState(false);
  const [checkinTip, setCheckinTip] = useState(false);
  const reminders = useMemo(() => listNotices("reminder"), []);
  const news = useMemo(() => listNotices("news"), []);

  const menuItems = [
    { icon: Bookmark, label: "我的收藏", color: "text-[#8B5E3C]", path: "/me/saved" },
    { icon: Clock, label: "浏览历史", color: "text-[#C57B57]", path: "/me/history" },
    { icon: Settings, label: "个人设置", color: "text-[#5D7A4A]", path: "/me/settings" },
    { icon: HelpCircle, label: "帮助与反馈", color: "text-[#B5A898]", path: "/me/help" },
    { icon: Info, label: "关于我们", color: "text-[#B5A898]", path: "/me/about" },
  ];

  return (
    <div className="flex flex-col h-full bg-[#FAF7F2] overflow-y-auto traditional-texture-bg">
      {/* Header Profile Area */}
      <div className="relative shrink-0 mb-6 z-10">
        <div className="bg-[#8B5E3C] px-5 pt-12 pb-16 rounded-b-[40px] shadow-sm relative overflow-hidden">
          {/* Decorative background element */}
          <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
          
          <div className="flex items-center justify-between relative z-10">
            <div className="flex items-center gap-5">
              <div className="w-20 h-20 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center border-2 border-white/30 shrink-0 shadow-inner">
                <User size={40} className="text-white" aria-hidden="true" />
              </div>
              <div className="text-white">
                <h1 className="text-[28px] font-semibold tracking-tight font-heading">王先生</h1>
                <p className="text-white/80 mt-1 flex items-center gap-1.5 text-[14px]">
                  <UserCheck size={16} aria-hidden="true" /> 签约管理中
                </p>
              </div>
            </div>
            
            {/* Circular Progress */}
            <div className="relative w-16 h-16 flex items-center justify-center bg-white/10 rounded-full backdrop-blur-sm border border-white/20">
              <svg className="w-full h-full transform -rotate-90 p-1" viewBox="0 0 36 36">
                <path
                  className="text-white/20"
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                />
                <motion.path
                  initial={{ strokeDasharray: "0, 100" }}
                  animate={{ strokeDasharray: "85, 100" }}
                  transition={{ duration: 1.5, ease: "easeOut" }}
                  className="text-white"
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center text-white">
                <span className="text-[9px] font-medium opacity-90 mt-0.5">画像</span>
                <span className="text-[12px] font-bold -mt-0.5 tabular-nums">85%</span>
              </div>
            </div>
          </div>
        </div>
        
        {/* Floating Card - Health Points & Check-in */}
        <div className="absolute -bottom-6 left-5 right-5 bg-white rounded-2xl shadow-md border border-[#E8E0D5]/50 p-4 flex justify-between items-center z-20">
          <div>
            <p className="text-[12px] text-[#B5A898] font-medium">健康积分</p>
            <p className="text-[22px] font-semibold text-[#3D3226] mt-0.5 tabular-nums font-heading">
              {new Intl.NumberFormat('zh-CN').format(1240)} <span className="text-[13px] text-[#8B5E3C] font-medium font-serif ml-0.5">分</span>
            </p>
          </div>
          <div className="w-[1px] h-10 bg-[#E8E0D5]/60"></div>
          <button 
            type="button"
            onClick={() => {
              setCheckedIn(true);
              setCheckinTip(true);
              window.setTimeout(() => setCheckinTip(false), 2000);
            }}
            disabled={checkedIn}
            className={`px-5 py-2.5 rounded-full text-[14px] font-medium transition-all flex items-center gap-2 outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#8B5E3C] ${
              checkedIn 
                ? 'bg-[#E8E0D5]/50 text-[#B5A898] cursor-not-allowed' 
                : 'bg-[#8B5E3C] text-white shadow-sm hover:bg-[#7A4E30] active:scale-95'
            }`}
          >
            {checkedIn ? <CheckCircle2 size={16} aria-hidden="true" /> : <Target size={16} aria-hidden="true" />}
            {checkedIn ? '已打卡' : '每日打卡'}
          </button>
        </div>
      </div>

      <div className="px-5 pt-4 pb-6 space-y-8 flex-1">
        {checkinTip ? (
          <div className="bg-[#8B5E3C]/10 border border-[#8B5E3C]/20 rounded-2xl p-4 text-[#8B5E3C] text-[13px] font-medium">
            打卡成功，已为你记录今日进度
          </div>
        ) : null}
        
        {/* Health Reminders */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[18px] font-semibold text-[#3D3226] font-heading chinese-ornament pb-3">健康提醒</h2>
            <span className="text-[12px] text-[#8B5E3C] font-medium bg-[#8B5E3C]/10 px-2.5 py-1 rounded-full tabular-nums">2条待办</span>
          </div>
          <div className="space-y-3">
            {reminders.slice(0, 2).map((r, idx) => (
              <button
                key={r.id}
                type="button"
                onClick={() => navigate(`/notice/${r.id}`)}
                className={
                  idx === 0
                    ? "w-full text-left bg-[#C57B57]/5 border border-[#C57B57]/20 rounded-2xl p-4 flex gap-4 outline-none focus-visible:ring-2 focus-visible:ring-[#C57B57] hover:bg-[#C57B57]/10 transition-colors"
                    : "w-full text-left bg-white border border-[#E8E0D5] rounded-2xl p-4 flex gap-4 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-[#8B5E3C] hover:border-[#8B5E3C]/30 transition-colors"
                }
              >
                <div
                  className={
                    idx === 0
                      ? "mt-0.5 text-[#C57B57] bg-white rounded-full p-2 shadow-sm h-fit border border-[#C57B57]/10 shrink-0"
                      : "mt-0.5 text-[#5D7A4A] bg-[#5D7A4A]/10 rounded-full p-2 h-fit shrink-0"
                  }
                >
                  {idx === 0 ? <BellRing size={18} aria-hidden="true" /> : <CheckCircle2 size={18} aria-hidden="true" />}
                </div>
                <div>
                  <h3 className={idx === 0 ? "text-[15px] font-semibold text-[#C57B57] font-heading" : "text-[15px] font-semibold text-[#3D3226] font-heading"}>
                    {r.title}
                  </h3>
                  <p className={idx === 0 ? "text-[13px] text-[#C57B57]/80 mt-1.5 leading-relaxed font-serif" : "text-[13px] text-[#B5A898] mt-1 tabular-nums"}>
                    {r.summary || r.publishedAt || ""}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* Menu List Area */}
        <section>
          <h2 className="text-[18px] font-semibold text-[#3D3226] font-heading chinese-ornament pb-3 mb-4">个人中心</h2>
          <div className="bg-white rounded-[24px] shadow-sm border border-[#E8E0D5]/50 overflow-hidden">
            {menuItems.map((item, index) => {
              const Icon = item.icon;
              return (
                <button
                  key={index}
                  type="button"
                  onClick={() => navigate(item.path)}
                  className="w-full flex items-center justify-between p-4 outline-none focus-visible:bg-[#FAF7F2] hover:bg-[#FAF7F2]/50 transition-colors group border-b border-[#E8E0D5]/30 last:border-b-0 active:bg-[#FAF7F2]"
                >
                  <div className="flex items-center gap-4">
                    <div className={`p-2 rounded-xl bg-[#FAF7F2] group-hover:bg-white transition-colors ${item.color}`}>
                      <Icon size={20} strokeWidth={2.5} aria-hidden="true" />
                    </div>
                    <span className="text-[16px] font-medium text-[#3D3226]">{item.label}</span>
                  </div>
                  <ChevronRight size={20} className="text-[#B5A898] group-hover:text-[#8B5E3C] transition-colors" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </section>

        {/* Latest News */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[18px] font-semibold text-[#3D3226] font-heading chinese-ornament pb-3">最新资讯</h2>
            <button type="button" className="text-[13px] text-[#B5A898] hover:text-[#8B5E3C] flex items-center outline-none focus-visible:ring-2 focus-visible:ring-[#8B5E3C] rounded-md px-1 transition-colors">
              查看全部 <ArrowRight size={14} className="ml-0.5" aria-hidden="true" />
            </button>
          </div>
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-[#E8E0D5]/50 space-y-4">
            {news.slice(0, 3).map((n) => (
              <button
                type="button"
                key={n.id}
                onClick={() => navigate(`/notice/${n.id}`)}
                className="w-full flex justify-between items-center group cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-[#8B5E3C] rounded-sm py-0.5"
              >
                <div className="flex items-center gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#E8E0D5] group-hover:bg-[#8B5E3C] transition-colors shrink-0"></div>
                  <span className="text-[14px] text-[#3D3226] group-hover:text-[#8B5E3C] transition-colors line-clamp-1 font-serif">
                    {n.title}
                  </span>
                </div>
                <span className="text-[12px] text-[#B5A898] shrink-0 ml-3 tabular-nums">{n.publishedAt || ""}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
