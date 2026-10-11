import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { routes } from '@/routes';

interface RouteGuardProps {
  children: React.ReactNode;
}

// System-level public routes (no need to register in routes.tsx)
const SYSTEM_PUBLIC_ROUTES = ['/login', '/register', '/403', '/404'];

// Derived from routes.tsx: all routes marked with public: true
const routePublicPaths = routes.filter(r => r.public).map(r => r.path);

const PUBLIC_ROUTES = [...SYSTEM_PUBLIC_ROUTES, ...routePublicPaths];

function matchPublicRoute(path: string, patterns: string[]) {
  return patterns.some(pattern => {
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace('*', '.*') + '$');
      return regex.test(path);
    }
    return path === pattern;
  });
}

export function RouteGuard({ children }: RouteGuardProps) {
  const { user, profile, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (loading) return;

    const isPublic = matchPublicRoute(location.pathname, PUBLIC_ROUTES);

    if (!user && !isPublic) {
      navigate('/login', { state: { from: location.pathname }, replace: true });
      return;
    }

    // 登录后角色守卫：医护 /clinician/*、患者 /patient/*、家属 /family/*
    if (user && profile) {
      const homeByRole =
        profile.role === 'clinician'
          ? '/clinician/dashboard'
          : profile.role === 'family'
            ? '/family/dashboard'
            : '/patient/dashboard';
      if (location.pathname.startsWith('/clinician') && profile.role !== 'clinician') {
        navigate(homeByRole, { replace: true });
        return;
      }
      if (location.pathname.startsWith('/patient') && profile.role !== 'patient') {
        navigate(homeByRole, { replace: true });
        return;
      }
      if (location.pathname.startsWith('/family') && profile.role !== 'family') {
        navigate(homeByRole, { replace: true });
        return;
      }
    }
  }, [user, profile, loading, location.pathname, navigate]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
      </div>
    );
  }

  return <>{children}</>;
}