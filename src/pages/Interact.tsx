import { useState, useRef, useEffect } from "react";
import { Send, Camera, Sparkles, ChevronRight, Bot, User, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useNavigate } from "react-router-dom";
import { cn } from "@/components/Layout";
import { createWorker } from 'tesseract.js';
import { getRecommendations, type ContentItem, type ContentType } from "@/data/contentCatalog";

const QUICK_QUESTIONS = [
  "糖尿病饮食怎么控制？",
  "尿酸高了怎么办？",
  "中医真的能减重吗？",
  "甲状腺结节怎么调理？"
];

interface Message {
  id: string;
  sender: "user" | "ai";
  content: string;
  isAction?: boolean;
  imageUrl?: string;
  hiddenText?: string;
  isImagePlaceholder?: boolean;
  recommendations?: ContentItem[];
}

const INITIAL_MESSAGES: Message[] = [
  {
    id: "1",
    sender: "ai",
    content: "你好！我是龚文波医生的智能助手。我以传统经典中医理论为指导，结合现代医学知识，擅长解答内分泌代谢疾病（糖尿病、高脂血症、痛风、甲状腺等）及多系统疾病的调理问题。以脉证结合、三分调七分治为核心理念，帮您快速找到健康方向。也欢迎发送检查报告，我帮您解读。",
  }
];

export default function Interact() {
  const [messages, setMessages] = useState<Message[]>(() => {
    const saved = localStorage.getItem("chat_history");
    if (saved) {
      try {
        return JSON.parse(saved) as Message[];
      } catch (e) {
        console.error("Failed to parse chat history", e);
      }
    }
    return INITIAL_MESSAGES;
  });
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [isOcrProcessing, setIsOcrProcessing] = useState(false);
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const typeLabel: Record<ContentType, string> = {
    article: "文章",
    video: "视频",
    service: "服务",
    product: "商品",
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  useEffect(() => {
    if (!isTyping && !isOcrProcessing) {
      const messagesToSave = messages.map(msg => {
        if (msg.imageUrl || msg.hiddenText) {
          const { imageUrl: _imageUrl, ...rest } = msg;
          void _imageUrl;
          return { ...rest, isImagePlaceholder: true };
        }
        return msg;
      });
      localStorage.setItem("chat_history", JSON.stringify(messagesToSave));
    }
  }, [messages, isTyping, isOcrProcessing]);

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const imageUrl = URL.createObjectURL(file);
    setIsOcrProcessing(true);

    try {
      const worker = await createWorker(['chi_sim', 'eng']);
      const ret = await worker.recognize(file);
      let text = ret.data.text;
      
      text = text.replace(/\n\s*\n/g, '\n').trim();
      
      if (text) {
        const hiddenText = `请帮我解读这份检查报告：\n${text}`;
        const newUserMsg: Message = { 
          id: Date.now().toString(), 
          sender: "user", 
          content: "这是一份检查报告图片",
          imageUrl,
          hiddenText
        };
        
        const aiMessageId = (Date.now() + 1).toString();
        setMessages(prev => [...prev, newUserMsg, { id: aiMessageId, sender: "ai", content: "", isAction: false }]);
        setIsTyping(true);

        await fetchAIResponse(newUserMsg, aiMessageId);
      } else {
        setMessages(prev => [...prev, {
          id: Date.now().toString(),
          sender: "ai",
          content: "抱歉，我未能从图片中识别出文字，请尝试重新拍摄或上传更清晰的图片。"
        }]);
        URL.revokeObjectURL(imageUrl);
      }
      await worker.terminate();
    } catch (error) {
      console.error("OCR Error:", error);
      setMessages(prev => [...prev, {
        id: Date.now().toString(),
        sender: "ai",
        content: "抱歉，图片识别过程中发生了错误，请稍后再试。"
      }]);
      URL.revokeObjectURL(imageUrl);
    } finally {
      setIsOcrProcessing(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const fetchAIResponse = async (newUserMsg: Message, aiMessageId: string) => {
    try {
      const history = messages
        .filter((message) => message.content.trim())
        .slice(-12)
        .map((message) => ({
          role: message.sender === "user" ? "user" : "assistant",
          content: message.hiddenText || message.content,
        }));

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          doctorSlug: "gong-wenbo",
          message: newUserMsg.hiddenText || newUserMsg.content,
          history,
        }),
      });

      const data = await response.json() as { reply?: string; error?: string };
      if (!response.ok || !data.reply) throw new Error(data.error || "智能问答服务暂时不可用，请稍后再试。");
      const query = newUserMsg.hiddenText || newUserMsg.content;
      const recommendations = getRecommendations(query, 2);
      setMessages((current) => current.map((message) =>
        message.id === aiMessageId ? { ...message, content: data.reply, recommendations } : message
      ));
    } catch (error) {
      console.error("DeepSeek API Error:", error);
      const query = newUserMsg.hiddenText || newUserMsg.content;
      const recommendations = getRecommendations(query, 2);
      setMessages((current) => current.map((message) =>
        message.id === aiMessageId
          ? { ...message, content: error instanceof Error ? error.message : "智能问答服务暂时不可用，请稍后再试。", recommendations }
          : message
      ));
    } finally {
      setIsTyping(false);
    }
  };

  const handleSend = async (text: string) => {
    if (!text.trim()) return;
    
    const newUserMsg: Message = { id: Date.now().toString(), sender: "user", content: text };
    const aiMessageId = (Date.now() + 1).toString();
    
    setMessages(prev => [...prev, newUserMsg, { id: aiMessageId, sender: "ai", content: "", isAction: false }]);
    setInput("");
    setIsTyping(true);

    await fetchAIResponse(newUserMsg, aiMessageId);
  };

  return (
    <div className="flex flex-col h-full bg-[#FAF7F2]">
      {/* Header */}
      <header className="pt-10 pb-4 px-5 bg-[#FAF7F2] shrink-0 border-b border-[#E8E0D5]/60 z-10 chinese-pattern-border relative">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[28px] font-semibold text-[#3D3226] tracking-tight font-heading">医心医意</h1>
            <p className="text-[13px] text-[#B5A898] mt-1 flex items-center gap-1.5 font-serif">
              <Sparkles size={14} className="text-[#8B5E3C]" aria-hidden="true" />
              龚文波医生智能助手
            </p>
          </div>
          <div className="bg-[#8B5E3C]/10 text-[#8B5E3C] text-[12px] px-3 py-1.5 rounded-full font-medium">Medtalent健康科普大模型</div>
        </div>

        {/* Quick Questions */}
        <div className="flex overflow-x-auto gap-2 mt-6 pb-1 hide-scrollbar">
          {QUICK_QUESTIONS.map((q, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => handleSend(q)}
              className="whitespace-nowrap bg-white border border-[#E8E0D5] text-[#3D3226] text-[14px] px-4 py-2 rounded-full hover:bg-[#8B5E3C]/5 hover:border-[#8B5E3C]/30 hover:text-[#8B5E3C] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#8B5E3C] shadow-sm"
            >
              {q}
            </button>
          ))}
        </div>
      </header>

      {/* Chat Area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-6 space-y-6 pb-24 scroll-smooth">
        <AnimatePresence>
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              className={cn(
                "flex gap-3 max-w-[85%]",
                msg.sender === "user" ? "ml-auto flex-row-reverse" : "mr-auto"
              )}
            >
              <div className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center shrink-0 shadow-sm border",
                msg.sender === "user" ? "bg-[#8B5E3C] text-white border-transparent" : "bg-white text-[#8B5E3C] border-[#E8E0D5]/60"
              )}>
                {msg.sender === "user" ? <User size={16} aria-hidden="true" /> : <Bot size={18} aria-hidden="true" />}
              </div>
              
              <div className="space-y-2">
                {msg.imageUrl && (
                  <div className="mb-2">
                    <img 
                      src={msg.imageUrl} 
                      alt="Uploaded report" 
                      className="max-w-[200px] rounded-lg shadow-sm border border-white/20"
                    />
                  </div>
                )}
                {msg.isImagePlaceholder && !msg.imageUrl && (
                  <div className="mb-2 flex items-center justify-center bg-black/5 w-[200px] h-[100px] rounded-lg border border-[#E8E0D5]/60 shadow-sm">
                    <span className="text-[#B5A898] text-[13px] font-serif flex items-center gap-1.5">
                      <Camera size={14} aria-hidden="true" />
                      已过期的图片
                    </span>
                  </div>
                )}
                {msg.content && (
                  <div className={cn(
                    "p-4 rounded-2xl text-[15px] leading-relaxed shadow-sm",
                    msg.sender === "user" 
                      ? "bg-[#8B5E3C] text-white rounded-tr-sm" 
                      : "bg-white text-[#3D3226] rounded-tl-sm border border-[#E8E0D5]/60 font-serif"
                  )}>
                    {msg.sender === "user" ? (
                      msg.content
                    ) : (
                      <div className="prose prose-sm max-w-none prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-strong:text-[#3D3226] prose-a:text-[#8B5E3C]">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {msg.content || "..."}
                        </ReactMarkdown>
                      </div>
                    )}
                  </div>
                )}
                
                {msg.sender === "ai" && msg.recommendations?.length ? (
                  <div className="space-y-2">
                    {msg.recommendations.slice(0, 2).map((rec) => (
                      <button
                        key={rec.id}
                        type="button"
                        onClick={() => navigate(`/content/${rec.id}`)}
                        className="bg-white border border-[#E8E0D5] shadow-sm rounded-[16px] p-3 flex items-center justify-between w-full hover:border-[#8B5E3C]/40 hover:bg-[#8B5E3C]/5 transition-colors group outline-none focus-visible:ring-2 focus-visible:ring-[#8B5E3C]"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-[12px] text-[#8B5E3C] bg-[#8B5E3C]/10 px-2 py-1 rounded-full font-medium shrink-0">
                            {typeLabel[rec.type]}
                          </span>
                          <span className="text-[14px] text-[#3D3226] font-medium line-clamp-1 font-serif">
                            {rec.title}
                          </span>
                        </div>
                        <div className="w-7 h-7 rounded-full bg-[#8B5E3C]/10 flex items-center justify-center group-hover:bg-[#8B5E3C]/20 transition-colors shrink-0">
                          <ChevronRight size={16} className="text-[#8B5E3C]" aria-hidden="true" />
                        </div>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {isTyping && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex gap-3 max-w-[85%] mr-auto"
          >
            <div className="w-8 h-8 rounded-full bg-white border border-[#E8E0D5]/60 text-[#8B5E3C] flex items-center justify-center shadow-sm shrink-0">
              <Bot size={18} aria-hidden="true" />
            </div>
            <div className="bg-white p-4 rounded-2xl rounded-tl-sm shadow-sm border border-[#E8E0D5]/60 flex gap-1.5 items-center h-[46px]">
              <motion.div animate={{ scale: [1, 1.2, 1] }} transition={{ repeat: Infinity, duration: 1 }} className="w-1.5 h-1.5 bg-[#8B5E3C]/50 rounded-full" />
              <motion.div animate={{ scale: [1, 1.2, 1] }} transition={{ repeat: Infinity, duration: 1, delay: 0.2 }} className="w-1.5 h-1.5 bg-[#8B5E3C]/50 rounded-full" />
              <motion.div animate={{ scale: [1, 1.2, 1] }} transition={{ repeat: Infinity, duration: 1, delay: 0.4 }} className="w-1.5 h-1.5 bg-[#8B5E3C]/50 rounded-full" />
            </div>
          </motion.div>
        )}
      </div>

      {/* Input Area */}
      <div className="absolute bottom-0 left-0 right-0 bg-[#FAF7F2]/80 backdrop-blur-xl border-t border-[#E8E0D5]/60 p-3 pb-safe z-20">
        <div className="flex items-center gap-3 max-w-[480px] mx-auto px-2">
          <input
            type="file"
            accept="image/*"
            ref={fileInputRef}
            className="hidden"
            onChange={handleImageUpload}
          />
          <button 
            type="button" 
            onClick={() => fileInputRef.current?.click()}
            disabled={isOcrProcessing || isTyping}
            aria-label="拍照或上传图片" 
            className={cn(
              "p-2.5 text-[#B5A898] hover:text-[#8B5E3C] transition-colors shrink-0 bg-white border border-[#E8E0D5] shadow-sm hover:border-[#8B5E3C]/30 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[#8B5E3C]",
              (isOcrProcessing || isTyping) && "opacity-50 cursor-not-allowed"
            )}
          >
            {isOcrProcessing ? <Loader2 size={22} className="animate-spin" /> : <Camera size={22} aria-hidden="true" />}
          </button>
          <div className="flex-1 bg-white rounded-full flex items-center px-4 py-1.5 border border-[#E8E0D5] shadow-sm focus-within:border-[#8B5E3C] focus-within:ring-2 focus-within:ring-[#8B5E3C]/20 transition-all">
            <input
              type="text"
              value={input}
              disabled={isOcrProcessing}
              aria-label="输入健康问题或上传报告"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend(input)}
              placeholder={isOcrProcessing ? "正在识别图片中的文字..." : "输入健康问题或上传报告…"}
              className="flex-1 bg-transparent border-none outline-none py-2 text-[15px] placeholder:text-[#B5A898] text-[#3D3226] font-serif disabled:opacity-50"
            />
            <button 
              type="button"
              aria-label="发送消息"
              onClick={() => handleSend(input)}
              disabled={!input.trim() || isOcrProcessing}
              className={cn(
                "p-2 rounded-full transition-all shrink-0 ml-1 outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#8B5E3C]",
                input.trim() && !isOcrProcessing ? "bg-[#8B5E3C] text-white shadow-md hover:bg-[#7A4E30]" : "bg-[#E8E0D5] text-[#B5A898]"
              )}
            >
              <Send size={16} className={cn(input.trim() && "ml-0.5")} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
      
      <style>{`
        .hide-scrollbar::-webkit-scrollbar {
          display: none;
        }
        .hide-scrollbar {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
      `}</style>
    </div>
  );
}
