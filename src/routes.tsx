import { type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { LandingPage } from './pages/LandingPage';
import { LoginPage } from './pages/LoginPage';
import { PatientLayout } from './components/layouts/PatientLayout';
import { ClinicianLayout } from './components/layouts/ClinicianLayout';
import { DashboardPage } from './pages/patient/DashboardPage';
import { DocumentsPage } from './pages/patient/DocumentsPage';
import { MedicationsPage } from './pages/patient/MedicationsPage';
import { FollowupPage } from './pages/patient/FollowupPage';
import { AssistantPage } from './pages/patient/AssistantPage';
import { SymptomPage } from './pages/patient/SymptomPage';
import { CheckinPage } from './pages/patient/CheckinPage';
import { MessagesPage } from './pages/patient/MessagesPage';
import { PatientsPage } from './pages/clinician/PatientsPage';
import { PatientDetailPage } from './pages/clinician/PatientDetailPage';
import { AlertsPage } from './pages/clinician/AlertsPage';
import { ReportsPage } from './pages/clinician/ReportsPage';
import { KnowledgePage } from './pages/clinician/KnowledgePage';
import { ClinicianDashboardPage } from './pages/clinician/ClinicianDashboardPage';
import { FamilyLayout } from './components/layouts/FamilyLayout';
import { FamilyDashboardPage } from './pages/family/FamilyDashboardPage';
import { FamilyMedicationsPage } from './pages/family/FamilyMedicationsPage';
import { FamilyTasksPage } from './pages/family/FamilyTasksPage';
import { FamilyMessagesPage } from './pages/family/FamilyMessagesPage';

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
