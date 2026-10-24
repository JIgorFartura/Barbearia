export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'Não foi possível concluir. Tente de novo.');
  return data as T;
}

/** Lê uma imagem escolhida pelo usuário e envia; devolve o endereço salvo. */
export async function uploadImage(file: File): Promise<string> {
  if (file.size > 3 * 1024 * 1024) throw new Error('Imagem muito grande (máximo 3 MB).');
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
    reader.readAsDataURL(file);
  });
  return (await api<{ url: string }>('POST', '/api/uploads', { dataUrl })).url;
}
