import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { CheckCircle2, BellRing, Target, ArrowRight, UserCheck } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { listNotices } from "@/data/noticeCatalog";

export default function Manage() {
  const [checkedIn, setCheckedIn] = useState(false);
  const [checkinTip, setCheckinTip] = useState(false);
  const navigate = useNavigate();
  const reminders = useMemo(() => listNotices("reminder"), []);
  const news = useMemo(() => listNotices("news"), []);
  
  return (
    <div className="flex flex-col h-full bg-[#faf9f5] overflow-y-auto">
      {/* Header Profile Area */}
      <div className="relative shrink-0 mb-6 z-10">
        <div className="bg-[#6a9bcc] px-5 pt-12 pb-16 rounded-b-[40px] shadow-sm relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
          
          <div className="flex items-center justify-between relative z-10">
            <div className="text-white">
              <h1 className="text-[28px] font-semibold tracking-tight font-heading">王先生</h1>
              <p className="text-white/80 mt-1 flex items-center gap-1.5 text-[14px]">
                <UserCheck size={16} aria-hidden="true" /> 签约管理中
              </p>
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
        
        {/* Floating Card */}
        <div className="absolute -bottom-6 left-5 right-5 bg-white rounded-2xl shadow-md border border-[#e8e6dc]/50 p-4 flex justify-between items-center z-20">
          <div>
            <p className="text-[12px] text-[#b0aea5] font-medium">健康积分</p>
            <p className="text-[22px] font-semibold text-[#141413] mt-0.5 tabular-nums font-heading">
              {new Intl.NumberFormat('zh-CN').format(1240)} <span className="text-[13px] text-[#6a9bcc] font-medium font-serif ml-0.5">分</span>
            </p>
          </div>
          <div className="w-[1px] h-10 bg-[#e8e6dc]/60"></div>
          <button 
            type="button"
            onClick={() => {
              setCheckedIn(true);
              setCheckinTip(true);
              window.setTimeout(() => setCheckinTip(false), 2000);
            }}
            disabled={checkedIn}
            className={`px-5 py-2.5 rounded-full text-[14px] font-medium transition-all flex items-center gap-2 outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#6a9bcc] ${
              checkedIn 
                ? 'bg-[#e8e6dc]/50 text-[#b0aea5] cursor-not-allowed' 
                : 'bg-[#6a9bcc] text-white shadow-sm hover:bg-[#5b8cbf] active:scale-95'
            }`}
          >
            {checkedIn ? <CheckCircle2 size={16} aria-hidden="true" /> : <Target size={16} aria-hidden="true" />}
            {checkedIn ? '已打卡' : '每日打卡'}
          </button>
        </div>
      </div>

      <div className="px-5 pt-4 pb-6 space-y-8 flex-1">
        {checkinTip ? (
          <div className="bg-[#6a9bcc]/10 border border-[#6a9bcc]/20 rounded-2xl p-4 text-[#6a9bcc] text-[13px] font-medium">
            打卡成功，已为你记录今日进度
          </div>
        ) : null}
        
        {/* Reminders */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[18px] font-semibold text-[#141413] font-heading">健康提醒</h2>
            <span className="text-[12px] text-[#6a9bcc] font-medium bg-[#6a9bcc]/10 px-2.5 py-1 rounded-full tabular-nums">2条待办</span>
          </div>
          <div className="space-y-3">
            {reminders.slice(0, 2).map((r, idx) => (
              <button
                key={r.id}
                type="button"
                onClick={() => navigate(`/notice/${r.id}`)}
                className={
                  idx === 0
                    ? "w-full text-left bg-[#d97757]/5 border border-[#d97757]/20 rounded-2xl p-4 flex gap-4 outline-none focus-visible:ring-2 focus-visible:ring-[#d97757] hover:bg-[#d97757]/10 transition-colors"
                    : "w-full text-left bg-white border border-[#e8e6dc] rounded-2xl p-4 flex gap-4 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-[#6a9bcc] hover:border-[#6a9bcc]/30 transition-colors"
                }
              >
                <div
                  className={
                    idx === 0
                      ? "mt-0.5 text-[#d97757] bg-white rounded-full p-2 shadow-sm h-fit border border-[#d97757]/10 shrink-0"
                      : "mt-0.5 text-[#788c5d] bg-[#788c5d]/10 rounded-full p-2 h-fit shrink-0"
                  }
                >
                  {idx === 0 ? <BellRing size={18} aria-hidden="true" /> : <CheckCircle2 size={18} aria-hidden="true" />}
                </div>
                <div>
                  <h3 className={idx === 0 ? "text-[15px] font-semibold text-[#d97757] font-heading" : "text-[15px] font-semibold text-[#141413] font-heading"}>
                    {r.title}
                  </h3>
                  <p className={idx === 0 ? "text-[13px] text-[#d97757]/80 mt-1.5 leading-relaxed font-serif" : "text-[13px] text-[#b0aea5] mt-1 tabular-nums"}>
                    {r.summary || r.publishedAt || ""}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* Latest News */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[18px] font-semibold text-[#141413] font-heading">最新资讯</h2>
            <button type="button" className="text-[13px] text-[#b0aea5] hover:text-[#6a9bcc] flex items-center outline-none focus-visible:ring-2 focus-visible:ring-[#6a9bcc] rounded-md px-1 transition-colors">
              查看全部 <ArrowRight size={14} className="ml-0.5" aria-hidden="true" />
            </button>
          </div>
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-[#e8e6dc]/50 space-y-4">
            {news.slice(0, 3).map((n) => (
              <button
                type="button"
                key={n.id}
                onClick={() => navigate(`/notice/${n.id}`)}
                className="w-full flex justify-between items-center group cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-[#6a9bcc] rounded-sm py-0.5"
              >
                <div className="flex items-center gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#e8e6dc] group-hover:bg-[#6a9bcc] transition-colors shrink-0"></div>
                  <span className="text-[14px] text-[#141413] group-hover:text-[#6a9bcc] transition-colors line-clamp-1 font-serif">
                    {n.title}
                  </span>
                </div>
                <span className="text-[12px] text-[#b0aea5] shrink-0 ml-3 tabular-nums">{n.publishedAt || ""}</span>
              </button>
            ))}
          </div>
        </section>

      </div>
    </div>
  );
}
