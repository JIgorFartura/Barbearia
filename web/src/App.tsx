import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { api } from './lib/api';
import { usePath } from './lib/router';

// Cada área carrega só o código dela: o cliente no celular não baixa o painel nem o master.
const BarberApp = lazy(() => import('./pages/BarberApp').then((m) => ({ default: m.BarberApp })));
const CustomerArea = lazy(() => import('./pages/CustomerArea').then((m) => ({ default: m.CustomerArea })));
const Home = lazy(() => import('./pages/Home').then((m) => ({ default: m.Home })));
const Master = lazy(() => import('./pages/Master').then((m) => ({ default: m.Master })));
const Panel = lazy(() => import('./pages/Panel').then((m) => ({ default: m.Panel })));
const PrivacyPage = lazy(() => import('./pages/Legal').then((m) => ({ default: m.PrivacyPage })));
const ShopLanding = lazy(() => import('./pages/ShopLanding').then((m) => ({ default: m.ShopLanding })));
const ShopPrivacyPage = lazy(() => import('./pages/Legal').then((m) => ({ default: m.ShopPrivacyPage })));
const TermsPage = lazy(() => import('./pages/Legal').then((m) => ({ default: m.TermsPage })));

export interface Me {
  user: {
    id: number;
    name: string;
    email: string | null;
    phone: string | null;
    role: 'master' | 'owner' | 'barber' | 'reception';
    barbershopId: number | null;
    barberId: number | null;
    termsAccepted: boolean;
  } | null;
  shop: { id: number; slug: string; name: string } | null;
  setupNeeded: boolean;
}

export function App() {
  return (
    <Suspense fallback={null}>
      <Routes />
    </Suspense>
  );
}

function Routes() {
  const path = usePath();
  const [me, setMe] = useState<Me | null>(null);
  const refresh = useCallback(() => api<Me>('GET', '/api/auth/me').then(setMe), []);
  // Site da barbearia (/b/barbearia-do-ze), área do cliente (/conta) e política de privacidade (/privacidade).
  const shopMatch = /^\/b\/([a-z0-9-]+)(\/conta|\/privacidade)?\/?$/.exec(path);
  const publicPage = Boolean(shopMatch) || path === '/termos' || path === '/privacidade';
  useEffect(() => {
    // As páginas públicas não dependem do login do painel.
    if (!publicPage) refresh();
  }, [refresh, publicPage]);

  if (shopMatch) {
    if (shopMatch[2] === '/privacidade') return <ShopPrivacyPage slug={shopMatch[1]} />;
    return shopMatch[2] ? <CustomerArea slug={shopMatch[1]} /> : <ShopLanding slug={shopMatch[1]} />;
  }
  if (path === '/termos') return <TermsPage />;
  if (path === '/privacidade') return <PrivacyPage />;

  if (!me) return null;
  if (me.user?.role === 'master') return <Master me={me} onLogout={refresh} />;
  if (me.user?.role === 'owner' || me.user?.role === 'reception') return <Panel me={me} onLogout={refresh} />;
  if (me.user?.role === 'barber') return <BarberApp me={me} onLogout={refresh} />;
  return <Home me={me} onLogin={refresh} />;
}
