// 家属端布局：移动优先 max-w-md + 头部照护横幅 + 底部 4 Tab + 常驻免责声明（复用患者端视觉语言）
import { NavLink, Outlet } from 'react-router-dom';
import { ClipboardCheck, Home, MessageCircle, Pill } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

const TABS = [
  { to: '/family/dashboard', label: '首页', icon: Home },
  { to: '/family/medications', label: '代打卡', icon: Pill },
  { to: '/family/tasks', label: '任务', icon: ClipboardCheck },
  { to: '/family/messages', label: '消息', icon: MessageCircle },
];

export function FamilyLayout() {
  const { profile } = useAuth();

  return (
    <div className="min-h-screen bg-background flex justify-center">
      <div className="w-full max-w-md min-h-screen flex flex-col bg-background border-x border-border/60">
        {/* 头部：家属身份照护横幅 */}
        <header className="sticky top-0 z-40 bg-triage-blue-bg/90 backdrop-blur border-b border-triage-blue/20 px-4 py-2.5">
          <p className="text-[13px] font-semibold text-triage-blue text-center">
            家属协助 · {profile?.full_name ?? '家属'} 正在照护
          </p>
          <p className="text-xs text-muted-foreground text-center mt-0.5">
            仅可代为打卡与响应提醒，不能修改医嘱与计划
          </p>
        </header>

        <main className="flex-1 min-w-0 pb-24">
          <Outlet />
        </main>

        {/* 底部导航（点击区 ≥44px，选中态主色+浅底） */}
        <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-md bg-card border-t border-border z-40">
          <div className="grid grid-cols-4">
            {TABS.map((t) => (
              <NavLink
                key={t.to}
                to={t.to}
                className={({ isActive }) =>
                  `relative flex flex-col items-center justify-center gap-0.5 min-h-[3rem] text-xs font-medium transition-colors ${
                    isActive
                      ? 'text-primary bg-primary/10'
                      : 'text-muted-foreground hover:text-foreground'
                  }`
                }
              >
                <t.icon className="w-5 h-5" />
                {t.label}
              </NavLink>
            ))}
          </div>
        </nav>
      </div>
    </div>
  );
}

export default FamilyLayout;
