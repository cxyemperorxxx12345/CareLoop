import { lazy, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { LandingPage } from './pages/LandingPage';
import { LoginPage } from './pages/LoginPage';
import { PatientLayout } from './components/layouts/PatientLayout';
import { ClinicianLayout } from './components/layouts/ClinicianLayout';
import { FamilyLayout } from './components/layouts/FamilyLayout';

// 路由级代码分割：各页面按需加载，把首屏从「全量打包」拆成入口 + 每页独立 chunk，
// 使 recharts / video-react / streamdown 等重依赖只在进入对应页面时才加载。
const DashboardPage = lazy(() => import('./pages/patient/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const DocumentsPage = lazy(() => import('./pages/patient/DocumentsPage').then((m) => ({ default: m.DocumentsPage })));
const MedicationsPage = lazy(() => import('./pages/patient/MedicationsPage').then((m) => ({ default: m.MedicationsPage })));
const FollowupPage = lazy(() => import('./pages/patient/FollowupPage').then((m) => ({ default: m.FollowupPage })));
const AssistantPage = lazy(() => import('./pages/patient/AssistantPage').then((m) => ({ default: m.AssistantPage })));
const SymptomPage = lazy(() => import('./pages/patient/SymptomPage').then((m) => ({ default: m.SymptomPage })));
const CheckinPage = lazy(() => import('./pages/patient/CheckinPage').then((m) => ({ default: m.CheckinPage })));
const MessagesPage = lazy(() => import('./pages/patient/MessagesPage').then((m) => ({ default: m.MessagesPage })));
const ClinicianDashboardPage = lazy(() => import('./pages/clinician/ClinicianDashboardPage').then((m) => ({ default: m.ClinicianDashboardPage })));
const PatientsPage = lazy(() => import('./pages/clinician/PatientsPage').then((m) => ({ default: m.PatientsPage })));
const PatientDetailPage = lazy(() => import('./pages/clinician/PatientDetailPage').then((m) => ({ default: m.PatientDetailPage })));
const AlertsPage = lazy(() => import('./pages/clinician/AlertsPage').then((m) => ({ default: m.AlertsPage })));
const ReportsPage = lazy(() => import('./pages/clinician/ReportsPage').then((m) => ({ default: m.ReportsPage })));
const KnowledgePage = lazy(() => import('./pages/clinician/KnowledgePage').then((m) => ({ default: m.KnowledgePage })));
const FamilyDashboardPage = lazy(() => import('./pages/family/FamilyDashboardPage').then((m) => ({ default: m.FamilyDashboardPage })));
const FamilyMedicationsPage = lazy(() => import('./pages/family/FamilyMedicationsPage').then((m) => ({ default: m.FamilyMedicationsPage })));
const FamilyTasksPage = lazy(() => import('./pages/family/FamilyTasksPage').then((m) => ({ default: m.FamilyTasksPage })));
const FamilyMessagesPage = lazy(() => import('./pages/family/FamilyMessagesPage').then((m) => ({ default: m.FamilyMessagesPage })));

export interface RouteConfig {
  name: string;
  path: string;
  element: ReactNode;
  visible?: boolean;
  /** Accessible without login. Routes without this flag require authentication. Has no effect when RouteGuard is not in use. */
  public?: boolean;
  /** 嵌套子路由（用于带布局的双端工作台） */
  children?: Array<{ path: string; element: ReactNode }>;
}

export const routes: RouteConfig[] = [
  {
    name: '首页 · 愈见 CareLoop',
    path: '/',
    element: <LandingPage />,
    public: true,
  },
  {
    name: '登录 · 愈见 CareLoop',
    path: '/login',
    element: <LoginPage />,
    public: true,
  },
  // ===== 患者端 =====
  { name: '患者端', path: '/patient', element: <Navigate to="/patient/dashboard" replace /> },
  {
    name: '患者工作台',
    path: '/patient',
    element: <PatientLayout />,
    children: [
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'documents', element: <DocumentsPage /> },
      { path: 'medications', element: <MedicationsPage /> },
      { path: 'followup', element: <FollowupPage /> },
      { path: 'assistant', element: <AssistantPage /> },
      { path: 'symptom', element: <SymptomPage /> },
      { path: 'checkin', element: <CheckinPage /> },
      { path: 'messages', element: <MessagesPage /> },
    ],
  },
  // ===== 医护端 =====
  { name: '医护端', path: '/clinician', element: <Navigate to="/clinician/dashboard" replace /> },
  {
    name: '医护工作台',
    path: '/clinician',
    element: <ClinicianLayout />,
    children: [
      { path: 'dashboard', element: <ClinicianDashboardPage /> },
      { path: 'patients', element: <PatientsPage /> },
      { path: 'patients/:id', element: <PatientDetailPage /> },
      { path: 'alerts', element: <AlertsPage /> },
      { path: 'reports', element: <ReportsPage /> },
      { path: 'knowledge', element: <KnowledgePage /> },
    ],
  },
  // ===== 家属端（照护协同：登录患者授权账号，代打卡与升级任务响应）=====
  { name: '家属端', path: '/family', element: <Navigate to="/family/dashboard" replace /> },
  {
    name: '家属工作台',
    path: '/family',
    element: <FamilyLayout />,
    children: [
      { path: 'dashboard', element: <FamilyDashboardPage /> },
      { path: 'medications', element: <FamilyMedicationsPage /> },
      { path: 'tasks', element: <FamilyTasksPage /> },
      { path: 'messages', element: <FamilyMessagesPage /> },
    ],
  },
];
