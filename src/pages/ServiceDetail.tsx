import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { getServiceBySlug } from "@/data/serviceCatalog";

export default function ServiceDetail() {
  const navigate = useNavigate();
  const params = useParams();
  const item = useMemo(() => getServiceBySlug(params.slug || ""), [params.slug]);

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
            <h1 className="text-[20px] font-semibold text-[#141413] tracking-tight font-heading">
              {item ? item.title : "服务不存在"}
            </h1>
            <p className="text-[13px] text-[#b0aea5] mt-1 font-serif">{item ? "服务详情" : "请返回选择其他服务"}</p>
          </div>
        </div>
      </header>

      <div className="p-5 space-y-6">
        {!item ? (
          <div className="bg-white rounded-2xl p-5 border border-[#e8e6dc]/60 shadow-sm">
            <p className="text-[14px] text-[#141413] font-serif leading-relaxed">未找到该服务。</p>
            <button
              type="button"
              onClick={() => navigate("/service")}
              className="mt-4 bg-[#6a9bcc] text-white px-5 py-2.5 rounded-full text-[14px] font-medium inline-flex items-center gap-2 shadow-sm hover:bg-[#5b8cbf] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#6a9bcc]"
            >
              返回服务页
              <ArrowLeft size={16} className="rotate-180" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <>
            <div className="bg-white rounded-2xl p-5 border border-[#e8e6dc]/60 shadow-sm">
              <p className="text-[14px] text-[#141413] leading-relaxed font-serif">{item.desc}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {item.highlights.map((h) => (
                  <span
                    key={h}
                    className="text-[12px] text-[#6a9bcc] bg-[#6a9bcc]/10 px-2.5 py-1 rounded-full font-medium"
                  >
                    {h}
                  </span>
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={() => navigate(item.ctaUrl)}
              className="w-full bg-[#6a9bcc] text-white px-5 py-3 rounded-full text-[14px] font-semibold flex items-center justify-center gap-2 hover:bg-[#5b8cbf] transition-colors shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#6a9bcc]"
            >
              {item.ctaLabel} <ExternalLink size={16} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

