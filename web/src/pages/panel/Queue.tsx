import { Megaphone, Printer, QrCode, UserPlus, Users } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CheckoutModal, type QueuePreset } from '../../components/Checkout';
import { CopyField } from '../../components/CopyField';
import { Badge, Button, Card, ErrorText, Field, Input, Modal, inputClass } from '../../components/ui';
import { api } from '../../lib/api';
import { hourLabel, minutesLabel } from '../../lib/format';
import { useDesk } from '../../lib/role';

interface Entry {
  id: number;
  ticket: number;
  customer_id: number | null;
  name: string;
  phone: string | null;
  barber_id: number | null;
  barber_name: string | null;
  service_id: number | null;
  service_name: string | null;
  served_by: number | null;
  served_by_name: string | null;
  status: 'waiting' | 'called' | 'serving';
  source: 'qr' | 'balcao';
  position: number | null;
  expected_at: string | null;
  wait_min: number | null;
}

interface BarberInfo {
  id: number;
  name: string;
  current: { id: number; ticket: number; name: string; status: Entry['status'] } | null;
  next_appointment: { time: string; customer: string } | null;
  free_min: number;
}

interface QueueData {
  enabled: boolean;
  link: string;
  entries: Entry[];
  barbers: BarberInfo[];
  nextFree: { expected_at: string | null; wait_min: number | null };
}

const waitLabel = (min: number | null) => (min == null ? 'sem vaga hoje' : min < 5 ? 'agora' : `em ~${minutesLabel(min)}`);

/**
 * Fila de chegada (quem vem sem horário). Corre ao lado da agenda: quem tem horário marcado mantém o
 * horário, e a previsão da fila usa só os intervalos livres de cada barbeiro.
 */
export function Queue() {
  const desk = useDesk();
  const [data, setData] = useState<QueueData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [poster, setPoster] = useState(false);
  const [closing, setClosing] = useState<QueuePreset | null>(null);

  const load = useCallback(() => api<QueueData>('GET', '/api/shop/queue').then(setData, (e) => setError(e.message)), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  async function act(url: string, body?: unknown) {
    setError(null);
    try {
      await api('POST', url, body);
    } catch (e) {
      setError((e as Error).message);
    }
    load();
  }

  async function callNext(barber: BarberInfo) {
    setError(null);
    try {
      const r = await api<{ called: Entry | null }>('POST', '/api/shop/queue/call', { barber_id: barber.id });
      if (!r.called) setError(`Ninguém esperando pelo ${barber.name} agora.`);
    } catch (e) {
      setError((e as Error).message);
    }
    load();
  }

  async function toggle(enabled: boolean) {
    await api('PUT', '/api/shop/queue/settings', { enabled }).catch((e) => setError(e.message));
    load();
  }

  if (!data) return <ErrorText error={error} />;
  const waiting = data.entries.filter((e) => e.status === 'waiting');
  const entryOf = (id: number) => data.entries.find((e) => e.id === id);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Fila de chegada</h1>
          <p className="text-sm text-zinc-500">
            Para quem chega sem horário. Funciona junto com a agenda: quem marcou mantém o horário, e a fila anda nos intervalos livres.
          </p>
        </div>
        {!desk && (
          <label className="flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-medium ring-1 ring-zinc-200">
            <input type="checkbox" className="size-4 accent-zinc-900" checked={data.enabled} onChange={(e) => toggle(e.target.checked)} />
            Usar a fila de chegada
          </label>
        )}
      </div>
      <ErrorText error={error} />

      {!data.enabled ? (
        <Card>
          <p className="text-sm text-zinc-600">
            {desk
              ? 'O dono ainda não ligou a fila de chegada.'
              : 'Ligue a fila se a barbearia atende por ordem de chegada (só ela ou junto com a agenda). O cliente entra pelo QR Code do balcão e é avisado no WhatsApp quando for a vez dele.'}
          </p>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setAdding(true)}>
              <UserPlus className="size-4" /> Chegou alguém
            </Button>
            <Button variant="ghost" onClick={() => setPoster(true)}>
              <QrCode className="size-4" /> QR Code do balcão
            </Button>
            <span className="ml-auto self-center text-sm text-zinc-500">
              {waiting.length} esperando · quem chegar agora: {data.nextFree.expected_at ? `${hourLabel(data.nextFree.expected_at)} (${waitLabel(data.nextFree.wait_min)})` : 'sem vaga hoje'}
            </span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.barbers.map((b) => {
              const current = b.current ? entryOf(b.current.id) : null;
              return (
                <Card key={b.id}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-lg font-semibold">{b.name}</p>
                    {b.next_appointment ? (
                      <Badge tone={b.free_min < 30 ? 'gold' : 'zinc'}>
                        Marcado {hourLabel(b.next_appointment.time)} · {b.next_appointment.customer}
                      </Badge>
                    ) : (
                      <Badge tone="green">Sem horário marcado</Badge>
                    )}
                  </div>
                  {current ? (
                    <div className="mt-3 rounded-xl bg-emerald-50 p-3 ring-1 ring-emerald-200">
                      <p className="font-semibold">
                        Senha {current.ticket} · {current.name}
                      </p>
                      <p className="text-xs text-emerald-800">{current.status === 'called' ? 'Chamado, a caminho da cadeira' : 'Na cadeira'}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {current.status === 'called' && (
                          <Button className="!px-2.5 !py-1 text-xs" onClick={() => act(`/api/shop/queue/${current.id}/start`)}>
                            Sentou
                          </Button>
                        )}
                        <Button
                          className="!px-2.5 !py-1 text-xs"
                          variant="gold"
                          onClick={() =>
                            setClosing({
                              id: current.id,
                              customer: current.customer_id ? { id: current.customer_id, name: current.name } : null,
                              serviceId: current.service_id,
                              barberId: b.id,
                            })
                          }
                        >
                          Fechar comanda
                        </Button>
                        {current.status === 'called' && (
                          <Button className="!px-2.5 !py-1 text-xs" variant="ghost" onClick={() => act(`/api/shop/queue/${current.id}/back`)}>
                            Volta pra fila
                          </Button>
                        )}
                        <Button className="!px-2.5 !py-1 text-xs" variant="ghost" onClick={() => act(`/api/shop/queue/${current.id}/left`)}>
                          Não veio
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="mt-2 text-sm text-zinc-500">
                        {b.next_appointment ? `Livre por ${minutesLabel(b.free_min)} até o próximo horário marcado.` : `Livre por ${minutesLabel(b.free_min)} até o fim do expediente.`}
                      </p>
                      <Button className="mt-3 w-full" disabled={!waiting.length} onClick={() => callNext(b)}>
                        <Megaphone className="size-4" /> Chamar o próximo
                      </Button>
                    </>
                  )}
                </Card>
              );
            })}
          </div>

          <Card>
            <h2 className="mb-3 flex items-center gap-2 font-semibold">
              <Users className="size-5 text-zinc-400" /> Esperando
            </h2>
            {waiting.length === 0 ? (
              <p className="text-sm text-zinc-500">Ninguém na fila agora.</p>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {waiting.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <div className="flex items-center gap-3">
                      <span className="flex size-10 items-center justify-center rounded-full bg-zinc-900 font-bold text-white">{e.ticket}</span>
                      <div>
                        <p className="font-medium">
                          {e.name} {e.source === 'qr' && <Badge>QR</Badge>}
                        </p>
                        <p className="text-xs text-zinc-500">
                          {e.service_name ?? 'Corte'} · {e.barber_name ? `com ${e.barber_name}` : 'qualquer barbeiro'}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-zinc-600">{e.expected_at ? `${hourLabel(e.expected_at)} (${waitLabel(e.wait_min)})` : 'sem vaga hoje'}</span>
                      <button className="text-sm text-zinc-500 hover:text-red-600" onClick={() => act(`/api/shop/queue/${e.id}/left`)}>
                        Saiu
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      {adding && <AddModal barbers={data.barbers} onClose={() => setAdding(false)} onDone={() => (setAdding(false), load())} />}
      {poster && <PosterModal link={data.link} onClose={() => setPoster(false)} />}
      {closing && <CheckoutModal queue={closing} onClose={() => setClosing(null)} onDone={() => (setClosing(null), load())} />}
    </div>
  );
}

function AddModal({ barbers, onClose, onDone }: { barbers: BarberInfo[]; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [barberId, setBarberId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [services, setServices] = useState<{ id: number; name: string; kind: string; active: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<typeof services>('GET', '/api/shop/catalog').then((c) => setServices(c.filter((s) => s.kind === 'service' && s.active)), () => undefined);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/shop/queue', { name, phone: phone || null, barber_id: barberId ? Number(barberId) : null, service_id: serviceId ? Number(serviceId) : null });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Chegou alguém" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nome">
          <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <Field label="Celular (opcional)" hint="Com o celular, o cliente é avisado no WhatsApp quando for a vez dele.">
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="(11) 98888-7777" />
        </Field>
        <Field label="Barbeiro">
          <select className={inputClass} value={barberId} onChange={(e) => setBarberId(e.target.value)}>
            <option value="">O primeiro que estiver livre</option>
            {barbers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
        {services.length > 1 && (
          <Field label="Serviço">
            <select className={inputClass} value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              <option value="">Corte</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <ErrorText error={error} />
        <Button type="submit" className="w-full" loading={busy}>
          Pôr na fila
        </Button>
      </form>
    </Modal>
  );
}

/** Cartaz para o balcão: o QR Code que abre a fila no celular do cliente. */
function PosterModal({ link, onClose }: { link: string; onClose: () => void }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    fetch('/api/shop/queue/qr', { credentials: 'same-origin' })
      .then((r) => r.text())
      .then(setSvg, () => undefined);
  }, []);
  function print() {
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Fila de chegada</title>
      <style>body{font-family:system-ui,sans-serif;text-align:center;padding:48px}h1{font-size:44px;margin:0 0 8px}p{font-size:22px;color:#444}svg{width:420px;height:420px;margin:24px auto}</style></head>
      <body><h1>Chegou sem horário?</h1><p>Aponte a câmera do celular e entre na fila.<br>A gente te avisa no WhatsApp quando for a sua vez.</p>${svg}<p style="font-size:16px">${link}</p>
      <script>window.onload=()=>window.print()</script></body></html>`);
    w.document.close();
  }
  return (
    <Modal title="QR Code do balcão" onClose={onClose}>
      <div className="space-y-4 text-center">
        <div className="mx-auto size-56 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: svg }} />
        <p className="text-sm text-zinc-600">Imprima e deixe no balcão ou na porta: o cliente aponta a câmera, entra na fila e é avisado no WhatsApp.</p>
        <CopyField label="Link da fila" value={link} />
        <Button className="w-full" onClick={print}>
          <Printer className="size-4" /> Imprimir cartaz
        </Button>
      </div>
    </Modal>
  );
}
