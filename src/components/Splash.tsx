import { useState, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Phone, Lock, Eye, EyeOff, CheckCircle2 } from "lucide-react";
import { DOCTOR_AVATAR } from "@/utils/imageUtils";

type SplashProps = {
  open: boolean;
  onClose: () => void;
};

export default function Splash({ open, onClose }: SplashProps) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginSuccess, setLoginSuccess] = useState(false);

  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [countdown]);

  const handleSendCode = () => {
    setCountdown(60);
  };

  const handleLogin = () => {
    setIsLoggingIn(true);
    setTimeout(() => {
      setIsLoggingIn(false);
      setLoginSuccess(true);
      setTimeout(() => onClose(), 800);
    }, 600);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="splash-root"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/20"
        >
          <div className="w-full max-w-[480px] h-full flex flex-col items-center px-6 pt-10 pb-10 overflow-y-auto bg-[var(--bg-main)] shadow-2xl relative">

            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.04 }}
              transition={{ delay: 0.1, duration: 1 }}
              className="absolute inset-0 pointer-events-none"
              style={{
                backgroundImage: `
                  radial-gradient(circle at 15% 85%, var(--medical-blue) 0.5px, transparent 0.5px),
                  radial-gradient(circle at 85% 15%, var(--gold) 0.5px, transparent 0.5px),
                  radial-gradient(circle at 50% 50%, var(--medical-blue) 0.3px, transparent 0.3px)
                `,
                backgroundSize: '100px 100px, 140px 140px, 70px 70px',
              }}
            />

            <div className="w-full flex flex-col items-center justify-center text-center mt-8 mb-8 relative z-10">
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.1, duration: 0.6, ease: "easeOut" }}
                className="relative mb-6"
              >
                <div className="w-28 h-28 rounded-full bg-gradient-to-br from-[var(--paper)] to-[var(--bg-muted)] flex items-center justify-center border-2 border-[var(--medical-blue)]/20 shadow-lg relative overflow-hidden">
                  <div className="absolute inset-0 rounded-full border-2 border-[var(--gold)]/30 z-10" />
                  <img
                    src={DOCTOR_AVATAR}
                    alt="龚文波主任医师"
                    className="w-full h-full object-cover object-center"
                    onError={(e) => {
                      const target = e.target as HTMLImageElement;
                      target.style.display = 'none';
                    }}
                  />
                </div>

              </motion.div>

              <motion.h1
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.25, duration: 0.5, ease: "easeOut" }}
                className="text-[24px] font-semibold text-[var(--ink-black)] tracking-wider font-heading"
              >
                龚文波医生智能体空间
              </motion.h1>

              <motion.p
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.35, duration: 0.5, ease: "easeOut" }}
                className="mt-2 text-[14px] text-[var(--text-muted)]"
              >
                宁波市中医院
              </motion.p>

              <motion.div
                initial={{ opacity: 0, scaleX: 0 }}
                animate={{ opacity: 1, scaleX: 1 }}
                transition={{ delay: 0.4, duration: 0.6, ease: "easeOut" }}
                className="mt-4 chinese-divider w-36"
              >
                <span className="chinese-divider-icon">◆</span>
              </motion.div>
            </div>

            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5, duration: 0.5, ease: "easeOut" }}
              className="w-full max-w-sm bg-white rounded-[24px] shadow-sm border border-[#E8E0D5]/60 p-6 relative z-10"
            >
              <h2 className="text-[18px] font-semibold text-[var(--ink-black)] font-heading mb-6 text-center">登录</h2>

              <div className="space-y-4">
                <div className="relative">
                  <label className="block text-[13px] text-[var(--text-muted)] mb-1.5 font-serif">手机号</label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--text-muted)]" aria-hidden="true" />
                    <input
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="请输入手机号"
                      maxLength={11}
                      className="w-full bg-[#FAF7F2] border border-[#E8E0D5] rounded-xl py-3 pl-11 pr-4 text-[15px] text-[var(--ink-black)] placeholder:text-[#B5A898] focus:outline-none focus:ring-2 focus:ring-[var(--medical-blue)] focus:border-[var(--medical-blue)] transition-all font-serif"
                    />
                  </div>
                </div>

                <div className="relative">
                  <label className="block text-[13px] text-[var(--text-muted)] mb-1.5 font-serif">验证码</label>
                  <div className="relative flex gap-3">
                    <div className="flex-1 relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--text-muted)]" aria-hidden="true" />
                      <input
                        type={showPassword ? "text" : "password"}
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        placeholder="请输入验证码"
                        maxLength={6}
                        className="w-full bg-[#FAF7F2] border border-[#E8E0D5] rounded-xl py-3 pl-11 pr-4 text-[15px] text-[var(--ink-black)] placeholder:text-[#B5A898] focus:outline-none focus:ring-2 focus:ring-[var(--medical-blue)] focus:border-[var(--medical-blue)] transition-all font-serif"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--medical-blue)] transition-colors outline-none focus:ring-2 focus:ring-[var(--medical-blue)] rounded-full"
                      >
                        {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={handleSendCode}
                      disabled={countdown > 0}
                      className={`px-4 py-2.5 rounded-xl text-[13px] font-medium whitespace-nowrap transition-all outline-none focus:ring-2 focus:ring-[var(--medical-blue)] ${
                        countdown > 0
                          ? 'bg-[#E8E0D5] text-[#B5A898] cursor-not-allowed'
                          : 'bg-[var(--medical-blue)]/10 text-[var(--medical-blue)] hover:bg-[var(--medical-blue)]/15'
                      }`}
                    >
                      {countdown > 0 ? `${countdown}s` : '获取验证码'}
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleLogin}
                  disabled={isLoggingIn}
                  className="chinese-btn w-full mt-4 flex items-center justify-center gap-2"
                >
                  {isLoggingIn ? (
                    <span className="inline-block w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" aria-hidden="true" />
                  ) : loginSuccess ? (
                    <CheckCircle2 size={20} aria-hidden="true" />
                  ) : null}
                  {loginSuccess ? '登录成功' : '登录'}
                </button>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.7, duration: 0.5, ease: "easeOut" }}
              className="mt-6 relative z-10"
            >
              <button
                type="button"
                onClick={onClose}
                className="text-[14px] text-[var(--text-muted)] hover:text-[var(--medical-blue)] underline underline-offset-4 transition-colors outline-none focus:ring-2 focus:ring-[var(--medical-blue)] rounded px-1"
              >
                游客浏览
              </button>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.9, duration: 0.5, ease: "easeOut" }}
              className="mt-auto pt-6 text-center text-[13px] text-[var(--text-muted)] space-y-1 relative z-10"
            >
              <div className="chinese-ornament pb-4">
                <div>生了病，不担心</div>
                <div>少生病，更健康</div>
              </div>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
