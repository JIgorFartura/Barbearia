import { useEffect, useState } from 'react';

/** Roteador mínimo: o caminho da URL é o estado; navigate() troca sem recarregar. */
export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onChange = () => setPath(location.pathname);
    window.addEventListener('popstate', onChange);
    return () => window.removeEventListener('popstate', onChange);
  }, []);
  return path;
}

export function navigate(to: string): void {
  if (to === location.pathname) return;
  history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo(0, 0);
}
