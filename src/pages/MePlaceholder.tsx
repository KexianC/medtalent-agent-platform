import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

export default function MePlaceholder(props: { title: string; description: string }) {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col h-full bg-[#faf9f5] overflow-y-auto">
      <header className="pt-10 pb-4 px-5 bg-[#faf9f5] shrink-0 border-b border-[#e8e6dc]/60 z-10">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="w-9 h-9 rounded-full bg-white border border-[#e8e6dc] shadow-sm flex items-center justify-center text-[#b0aea5] hover:text-[#6a9bcc] hover:border-[#6a9bcc]/30 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#6a9bcc]"
            aria-label="返回"
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
          <div>
            <h1 className="text-[20px] font-semibold text-[#141413] tracking-tight font-heading">{props.title}</h1>
            <p className="text-[13px] text-[#b0aea5] mt-1 font-serif">功能完善中</p>
          </div>
        </div>
      </header>

      <div className="p-5">
        <div className="bg-white rounded-2xl p-6 border border-[#e8e6dc]/60 shadow-sm">
          <p className="text-[14px] text-[#141413] font-serif leading-relaxed">{props.description}</p>
        </div>
      </div>
    </div>
  );
}

