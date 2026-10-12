// 家属端布局：移动优先 + 头部照护横幅 + 底部 4 Tab；桌面设备框由 MobileShell 统一处理

import { ClipboardCheck, Home, MessageCircle, Pill } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { MobileShell } from '@/components/layouts/MobileShell';
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
    <MobileShell
      caption="愈见 CareLoop · 家属端"
      header={
        /* 头部：家属身份照护横幅 */
        <header className="sticky top-0 z-40 bg-triage-blue-bg/90 backdrop-blur border-b border-triage-blue/20 px-4 py-2.5">
          <p className="text-[13px] font-semibold text-triage-blue text-center">
            家属协助 · {profile?.full_name ?? '家属'} 正在照护
          </p>
          <p className="text-xs text-muted-foreground text-center mt-0.5">
            仅可代为打卡与响应提醒，不能修改医嘱与计划
          </p>
        </header>
      }
      nav={
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
      }
    >
      <Outlet />
    </MobileShell>
  );
}

export default FamilyLayout;
