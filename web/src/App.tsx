import { useCallback, useEffect, useState } from 'react';
import { api } from './lib/api';
import { usePath } from './lib/router';
import { Home } from './pages/Home';
import { Master } from './pages/Master';
import { Panel } from './pages/Panel';
import { ShopLanding } from './pages/ShopLanding';

export interface Me {
  user: { id: number; name: string; email: string; role: 'master' | 'owner'; barbershopId: number | null } | null;
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

  // Landing pública da barbearia: /b/barbearia-do-ze
  const shopMatch = /^\/b\/([a-z0-9-]+)\/?$/.exec(path);
  if (shopMatch) return <ShopLanding slug={shopMatch[1]} />;

  if (!me) return null;
  if (me.user?.role === 'master') return <Master me={me} onLogout={refresh} />;
  if (me.user?.role === 'owner') return <Panel me={me} onLogout={refresh} />;
  return <Home me={me} onLogin={refresh} />;
}
