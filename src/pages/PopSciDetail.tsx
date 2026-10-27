import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Bookmark, BookmarkCheck, Heart, ExternalLink, PlayCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getPopSciItem, type PopSciType } from "@/data/popsciCatalog";
import { cn } from "@/components/Layout";
import { usePopSciState } from "@/hooks/usePopSciState";

const typeLabel: Record<PopSciType, string> = {
  article: "科普文章",
  video: "科普视频",
};

export default function PopSciDetail(props: { type: PopSciType }) {
  const navigate = useNavigate();
  const params = useParams();
  const { isLiked, isSaved, toggleLiked, toggleSaved } = usePopSciState();
  const item = useMemo(() => getPopSciItem(props.type, params.id || ""), [params.id, props.type]);

  const liked = item ? isLiked(item.type, item.id) : false;
  const saved = item ? isSaved(item.type, item.id) : false;

  return (
    <div className="flex flex-col h-full bg-[#faf9f5] overflow-y-auto">
      <header className="pt-10 pb-4 px-5 bg-[#faf9f5] shrink-0 border-b border-[#e8e6dc]/60 z-10">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="w-9 h-9 rounded-full bg-white border border-[#e8e6dc] shadow-sm flex items-center justify-center text-[#b0aea5] hover:text-[#6a9bcc] hover:border-[#6a9bcc]/30 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#6a9bcc]"
              aria-label="返回"
            >
              <ArrowLeft size={18} aria-hidden="true" />
            </button>
            <div className="min-w-0">
              <h1 className="text-[16px] font-semibold text-[#141413] tracking-tight font-heading line-clamp-2">
                {item ? item.title : "内容不存在"}
              </h1>
              <p className="text-[12px] text-[#b0aea5] mt-1 font-serif">
                {item ? typeLabel[item.type] : "请返回并选择其他内容"}
              </p>
            </div>
          </div>

          {item ? (
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => toggleSaved(item.type, item.id)}
                className={cn(
                  "w-9 h-9 rounded-full bg-white border shadow-sm flex items-center justify-center transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#6a9bcc]",
                  saved ? "text-[#6a9bcc] border-[#6a9bcc]/40" : "text-[#b0aea5] border-[#e8e6dc] hover:text-[#6a9bcc] hover:border-[#6a9bcc]/30"
                )}
                aria-label="收藏"
              >
                {saved ? <BookmarkCheck size={18} aria-hidden="true" /> : <Bookmark size={18} aria-hidden="true" />}
              </button>
              <button
                type="button"
                onClick={() => toggleLiked(item.type, item.id)}
                className={cn(
                  "w-9 h-9 rounded-full bg-white border shadow-sm flex items-center justify-center transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#6a9bcc]",
                  liked ? "text-[#d97757] border-[#d97757]/40" : "text-[#b0aea5] border-[#e8e6dc] hover:text-[#d97757] hover:border-[#d97757]/30"
                )}
                aria-label="点赞"
              >
                <Heart size={18} aria-hidden="true" className={liked ? "fill-current" : ""} />
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <div className="p-5 space-y-6">
        {!item ? (
          <div className="bg-white rounded-2xl p-5 border border-[#e8e6dc]/60 shadow-sm">
            <p className="text-[14px] text-[#141413] font-serif leading-relaxed">未找到该内容。</p>
            <Link
              to="/"
              className="mt-4 inline-flex bg-[#6a9bcc] text-white px-5 py-2.5 rounded-full text-[14px] font-medium shadow-sm hover:bg-[#5b8cbf] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#6a9bcc]"
            >
              返回科普
            </Link>
          </div>
        ) : (
          <>
            <div className="bg-white rounded-2xl overflow-hidden border border-[#e8e6dc]/60 shadow-sm">
              <div className="relative">
                <img src={item.coverUrl} alt="" className="w-full h-48 object-cover" />
                {item.type === "video" ? (
                  <div className="absolute inset-0 bg-[#141413]/25 flex items-center justify-center">
                    <div className="w-14 h-14 bg-white/90 backdrop-blur-md rounded-full flex items-center justify-center shadow-lg">
                      <PlayCircle className="text-[#6a9bcc] ml-1" size={32} aria-hidden="true" />
                    </div>
                  </div>
                ) : null}
                {"duration" in item && item.duration ? (
                  <span className="absolute bottom-3 right-3 bg-[#141413]/70 text-white text-[12px] px-2 py-1 rounded-md backdrop-blur-sm font-medium tabular-nums">
                    {item.duration}
                  </span>
                ) : null}
              </div>
              <div className="p-5">
                <div className="flex flex-wrap gap-2">
                  {item.tags.slice(0, 6).map((tag) => (
                    <span
                      key={tag}
                      className="text-[12px] text-[#6a9bcc] bg-[#6a9bcc]/10 px-2.5 py-1 rounded-full font-medium"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
                <p className="text-[14px] text-[#141413] mt-4 leading-relaxed font-serif">{item.summary}</p>

                <div className="mt-4 flex items-center justify-between text-[12px] text-[#b0aea5] tabular-nums">
                  <span className="font-serif">{item.author ? `作者：${item.author}` : ""}</span>
                  <span className="font-serif">{item.publishedAt || ""}</span>
                </div>
              </div>
            </div>

            {item.type === "article" ? (
              <div className="bg-white rounded-2xl p-5 border border-[#e8e6dc]/60 shadow-sm">
                <div className="prose prose-sm max-w-none prose-p:my-2 prose-headings:my-3 prose-ul:my-2 prose-ol:my-2 prose-li:my-1 prose-strong:text-[#141413] prose-a:text-[#6a9bcc]">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.bodyMarkdown}</ReactMarkdown>
                </div>
              </div>
            ) : (
              <div className="bg-white rounded-2xl p-5 border border-[#e8e6dc]/60 shadow-sm">
                <a
                  href={item.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="w-full bg-[#6a9bcc] text-white px-5 py-3 rounded-full text-[14px] font-semibold flex items-center justify-center gap-2 hover:bg-[#5b8cbf] transition-colors shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#6a9bcc]"
                >
                  打开视频来源 <ExternalLink size={16} aria-hidden="true" />
                </a>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

