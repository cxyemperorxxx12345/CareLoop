// 患者端布局：移动优先 + 底部 5 Tab；桌面设备框由 MobileShell 统一处理

import { CalendarHeart, Home, MessageCircle, Pill, Stethoscope } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { MobileShell } from '@/components/layouts/MobileShell';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/db/supabase';
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
    <MobileShell
      caption="愈见 CareLoop · 患者端"
      nav={
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
      }
    >
      <Outlet />
    </MobileShell>
  );
}

export default PatientLayout;
