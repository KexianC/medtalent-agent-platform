import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getNoticeById } from "@/data/noticeCatalog";

export default function NoticeDetail() {
  const navigate = useNavigate();
  const params = useParams();
  const item = useMemo(() => getNoticeById(params.id || ""), [params.id]);

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
          <div className="min-w-0">
            <h1 className="text-[18px] font-semibold text-[#141413] tracking-tight font-heading line-clamp-2">
              {item ? item.title : "内容不存在"}
            </h1>
            <p className="text-[12px] text-[#b0aea5] mt-1 font-serif">{item?.publishedAt || ""}</p>
          </div>
        </div>
      </header>

      <div className="p-5 space-y-6">
        {!item ? (
          <div className="bg-white rounded-2xl p-5 border border-[#e8e6dc]/60 shadow-sm">
            <p className="text-[14px] text-[#141413] font-serif leading-relaxed">未找到该内容。</p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl p-5 border border-[#e8e6dc]/60 shadow-sm">
            <div className="prose prose-sm max-w-none prose-p:my-2 prose-headings:my-3 prose-ul:my-2 prose-ol:my-2 prose-li:my-1 prose-strong:text-[#141413] prose-a:text-[#6a9bcc]">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.contentMarkdown}</ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

