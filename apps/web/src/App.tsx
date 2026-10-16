import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import { OrgLayout, useMe } from './app-shell';
import { Spinner } from './ui';
import { ForgotPage, InvitePage, LoginPage, OnboardingPage, RegisterPage, ResetPage, VerifyEmailPage } from './pages/Auth';
import { SetupPage } from './pages/Setup';
import { WebsitesPage, SiteDetailPage } from './pages/Websites';
import { PricesPage } from './pages/Prices';
import { OffersPage } from './pages/Offers';
import { StockPage } from './pages/Stock';
import { MarketingPage } from './pages/Marketing';
import { MatchesPage } from './pages/Matches';
import { AlertsPage } from './pages/Alerts';
import { ReportsPage, ReportViewPage, ComparePage } from './pages/Reports';
import { SettingsPage } from './pages/Settings';

// Pages that draw charts load recharts on demand so the first screen stays small.
const DashboardPage = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.DashboardPage })));
const ProductsPage = lazy(() => import('./pages/Products').then((m) => ({ default: m.ProductsPage })));
const ProductDetailPage = lazy(() => import('./pages/Products').then((m) => ({ default: m.ProductDetailPage })));
const QualityPage = lazy(() => import('./pages/Quality').then((m) => ({ default: m.QualityPage })));

/** The Shopify redirect arrives at /settings without a workspace in the path; send it to the workspace that started the connection. */
function SettingsRedirect() {
  const [sp] = useSearchParams();
  const me = useMe();
  if (me.isLoading) return <div style={{ padding: 40 }}><Spinner label="Loading" /></div>;
  if (!me.data) return <Navigate to="/login" replace />;
  const org = sp.get('org');
  const target = me.data.memberships.find((m) => m.orgId === org) ?? me.data.memberships[0];
  if (!target) return <Navigate to="/onboarding" replace />;
  const rest = new URLSearchParams(sp);
  rest.delete('org');
  return <Navigate to={`/o/${target.orgId}/settings?${rest.toString()}`} replace />;
}

function Home() {
  const me = useMe();
  if (me.isLoading) return <div style={{ padding: 40 }}><Spinner label="Loading" /></div>;
  if (!me.data) return <Navigate to="/login" replace />;
  const last = localStorage.getItem('sw.org');
  const target = me.data.memberships.find((m) => m.orgId === last) ?? me.data.memberships[0];
  return <Navigate to={target ? `/o/${target.orgId}` : '/onboarding'} replace />;
}

export function App() {
  return (
    <Suspense fallback={<div style={{ padding: 40 }}><Spinner label="Loading" /></div>}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot" element={<ForgotPage />} />
        <Route path="/reset-password" element={<ResetPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/invite" element={<InvitePage />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/settings" element={<SettingsRedirect />} />
        <Route path="/o/:orgId" element={<OrgLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="setup" element={<SetupPage />} />
          <Route path="websites" element={<WebsitesPage />} />
          <Route path="websites/:siteId" element={<SiteDetailPage />} />
          <Route path="prices" element={<PricesPage />} />
          <Route path="offers" element={<OffersPage />} />
          <Route path="stock" element={<StockPage />} />
          <Route path="marketing" element={<MarketingPage />} />
          <Route path="products" element={<ProductsPage />} />
          <Route path="products/:productId" element={<ProductDetailPage />} />
          <Route path="matches" element={<MatchesPage />} />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="quality" element={<QualityPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="reports/compare" element={<ComparePage />} />
          <Route path="reports/:reportId" element={<ReportViewPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
