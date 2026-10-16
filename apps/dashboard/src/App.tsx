import { useAuth } from './auth';
import { Link, parseRoute, useLocation } from './lib/router';
import { LoginPage } from './pages/LoginPage';
import { MetricsPage } from './pages/MetricsPage';
import { PolicyPage } from './pages/PolicyPage';
import { ReportPage } from './pages/ReportPage';
import { SessionsPage } from './pages/SessionsPage';

export function App() {
  const { token, me, logout } = useAuth();
  const { pathname } = useLocation();
  if (!token) return <LoginPage />;

  const route = parseRoute(pathname);
  const nav = (to: string, label: string, active: boolean) => (
    <Link
      to={to}
      className={`rounded px-3 py-1.5 text-sm font-medium ${active ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-200'}`}
      aria-current={active ? 'page' : undefined}
    >
      {label}
    </Link>
  );

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
          <span className="mr-4 font-semibold">Hawkeye</span>
          <nav className="flex gap-1" aria-label="Main">
            {nav('/', 'Sessions', route.name === 'sessions' || route.name === 'report')}
            {nav('/policy', 'Policy', route.name === 'policy')}
            {me?.role === 'admin' && nav('/metrics', 'Metrics', route.name === 'metrics')}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm text-slate-600">
            {me && (
              <span>
                {me.email} · {me.role === 'admin' ? 'Admin' : 'Reviewer'}
              </span>
            )}
            <button
              type="button"
              className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100"
              onClick={() => void logout()}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        {route.name === 'sessions' && <SessionsPage />}
        {route.name === 'report' && <ReportPage sessionId={route.sessionId} />}
        {route.name === 'policy' && <PolicyPage />}
        {route.name === 'metrics' && <MetricsPage />}
        {route.name === 'notFound' && <p>Page not found.</p>}
      </main>
    </div>
  );
}
