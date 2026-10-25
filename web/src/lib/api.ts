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

const readAsDataUrl = (file: File, what: string) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Não foi possível ler ${what}.`));
    reader.readAsDataURL(file);
  });

/** Lê uma imagem escolhida pelo usuário e envia; devolve o endereço salvo. */
export async function uploadImage(file: File): Promise<string> {
  if (file.size > 3 * 1024 * 1024) throw new Error('Imagem muito grande (máximo 3 MB).');
  const dataUrl = await readAsDataUrl(file, 'a imagem');
  return (await api<{ url: string }>('POST', '/api/uploads', { dataUrl })).url;
}

/**
 * Comprovante do PIX para enviar: a foto (ou o print) vai reduzida, em JPG, para subir rápido mesmo no
 * 4G; o PDF vai como está.
 */
export async function receiptDataUrl(file: File): Promise<string> {
  if (file.type === 'application/pdf') {
    if (file.size > 3 * 1024 * 1024) throw new Error('PDF muito grande (máximo 3 MB). Mande um print da tela do comprovante.');
    return readAsDataUrl(file, 'o PDF');
  }
  if (!file.type.startsWith('image/')) throw new Error('Envie uma foto (ou print) ou o PDF do comprovante.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Não deu para abrir essa foto. Tire um print da tela do comprovante e envie.'));
      el.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return readAsDataUrl(file, 'a foto');
    // Fundo branco: print com transparência não fica preto no JPG.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}
