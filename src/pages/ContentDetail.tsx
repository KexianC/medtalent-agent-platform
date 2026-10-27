import { useMemo } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { ArrowLeft, ExternalLink, LayoutGrid } from "lucide-react";
import { getContentById } from "@/data/contentCatalog";
import { cn } from "@/components/Layout";

const typeLabel: Record<string, string> = {
  article: "科普文章",
  video: "科普视频",
  service: "服务",
  product: "商品",
};

export default function ContentDetail() {
  const navigate = useNavigate();
  const params = useParams();
  const item = useMemo(() => getContentById(params.id || ""), [params.id]);

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
            <h1 className="text-[20px] font-semibold text-[#141413] tracking-tight font-heading line-clamp-1">
              {item ? item.title : "内容不存在"}
            </h1>
            <p className="text-[13px] text-[#b0aea5] mt-1 font-serif">
              {item ? typeLabel[item.type] || "内容" : "请返回并选择其他推荐"}
            </p>
          </div>
        </div>
      </header>

      <div className="p-5 space-y-6">
        {!item ? (
          <div className="bg-white rounded-2xl p-5 border border-[#e8e6dc]/60 shadow-sm">
            <p className="text-[14px] text-[#141413] font-serif leading-relaxed">
              未找到该内容。可能已下线或链接无效。
            </p>
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="mt-4 bg-[#6a9bcc] text-white px-5 py-2.5 rounded-full text-[14px] font-medium inline-flex items-center gap-2 shadow-sm hover:bg-[#5b8cbf] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#6a9bcc]"
            >
              返回
              <ArrowLeft size={16} className="rotate-180" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <>
            <div className="bg-white rounded-2xl p-5 border border-[#e8e6dc]/60 shadow-sm">
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-[#6a9bcc] bg-[#6a9bcc]/10 px-2.5 py-1 rounded-full font-medium">
                  {typeLabel[item.type] || "内容"}
                </span>
                <span className="text-[12px] text-[#b0aea5] tabular-nums">
                  #{item.id}
                </span>
              </div>
              <p className="text-[14px] text-[#141413] mt-4 leading-relaxed font-serif">
                {item.summary}
              </p>
              <div className="flex flex-wrap gap-2 mt-4">
                {item.keywords.slice(0, 8).map((kw) => (
                  <span
                    key={kw}
                    className="text-[12px] text-[#b0aea5] bg-[#faf9f5] border border-[#e8e6dc]/60 px-2.5 py-1 rounded-full font-serif"
                  >
                    {kw}
                  </span>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Link
                to="/service"
                className={cn(
                  "w-full bg-white border border-[#e8e6dc]/60 rounded-2xl p-4 shadow-sm hover:border-[#6a9bcc]/30 hover:bg-[#6a9bcc]/5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#6a9bcc]",
                  "flex items-center justify-between"
                )}
              >
                <div>
                  <p className="text-[14px] text-[#141413] font-semibold font-heading">相关服务</p>
                  <p className="text-[12px] text-[#b0aea5] mt-1 font-serif">查看服务与商品</p>
                </div>
                <div className="w-9 h-9 rounded-full bg-[#6a9bcc]/10 flex items-center justify-center text-[#6a9bcc]">
                  <LayoutGrid size={18} aria-hidden="true" />
                </div>
              </Link>

              {item.sourceUrl ? (
                <a
                  href={item.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="w-full bg-white border border-[#e8e6dc]/60 rounded-2xl p-4 shadow-sm hover:border-[#6a9bcc]/30 hover:bg-[#6a9bcc]/5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#6a9bcc] flex items-center justify-between"
                >
                  <div>
                    <p className="text-[14px] text-[#141413] font-semibold font-heading">原始链接</p>
                    <p className="text-[12px] text-[#b0aea5] mt-1 font-serif">在新窗口打开</p>
                  </div>
                  <div className="w-9 h-9 rounded-full bg-[#6a9bcc]/10 flex items-center justify-center text-[#6a9bcc]">
                    <ExternalLink size={18} aria-hidden="true" />
                  </div>
                </a>
              ) : (
                <div className="w-full bg-white border border-[#e8e6dc]/60 rounded-2xl p-4 shadow-sm opacity-70 flex items-center justify-between">
                  <div>
                    <p className="text-[14px] text-[#141413] font-semibold font-heading">内容来源</p>
                    <p className="text-[12px] text-[#b0aea5] mt-1 font-serif">暂无外链</p>
                  </div>
                  <div className="w-9 h-9 rounded-full bg-[#e8e6dc]/60 flex items-center justify-center text-[#b0aea5]">
                    <ExternalLink size={18} aria-hidden="true" />
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

