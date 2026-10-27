import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, BookmarkX, ChevronRight, Heart } from "lucide-react";
import { getPopSciItem, type PopSciType } from "@/data/popsciCatalog";
import { usePopSciState } from "@/hooks/usePopSciState";
import { cn } from "@/components/Layout";

function parseKey(key: string): { type: PopSciType; id: string } | null {
  const [type, ...rest] = key.split(":");
  const id = rest.join(":");
  if (type !== "article" && type !== "video") return null;
  if (!id) return null;
  return { type, id };
}

export default function MeSaved() {
  const navigate = useNavigate();
  const { savedKeys, toggleSaved, isLiked } = usePopSciState();

  const items = useMemo(() => {
    return savedKeys
      .map((k) => {
        const parsed = parseKey(k);
        if (!parsed) return null;
        return getPopSciItem(parsed.type, parsed.id) || null;
      })
      .filter(Boolean);
  }, [savedKeys]);

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
            <h1 className="text-[20px] font-semibold text-[#141413] tracking-tight font-heading">我的收藏</h1>
            <p className="text-[13px] text-[#b0aea5] mt-1 font-serif">{items.length} 条内容</p>
          </div>
        </div>
      </header>

      <div className="p-5 space-y-4">
        {items.length === 0 ? (
          <div className="bg-white rounded-2xl p-6 border border-[#e8e6dc]/60 shadow-sm text-center">
            <BookmarkX size={22} className="mx-auto text-[#b0aea5]" aria-hidden="true" />
            <p className="mt-3 text-[14px] text-[#141413] font-medium">暂无收藏</p>
            <p className="mt-1 text-[13px] text-[#b0aea5] font-serif">去科普页面收藏文章或视频吧</p>
            <button
              type="button"
              onClick={() => navigate("/")}
              className="mt-4 bg-[#6a9bcc] text-white px-5 py-2.5 rounded-full text-[14px] font-medium shadow-sm hover:bg-[#5b8cbf] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#6a9bcc]"
            >
              去科普
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {items.map((item) => {
              if (!item) return null;
              const liked = isLiked(item.type, item.id);
              return (
                <div
                  key={`${item.type}:${item.id}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/popsci/${item.type}/${item.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate(`/popsci/${item.type}/${item.id}`);
                    }
                  }}
                  className="w-full text-left bg-white rounded-2xl p-4 shadow-sm border border-[#e8e6dc]/50 active:scale-[0.99] transition-transform outline-none focus-visible:ring-2 focus-visible:ring-[#6a9bcc] hover:shadow-md"
                >
                  <div className="flex items-center gap-4">
                    <img
                      src={item.coverUrl}
                      alt=""
                      className="w-[72px] h-[72px] object-cover rounded-xl border border-[#e8e6dc]/30 shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-[15px] text-[#141413] font-semibold line-clamp-1 font-heading">{item.title}</h3>
                        <ChevronRight size={18} className="text-[#b0aea5] shrink-0" aria-hidden="true" />
                      </div>
                      <p className="mt-1 text-[13px] text-[#b0aea5] line-clamp-2 font-serif">{item.summary}</p>
                      <div className="mt-2 flex items-center justify-between">
                        <div className="flex items-center gap-2 text-[12px] text-[#b0aea5]">
                          <span className="bg-[#faf9f5] border border-[#e8e6dc]/60 px-2 py-0.5 rounded-full font-serif">
                            {item.type === "article" ? "文章" : "视频"}
                          </span>
                          {liked ? (
                            <span className="flex items-center gap-1 text-[#d97757]">
                              <Heart size={14} className="fill-current" aria-hidden="true" />
                              已点赞
                            </span>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            toggleSaved(item.type, item.id);
                          }}
                          className={cn(
                            "text-[12px] px-3 py-1.5 rounded-full border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#6a9bcc]",
                            "border-[#e8e6dc]/60 text-[#b0aea5] hover:text-[#6a9bcc] hover:border-[#6a9bcc]/30"
                          )}
                        >
                          取消收藏
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
