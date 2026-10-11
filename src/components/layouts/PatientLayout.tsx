// 患者端布局：移动优先 max-w-md + 底部 5 Tab + 常驻免责声明
import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { CalendarHeart, Home, MessageCircle, Pill, Stethoscope } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { patientApi } from '@/lib/api';

const TABS = [
  { to: '/patient/dashboard', label: '今日', icon: Home },
  { to: '/patient/medications', label: '用药', icon: Pill },
  { to: '/patient/followup', label: '随访', icon: CalendarHeart },
  { to: '/patient/assistant', label: '助手', icon: Stethoscope },
  { to: '/patient/messages', label: '消息', icon: MessageCircle },
];

export function PatientLayout() {
  const { user } = useAuth();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;
    const refresh = async () => {
      const { supabase } = await import('@/db/supabase');
      const { data } = await supabase.auth.getUser();
      const uid = data.user?.id;
      if (!uid) return;
      const { data: p } = await supabase.from('patients').select('id').eq('profile_id', uid).maybeSingle();
      if (p?.id) setUnread(await patientApi.unreadCount((p as { id: string }).id));
    };
    refresh();
    timer = setInterval(refresh, 30000);
    return () => clearInterval(timer);
  }, [user?.id]);

  return (
    <div className="min-h-screen bg-background flex justify-center">
      <div className="w-full max-w-md min-h-screen flex flex-col bg-background border-x border-border/60">
        <main className="flex-1 min-w-0 pb-24">
          <Outlet />
        </main>

        {/* 底部导航（P0：点击区 ≥44px，选中态主色+浅色底） */}
        <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-md bg-card border-t border-border z-40">
          <div className="grid grid-cols-5">
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
                <span className="relative">
                  <t.icon className="w-5 h-5" />
                  {t.to === '/patient/messages' && unread > 0 && (
                    <span className="absolute -top-1 -right-1.5 min-w-4 h-4 px-0.5 rounded-full bg-destructive text-destructive-foreground text-[10px] grid place-items-center">
                      {unread > 99 ? '99+' : unread}
                    </span>
                  )}
                </span>
                {t.label}
              </NavLink>
            ))}
          </div>
        </nav>
      </div>
    </div>
  );
}

export default PatientLayout;
