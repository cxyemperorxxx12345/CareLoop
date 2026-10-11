import React, { useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import IntersectObserver from '@/components/common/IntersectObserver';
import { Toaster } from '@/components/ui/sonner';

import { routes } from './routes';

import { AuthProvider } from '@/contexts/AuthContext';
import { RouteGuard } from '@/components/common/RouteGuard';

// B4：全站标题统一「页面名 · 愈见 CareLoop」
const TITLE_MAP: Array<[string, string]> = [
  ['/patient/dashboard', '今日概览'],
  ['/patient/medications', '用药打卡'],
  ['/patient/followup', '随访计划'],
  ['/patient/assistant', '智能问答'],
  ['/patient/symptom', '症状自查'],
  ['/patient/checkin', '健康打卡'],
  ['/patient/messages', '消息中心'],
  ['/patient/documents', '出院资料'],
  ['/clinician/dashboard', '工作台'],
  ['/clinician/patients', '患者管理'],
  ['/clinician/alerts', '预警中心'],
  ['/clinician/reports', '随访报告'],
  ['/clinician/knowledge', '知识库'],
  ['/family/dashboard', '家属首页'],
  ['/family/medications', '代为打卡'],
  ['/family/tasks', '待我处理'],
  ['/family/messages', '家属消息'],
  ['/login', '登录'],
  ['/', '首页'],
];

function TitleSetter() {
  const location = useLocation();
  useEffect(() => {
    const hit = TITLE_MAP.find(([prefix]) => location.pathname === prefix) ?? TITLE_MAP.find(([prefix]) => location.pathname.startsWith(prefix));
    document.title = hit ? `${hit[1]} · 愈见 CareLoop` : '愈见 CareLoop';
  }, [location.pathname]);
  return null;
}

const App: React.FC = () => {
  return (
    <Router>
      <TitleSetter />
      <AuthProvider>
        <RouteGuard>
          <IntersectObserver />
          <div className="flex flex-col min-h-screen">
            <main className="flex-grow">
              <Routes>
                {routes.map((route, index) => (
                  <Route
                    key={index}
                    path={route.path}
                    element={route.element}
                  >
                    {route.children?.map((child, childIndex) => (
                      <Route
                        key={childIndex}
                        path={child.path}
                        element={child.element}
                      />
                    ))}
                  </Route>
                ))}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </main>
          </div>
          <Toaster duration={3000} richColors closeButton={false} />
        </RouteGuard>
      </AuthProvider>
    </Router>
  );
};

export default App;
