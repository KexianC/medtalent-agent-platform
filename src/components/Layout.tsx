import { Outlet, Link, useLocation } from "react-router-dom";
import { Stethoscope, LayoutGrid, User, MessageCircleQuestion, MessageCircleHeart } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const navItems = [
  { path: "/", label: "科普", icon: Stethoscope },
  { path: "/faq", label: "百问", icon: MessageCircleQuestion },
  { path: "/interact", label: "互动", icon: MessageCircleHeart },
  { path: "/service", label: "服务", icon: LayoutGrid },
  { path: "/me", label: "我的", icon: User },
];

export default function Layout() {
  const location = useLocation();

  return (
    <div className="flex flex-col h-screen max-w-[480px] mx-auto bg-[#FAF7F2] overflow-hidden shadow-2xl relative">
      <main className="flex-1 overflow-y-auto overflow-x-hidden relative ink-wash-bg cloud-pattern-bg">
        <Outlet />
      </main>

      <nav className="bg-white border-t border-[#E8E0D5] flex items-center justify-around h-[68px] px-2 shrink-0 pb-safe">

        {navItems.map((item) => {
          const isActive = item.path === "/" ? location.pathname === "/" : location.pathname === item.path || location.pathname.startsWith(`${item.path}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                "flex flex-col items-center justify-center w-full h-full gap-1 transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-[#8B5E3C] rounded-lg",
                isActive ? "text-[var(--medical-blue)] nav-ink-indicator" : "text-[#B5A898] hover:text-[#3D3226]"
              )}
            >
              <div
                className={cn(
                  "p-1.5 rounded-full transition-all duration-300",
                  isActive && "bg-[var(--medical-blue)]/10 -translate-y-1 scale-110"
                )}
              >
                <Icon size={24} strokeWidth={isActive ? 2.5 : 2} aria-hidden="true" />
              </div>
              <span
                className={cn(
                  "text-[11px] font-medium transition-all duration-300",
                  isActive ? "opacity-100 scale-100" : "opacity-80 scale-95"
                )}
              >
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
