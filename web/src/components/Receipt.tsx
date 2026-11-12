import { FileText, Upload } from 'lucide-react';
import { useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { api, receiptDataUrl } from '../lib/api';

/** Comprovante do PIX enviado pelo cliente (só o tipo e quando chegou: o arquivo abre por um endereço com login). */
export interface ReceiptInfo {
  type: string;
  at: string;
}

const when = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/**
 * Escolhe a foto, o print ou o PDF do comprovante e envia (área do cliente). `onDone` recebe a resposta
 * do servidor; `link` deixa o botão com cara de link (para trocar o comprovante já enviado).
 */
export function ReceiptUpload<T>({
  url,
  label,
  link,
  style,
  onDone,
  onError,
}: {
  url: string;
  label: string;
  link?: boolean;
  style?: CSSProperties;
  onDone: (data: T) => void;
  onError: (message: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    onError(null);
    try {
      onDone(await api<T>('POST', url, { dataUrl: await receiptDataUrl(file) }));
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <input ref={input} type="file" accept="image/*,application/pdf" className="hidden" onChange={pick} aria-label="Arquivo do comprovante" />
      {link ? (
        <button type="button" className="font-medium underline disabled:opacity-50" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? 'Enviando…' : label}
        </button>
      ) : (
        <button
          type="button"
          style={style}
          disabled={busy}
          onClick={() => input.current?.click()}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
        >
          <Upload className="size-4" /> {busy ? 'Enviando…' : label}
        </button>
      )}
    </>
  );
}

/** A cópia do comprovante para a barbearia: miniatura da foto (abre grande) ou o PDF para baixar. */
export function ReceiptPreview({ url, receipt }: { url: string; receipt: ReceiptInfo }) {
  const [broken, setBroken] = useState(false);
  if (receipt.type === 'application/pdf' || broken) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-700 underline hover:text-zinc-900">
        <FileText className="size-3.5" /> Comprovante {receipt.type === 'application/pdf' ? '(PDF)' : ''} · enviado {when(receipt.at)}
      </a>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-xs text-zinc-600 hover:text-zinc-900" title="Abrir o comprovante">
      <img src={url} alt="Comprovante do PIX" loading="lazy" onError={() => setBroken(true)} className="size-14 shrink-0 rounded-lg bg-white object-cover ring-1 ring-zinc-200" />
      <span>
        <b className="block font-medium text-zinc-800">Comprovante</b>
        enviado {when(receipt.at)} · toque para ampliar
      </span>
    </a>
  );
}
