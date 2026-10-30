/** Cliente HTTP dos testes: guarda os cookies como um navegador. Não importa nada do servidor. */
export function makeClient(base: () => string) {
  let cookies: Record<string, string> = {};
  return async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base() + url, {
      method,
      redirect: 'manual',
      headers: { 'content-type': 'application/json', cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, ...v] = pair.split('=');
      cookies = { ...cookies, [k]: v.join('=') };
    }
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* texto puro */
    }
    return { status: res.status, data, headers: res.headers };
  };
}
