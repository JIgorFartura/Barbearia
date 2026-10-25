import { Camera, ChevronRight, ImagePlus, NotebookPen, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { api, cutPhotoDataUrls } from '../lib/api';
import { Button, ErrorText, Field, Input, Modal, inputClass } from './ui';

/** O que vem no cartão do horário (agenda do dono e do barbeiro). */
export interface ProfileSummary {
  notes: string | null;
  photos: number;
  lastPhotoId: number | null;
}

export interface CutPhoto {
  id: number;
  created_at: string;
  barber_name: string | null;
  note: string | null;
}

interface ProfileData {
  customer: { id: number; name: string; phone: string };
  notes: string | null;
  photos: (CutPhoto & { can_delete: boolean })[];
}

/** "25/10" (deste ano) ou "25/10/25". */
export function photoDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: '2-digit' }) });
}

/** Miniatura que abre a foto grande numa aba (o endereço só abre com login). */
export function PhotoThumb({ url, photo, className = 'size-20' }: { url: string; photo: CutPhoto; className?: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" title="Abrir a foto" className="block shrink-0">
      <img
        src={`${url}?mini=1`}
        alt={`Corte de ${photoDate(photo.created_at)}`}
        loading="lazy"
        className={`${className} rounded-lg bg-zinc-100 object-cover ring-1 ring-zinc-200`}
      />
    </a>
  );
}

/**
 * Linha da ficha no cartão do horário: a última foto do corte e o jeito que o cliente gosta. Sem nada
 * anotado, vira um convite para anotar (é o que faz o próximo corte sair igual, com qualquer barbeiro).
 */
export function ProfileLine({ base, summary, onOpen }: { base: string; summary: ProfileSummary; onOpen: () => void }) {
  const empty = !summary.notes && !summary.photos;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`mt-1.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs ring-1 transition ${
        empty ? 'text-zinc-400 ring-zinc-100 hover:bg-zinc-50 hover:text-zinc-600' : 'bg-sky-50/60 text-zinc-700 ring-sky-100 hover:bg-sky-50'
      }`}
    >
      {summary.lastPhotoId ? (
        <img src={`${base}/photos/${summary.lastPhotoId}?mini=1`} alt="Último corte" loading="lazy" className="size-9 shrink-0 rounded-md bg-zinc-100 object-cover" />
      ) : (
        <NotebookPen className="size-4 shrink-0" />
      )}
      <span className="line-clamp-2 min-w-0 flex-1">
        {empty ? 'Ficha: anote o jeito que ele gosta e tire foto do corte' : summary.notes || 'Sem anotações'}
        {summary.photos > 0 && <span className="text-zinc-500"> · 📷 {summary.photos}</span>}
      </span>
      <ChevronRight className="size-4 shrink-0 opacity-60" />
    </button>
  );
}

/**
 * Ficha do cliente: anotações (o que ele gosta, máquina, produto) e as fotos dos cortes. `base` é
 * /api/shop (dono) ou /api/barber (barbeiro: só clientes da agenda dele e só apaga as fotos que tirou).
 * `appointmentId` liga a foto nova ao horário de onde a ficha foi aberta.
 */
export function ProfileModal({
  base,
  customerId,
  customerName,
  appointmentId,
  onClose,
  onChanged,
}: {
  base: string;
  customerId: number;
  customerName: string;
  appointmentId?: number;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [data, setData] = useState<ProfileData | null>(null);
  const [notes, setNotes] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ dataUrl: string; thumbUrl: string } | null>(null);
  const [caption, setCaption] = useState('');
  const [error, setError] = useState<string | null>(null);
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);

  const show = (d: ProfileData) => {
    setData(d);
    setNotes(d.notes ?? '');
  };
  useEffect(() => {
    api<ProfileData>('GET', `${base}/customers/${customerId}/profile`).then(show, (e) => setError(e.message));
  }, [base, customerId]);

  async function saveNotes() {
    setBusy(true);
    setError(null);
    try {
      show(await api<ProfileData>('PUT', `${base}/customers/${customerId}/notes`, { notes }));
      setSaved(true);
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    try {
      setPending(await cutPhotoDataUrls(file));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function sendPhoto() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      show(await api<ProfileData>('POST', `${base}/customers/${customerId}/photos`, { ...pending, appointment_id: appointmentId ?? null, note: caption }));
      setPending(null);
      setCaption('');
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    if (!confirm('Apagar esta foto?')) return;
    setError(null);
    try {
      await api('DELETE', `${base}/photos/${id}`);
      setData((d) => d && { ...d, photos: d.photos.filter((p) => p.id !== id) });
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal title={`Ficha de ${customerName.split(/\s+/)[0]}`} onClose={onClose}>
      {!data ? (
        <ErrorText error={error} />
      ) : (
        <div className="space-y-5">
          <div>
            <Field
              label="Como ele gosta"
              hint="Ex.: máquina 2 nas laterais, tesoura em cima, risquinho do lado esquerdo, pomada matte. O cliente pode pedir uma cópia dos dados dele (LGPD): anote só o que ajuda no atendimento."
            >
              <textarea
                className={`${inputClass} min-h-24`}
                maxLength={1000}
                value={notes}
                onChange={(e) => {
                  setNotes(e.target.value);
                  setSaved(false);
                }}
                placeholder="O jeito que ele gosta do corte e da barba"
              />
            </Field>
            <div className="mt-2 flex items-center gap-3">
              <Button variant="ghost" className="!py-1.5" loading={busy && !pending} disabled={notes === (data.notes ?? '')} onClick={saveNotes}>
                Salvar anotações
              </Button>
              {saved && <span className="text-xs font-medium text-emerald-700">✓ Salvo</span>}
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium text-zinc-700">Fotos do corte</p>
            <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" onChange={pick} aria-label="Tirar foto do corte" />
            <input ref={gallery} type="file" accept="image/*" className="hidden" onChange={pick} aria-label="Escolher foto da galeria" />
            {pending ? (
              <div className="space-y-2 rounded-xl bg-zinc-50 p-3 ring-1 ring-zinc-200">
                <img src={pending.thumbUrl} alt="Foto nova" className="size-28 rounded-lg object-cover" />
                <Field label="Descrição do corte (opcional)" hint="O cliente também vê, na área dele.">
                  <Input maxLength={200} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Ex.: degradê navalhado, 0,5 no pezinho" />
                </Field>
                <div className="flex gap-2">
                  <Button loading={busy} onClick={sendPhoto}>
                    Salvar foto
                  </Button>
                  <Button variant="ghost" disabled={busy} onClick={() => setPending(null)}>
                    Cancelar
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => camera.current?.click()}>
                  <Camera className="size-4" /> Tirar foto
                </Button>
                <button type="button" className="inline-flex items-center gap-1.5 text-sm text-zinc-600 hover:text-zinc-900" onClick={() => gallery.current?.click()}>
                  <ImagePlus className="size-4" /> Escolher da galeria
                </button>
              </div>
            )}
            <ErrorText error={error} />
            {data.photos.length === 0 ? (
              <p className="mt-3 text-sm text-zinc-400">Nenhuma foto ainda. Tire uma no fim do corte: na próxima vez é só repetir.</p>
            ) : (
              <ul className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-4">
                {data.photos.map((p) => (
                  <li key={p.id} className="min-w-0 text-xs text-zinc-500">
                    <PhotoThumb url={`${base}/photos/${p.id}`} photo={p} className="aspect-square w-full" />
                    <p className="mt-1 flex items-center justify-between gap-1">
                      <span className="truncate">
                        {photoDate(p.created_at)}
                        {p.barber_name ? ` · ${p.barber_name.split(/\s+/)[0]}` : ''}
                      </span>
                      {p.can_delete && (
                        <button type="button" className="shrink-0 text-zinc-400 hover:text-red-600" onClick={() => remove(p.id)} aria-label="Apagar foto">
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </p>
                    {p.note && <p className="line-clamp-2 text-zinc-600">{p.note}</p>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
