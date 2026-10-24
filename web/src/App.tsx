import { useCallback, useEffect, useState } from 'react';
import { api } from './lib/api';
import { usePath } from './lib/router';
import { BarberApp } from './pages/BarberApp';
import { CustomerArea } from './pages/CustomerArea';
import { Home } from './pages/Home';
import { PrivacyPage, ShopPrivacyPage, TermsPage } from './pages/Legal';
import { Master } from './pages/Master';
import { Panel } from './pages/Panel';
import { ShopLanding } from './pages/ShopLanding';

export interface Me {
  user: {
    id: number;
    name: string;
    email: string | null;
    phone: string | null;
    role: 'master' | 'owner' | 'barber';
    barbershopId: number | null;
    barberId: number | null;
    termsAccepted: boolean;
  } | null;
  shop: { id: number; slug: string; name: string } | null;
  setupNeeded: boolean;
}

export function App() {
  const path = usePath();
  const [me, setMe] = useState<Me | null>(null);
  const refresh = useCallback(() => api<Me>('GET', '/api/auth/me').then(setMe), []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Site da barbearia (/b/barbearia-do-ze), área do cliente (/conta) e política de privacidade (/privacidade).
  const shopMatch = /^\/b\/([a-z0-9-]+)(\/conta|\/privacidade)?\/?$/.exec(path);
  if (shopMatch) {
    if (shopMatch[2] === '/privacidade') return <ShopPrivacyPage slug={shopMatch[1]} />;
    return shopMatch[2] ? <CustomerArea slug={shopMatch[1]} /> : <ShopLanding slug={shopMatch[1]} />;
  }
  if (path === '/termos') return <TermsPage />;
  if (path === '/privacidade') return <PrivacyPage />;

  if (!me) return null;
  if (me.user?.role === 'master') return <Master me={me} onLogout={refresh} />;
  if (me.user?.role === 'owner') return <Panel me={me} onLogout={refresh} />;
  if (me.user?.role === 'barber') return <BarberApp me={me} onLogout={refresh} />;
  return <Home me={me} onLogin={refresh} />;
}
