// 医护端布局：桌面侧边栏（含未处理预警角标）+ 移动端受控抽屉菜单
import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { BookOpen, FileText, LayoutDashboard, Menu, Users } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useAuth } from '@/contexts/AuthContext';
import { BrandMark } from '@/components/common/BrandMark';
import { supabase } from '@/db/supabase';

const MENU = [
  { to: '/clinician/dashboard', label: '工作台', icon: LayoutDashboard },
  { to: '/clinician/patients', label: '患者管理', icon: Users },
  { to: '/clinician/alerts', label: '预警中心', icon: FileText },
  { to: '/clinician/reports', label: '随访报告', icon: BookOpen },
  { to: '/clinician/knowledge', label: '知识库', icon: BookOpen },
];

function MenuItems({ alertCount, onNavigate }: { alertCount: number; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-1 px-3">
      {MENU.map((m) => (
        <NavLink
          key={m.to}
          to={m.to}
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition-colors ${
              isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`
          }
        >
          <m.icon className="w-4 h-4 shrink-0" />
          <span className="flex-1">{m.label}</span>
          {/* 预警中心：未处理预警角标 */}
          {m.to === '/clinician/alerts' && alertCount > 0 ? (
            <span className="grid h-5 min-w-5 place-items-center rounded-full bg-destructive px-1.5 text-[11px] font-bold text-white">
              {alertCount > 99 ? '99+' : alertCount}
            </span>
          ) : null}
        </NavLink>
      ))}
    </nav>
  );
}

export function ClinicianLayout() {
  const { profile, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  // 未处理预警角标：实时统计 + 定时刷新
  const [alertCount, setAlertCount] = useState(0);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const { count } = await supabase
        .from('alerts')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'open');
      if (alive) setAlertCount(count ?? 0);
    };
    refresh();
    const timer = setInterval(refresh, 30000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="flex min-h-screen w-full bg-background">
      {/* 桌面侧边栏 */}
      <aside className="hidden md:flex flex-col w-64 shrink-0 border-r border-border bg-sidebar">
        <div className="flex items-center gap-2.5 px-5 py-5 border-b border-sidebar-border">
          <BrandMark className="w-9 h-9 text-primary shrink-0" title="" />
          <div className="min-w-0">
            <p className="font-black text-sm truncate">愈见 CareLoop</p>
            <p className="text-xs text-muted-foreground truncate">医护工作台</p>
          </div>
        </div>
        <div className="flex-1 py-4">
          <MenuItems alertCount={alertCount} />
        </div>
        <div className="p-4 border-t border-sidebar-border">
          <p className="text-xs text-muted-foreground truncate mb-2">{profile?.full_name ?? '医护'}</p>
          <button
            type="button"
            onClick={signOut}
            className="w-full text-left text-xs font-medium text-muted-foreground hover:text-foreground rounded-lg border border-border px-3 py-2 transition-colors"
          >
            退出登录
          </button>
        </div>
      </aside>

      {/* 移动端顶栏 + 抽屉 */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="md:hidden flex items-center gap-3 px-4 py-3 border-b border-border bg-card sticky top-0 z-40">
          <button
            type="button"
            aria-label="打开菜单"
            onClick={() => setOpen(true)}
            className="p-2 -ml-2 rounded-lg hover:bg-muted"
          >
            <Menu className="w-5 h-5" />
          </button>
          <p className="font-black text-sm truncate">愈见 CareLoop · 医护工作台</p>
        </header>

        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="left" className="w-72 bg-sidebar p-0">
            <SheetTitle className="sr-only">工作台菜单</SheetTitle>
            <div className="flex items-center gap-2.5 px-5 py-5 border-b border-sidebar-border">
              <BrandMark className="w-9 h-9 text-primary shrink-0" title="" />
              <div className="min-w-0">
                <p className="font-black text-sm truncate">愈见 CareLoop</p>
                <p className="text-xs text-muted-foreground truncate">{profile?.full_name ?? '医护'}</p>
              </div>
            </div>
            <div className="py-4">
              <MenuItems alertCount={alertCount} onNavigate={() => setOpen(false)} />
            </div>
            <div className="p-4 border-t border-sidebar-border">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  signOut();
                }}
                className="w-full text-left text-xs font-medium text-muted-foreground rounded-lg border border-border px-3 py-2"
              >
                退出登录
              </button>
            </div>
          </SheetContent>
        </Sheet>

        <main className="flex-1 min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default ClinicianLayout;
