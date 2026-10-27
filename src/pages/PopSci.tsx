import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { PlayCircle, ChevronRight, Eye, ThumbsUp, Heart, Bookmark, BookmarkCheck } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { cn } from "@/components/Layout";
import { listPopSci, type PopSciItem, type PopSciType } from "@/data/popsciCatalog";
import { usePopSciState } from "@/hooks/usePopSciState";
import { AVATAR_WEIGHT, AVATAR_DIABETES, AVATAR_GOUT } from "@/utils/imageUtils";

const TABS = ["科普文章", "科普视频", "康复故事"];

const STORIES = [
  {
    id: 1,
    title: "中医减重半年的蜕变：从156斤到118斤",
    author: "李女士",
    image: AVATAR_WEIGHT,
  },
  {
    id: 2,
    title: "告别10年糖尿病困扰，中医调理重塑健康",
    author: "陈先生",
    image: AVATAR_DIABETES,
  },
  {
    id: 3,
    title: "痛风5年反复发作，中医治本后的新生活",
    author: "王先生",
    image: AVATAR_GOUT,
  },
];

export default function PopSci() {
  const [activeTab, setActiveTab] = useState(TABS[0]);
  const navigate = useNavigate();
  const { isLiked, isSaved, toggleLiked, toggleSaved } = usePopSciState();

  const type: PopSciType = activeTab === "科普视频" ? "video" : "article";
  const items = useMemo(() => listPopSci(type), [type]);

  const goDetail = (item: PopSciItem) => {
    navigate(`/popsci/${item.type}/${item.id}`);
  };

  return (
    <div className="flex flex-col h-full bg-[#FAF7F2] traditional-texture-bg">
      {/* Header */}
      <header className="pt-10 pb-4 px-5 bg-[#FAF7F2] shrink-0 sticky top-0 z-10">
        <h1 className="text-[28px] font-semibold text-[#3D3226] tracking-tight font-heading">有医说医</h1>
        <p className="text-[15px] text-[#B5A898] mt-1 font-serif">你的专业健康科普空间</p>

        <div className="chinese-ornament mt-3 mb-1" />

        {/* Tabs */}
        <div className="flex space-x-8 mt-8 border-b border-[#E8E0D5]">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "pb-3 text-[16px] transition-colors relative outline-none focus-visible:ring-2 focus-visible:ring-[#8B5E3C] rounded-t-sm",
                activeTab === tab ? "text-[#8B5E3C] font-medium" : "text-[#B5A898] hover:text-[#3D3226]"
              )}
            >
              {tab}
              {activeTab === tab && (
                <motion.div
                  layoutId="activeTab"
                  className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#8B5E3C]"
                />
              )}
            </button>
          ))}
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-5 py-6 space-y-6 pb-24">
        <AnimatePresence mode="popLayout">
          {activeTab === "科普文章" && (
            <motion.div
              key="articles"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="space-y-5"
            >
              {items.map((item) => {
                const liked = isLiked(item.type, item.id);
                const saved = isSaved(item.type, item.id);
                const likeCount = (item.likes || 0) + (liked ? 1 : 0);
                return (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => goDetail(item)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        goDetail(item);
                      }
                    }}
                    className="w-full text-left bg-white rounded-2xl p-4 shadow-sm border border-[#E8E0D5]/50 active:scale-[0.98] transition-transform outline-none focus-visible:ring-2 focus-visible:ring-[#8B5E3C] hover:shadow-md"
                  >
                  <div className="flex gap-5">
                    <div className="flex-1 space-y-2.5 flex flex-col justify-between">
                      <div>
                        <h3 className="font-medium text-[#3D3226] text-[17px] leading-snug line-clamp-2 font-heading [text-wrap:balance]">{item.title}</h3>
                        <p className="text-[14px] text-[#B5A898] line-clamp-2 leading-relaxed mt-1.5">{item.summary}</p>
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4 text-[12px] text-[#B5A898] tabular-nums">
                          <span className="flex items-center gap-1.5"><Eye size={14} aria-hidden="true" /> {new Intl.NumberFormat('zh-CN', { notation: 'compact' }).format(item.views || 0)}</span>
                          <span className="flex items-center gap-1.5"><ThumbsUp size={14} aria-hidden="true" /> {new Intl.NumberFormat('zh-CN').format(likeCount)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              toggleSaved(item.type, item.id);
                            }}
                            className={cn(
                              "w-8 h-8 rounded-full bg-[#FAF7F2] border border-[#E8E0D5]/60 flex items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-[#8B5E3C] transition-colors",
                              saved ? "text-[#8B5E3C]" : "text-[#B5A898] hover:text-[#8B5E3C]"
                            )}
                            aria-label="收藏"
                          >
                            {saved ? <BookmarkCheck size={16} aria-hidden="true" /> : <Bookmark size={16} aria-hidden="true" />}
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              toggleLiked(item.type, item.id);
                            }}
                            className={cn(
                              "w-8 h-8 rounded-full bg-[#FAF7F2] border border-[#E8E0D5]/60 flex items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-[#8B5E3C] transition-colors",
                              liked ? "text-[#C57B57]" : "text-[#B5A898] hover:text-[#C57B57]"
                            )}
                            aria-label="点赞"
                          >
                            <Heart size={16} aria-hidden="true" className={liked ? "fill-current" : ""} />
                          </button>
                        </div>
                      </div>
                    </div>
                    <img src={item.coverUrl} alt="" width={104} height={104} className="w-[104px] h-[104px] object-cover rounded-xl shrink-0 border border-[#E8E0D5]/30" />
                  </div>
                  </div>
                );
              })}
            </motion.div>
          )}

          {activeTab === "科普视频" && (
            <motion.div
              key="videos"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="space-y-5"
            >
              {items.map((item) => {
                const liked = isLiked(item.type, item.id);
                const saved = isSaved(item.type, item.id);
                const likeCount = (item.likes || 0) + (liked ? 1 : 0);
                return (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => goDetail(item)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        goDetail(item);
                      }
                    }}
                    className="w-full text-left bg-white rounded-[20px] overflow-hidden shadow-sm border border-[#E8E0D5]/50 active:scale-[0.98] transition-transform outline-none focus-visible:ring-2 focus-visible:ring-[#8B5E3C] hover:shadow-md"
                  >
                  <div className="relative">
                    <img src={item.coverUrl} alt="" width={640} height={192} className="w-full h-48 object-cover" />
                    <div className="absolute inset-0 bg-[#3D3226]/30 flex items-center justify-center group-hover:bg-[#3D3226]/20 transition-colors">
                      <div className="w-14 h-14 bg-white/90 backdrop-blur-md rounded-full flex items-center justify-center shadow-lg">
                        <PlayCircle className="text-[#8B5E3C] ml-1" size={32} aria-hidden="true" />
                      </div>
                    </div>
                    {"duration" in item && item.duration ? (
                      <span className="absolute bottom-3 right-3 bg-[#3D3226]/70 text-white text-[12px] px-2 py-1 rounded-md backdrop-blur-sm font-medium tabular-nums">
                        {item.duration}
                      </span>
                    ) : null}
                  </div>
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="font-medium text-[#3D3226] text-[16px] line-clamp-1 font-heading">{item.title}</h3>
                        <div className="flex items-center gap-4 text-[12px] text-[#B5A898] mt-2 tabular-nums">
                          <span className="flex items-center gap-1.5"><Eye size={14} aria-hidden="true" /> {new Intl.NumberFormat('zh-CN', { notation: 'compact' }).format(item.views || 0)}</span>
                          <span className="flex items-center gap-1.5"><ThumbsUp size={14} aria-hidden="true" /> {new Intl.NumberFormat('zh-CN').format(likeCount)}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            toggleSaved(item.type, item.id);
                          }}
                          className={cn(
                            "w-8 h-8 rounded-full bg-[#FAF7F2] border border-[#E8E0D5]/60 flex items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-[#8B5E3C] transition-colors",
                            saved ? "text-[#8B5E3C]" : "text-[#B5A898] hover:text-[#8B5E3C]"
                          )}
                          aria-label="收藏"
                        >
                          {saved ? <BookmarkCheck size={16} aria-hidden="true" /> : <Bookmark size={16} aria-hidden="true" />}
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            toggleLiked(item.type, item.id);
                          }}
                          className={cn(
                            "w-8 h-8 rounded-full bg-[#FAF7F2] border border-[#E8E0D5]/60 flex items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-[#8B5E3C] transition-colors",
                            liked ? "text-[#C57B57]" : "text-[#B5A898] hover:text-[#C57B57]"
                          )}
                          aria-label="点赞"
                        >
                          <Heart size={16} aria-hidden="true" className={liked ? "fill-current" : ""} />
                        </button>
                      </div>
                    </div>
                  </div>
                  </div>
                );
              })}
            </motion.div>
          )}

          {activeTab === "康复故事" && (
            <motion.div
              key="stories"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="space-y-4"
            >
              {STORIES.map((item) => (
                <button type="button" key={item.id} className="w-full text-left bg-white rounded-[20px] p-5 shadow-sm border border-[#E8E0D5]/50 flex items-center justify-between active:scale-[0.98] transition-transform outline-none focus-visible:ring-2 focus-visible:ring-[#8B5E3C] hover:shadow-md group">
                  <div className="flex items-center gap-5">
                    <img src={item.image} alt="" width={64} height={64} className="w-16 h-16 object-cover rounded-full border-2 border-[#FAF7F2]" />
                    <div>
                      <h3 className="font-medium text-[#3D3226] text-[16px] font-heading">{item.title}</h3>
                      <p className="text-[14px] text-[#B5A898] mt-1">讲述人：{item.author}</p>
                    </div>
                  </div>
                  <div className="w-8 h-8 rounded-full bg-[#FAF7F2] flex items-center justify-center group-hover:bg-[#8B5E3C]/10 transition-colors">
                    <ChevronRight className="text-[#B5A898] group-hover:text-[#8B5E3C] transition-colors" size={20} aria-hidden="true" />
                  </div>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
