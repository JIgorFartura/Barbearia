import { CheckCircle2, Minus, Plus, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { METHODS, parseMoney, type Method } from '../lib/finance';
import { money, phone, stampLabel } from '../lib/format';
import { Button, ErrorText, Field, Input, Modal, inputClass } from './ui';

interface CatalogItem {
  id: number;
  kind: 'service' | 'product';
  name: string;
  price_cents: number;
  /** Produto com controle de estoque: quanto ainda tem (null = não controla). */
  available: number | null;
}

interface CheckoutData {
  appointment: {
    id: number;
    customer_id: number;
    customer_name: string;
    barber_id: number;
    service_id: number | null;
    service_name: string;
    price_cents: number;
    starts_at: string;
  } | null;
  reserved: { catalog_item_id: number; name: string; qty: number }[];
  catalog: CatalogItem[];
  barbers: { id: number; name: string }[];
}

interface Line {
  key: number;
  catalog_item_id: number | null;
  kind: 'service' | 'product';
  name: string;
  qty: number;
  unit_price_cents: number;
  barber_id: number | null;
}

export interface SaleResult {
  sale: { id: number; total_cents: number };
  stamps: { campaign: string; qty: number; unit: string; available: number }[];
}

let nextKey = 1;

/**
 * Fechar o atendimento (ou uma venda de balcão): itens, quem atendeu, desconto e forma de pagamento.
 * Gera a entrada no caixa, a comissão do barbeiro e os carimbos das campanhas.
 */
export function CheckoutModal({
  appointmentId,
  customer: presetCustomer,
  onClose,
  onDone,
}: {
  appointmentId?: number;
  customer?: { id: number; name: string } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [data, setData] = useState<CheckoutData | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [customer, setCustomer] = useState<{ id: number; name: string } | null>(presetCustomer ?? null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ id: number; name: string; phone: string }[]>([]);
  const [discount, setDiscount] = useState('');
  const [method, setMethod] = useState<Method>('pix');
  const [notes, setNotes] = useState('');
  const [adding, setAdding] = useState('');
  const [result, setResult] = useState<SaleResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<CheckoutData>('GET', `/api/shop/finance/checkout${appointmentId ? `?appointment_id=${appointmentId}` : ''}`).then((d) => {
      setData(d);
      const a = d.appointment;
      if (!a) return;
      setCustomer({ id: a.customer_id, name: a.customer_name });
      const service = d.catalog.find((c) => c.id === a.service_id);
      const initial: Line[] = [
        {
          key: nextKey++,
          catalog_item_id: service?.id ?? null,
          kind: 'service',
          name: service?.name ?? a.service_name,
          qty: 1,
          unit_price_cents: service?.price_cents ?? a.price_cents,
          barber_id: a.barber_id,
        },
        // O que o cliente pediu para deixar separado já entra na comanda.
        ...d.reserved.map((r) => {
          const p = d.catalog.find((c) => c.id === r.catalog_item_id);
          return { key: nextKey++, catalog_item_id: r.catalog_item_id, kind: 'product' as const, name: r.name, qty: r.qty, unit_price_cents: p?.price_cents ?? 0, barber_id: a.barber_id };
        }),
      ];
      setLines(initial);
    }, (e) => setError(e.message));
  }, [appointmentId]);

  useEffect(() => {
    if (customer || !q.trim()) {
      setFound([]);
      return;
    }
    const t = setTimeout(() => api<typeof found>('GET', `/api/shop/customers?q=${encodeURIComponent(q)}`).then((r) => setFound(r.slice(0, 5))), 250);
    return () => clearTimeout(t);
  }, [q, customer]);

  const defaultBarber = data?.appointment?.barber_id ?? data?.barbers[0]?.id ?? null;
  const subtotal = useMemo(() => lines.reduce((s, l) => s + l.unit_price_cents * l.qty, 0), [lines]);
  const discountCents = Math.min(parseMoney(discount), subtotal);
  const total = subtotal - discountCents;

  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  function addItem(id: string) {
    const c = data?.catalog.find((x) => String(x.id) === id);
    if (!c) return;
    setLines((ls) => [...ls, { key: nextKey++, catalog_item_id: c.id, kind: c.kind, name: c.name, qty: 1, unit_price_cents: c.price_cents, barber_id: defaultBarber }]);
    setAdding('');
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<SaleResult>('POST', '/api/shop/finance/sales', {
        appointment_id: appointmentId ?? null,
        customer_id: appointmentId ? null : (customer?.id ?? null),
        items: lines.map((l) => ({ catalog_item_id: l.catalog_item_id, name: l.catalog_item_id ? null : l.name, kind: l.kind, qty: l.qty, unit_price_cents: l.unit_price_cents, barber_id: l.barber_id })),
        discount_cents: discountCents,
        method,
        notes: notes || null,
      });
      setResult(r);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <Modal title="Venda registrada" onClose={onDone}>
        <div className="space-y-4 text-center">
          <CheckCircle2 className="mx-auto size-12 text-emerald-600" />
          <p className="text-2xl font-bold">{money(result.sale.total_cents)}</p>
          <p className="text-sm text-zinc-500">Entrou no caixa e a comissão do barbeiro já foi calculada.</p>
          {result.stamps.map((s) => (
            <p key={s.campaign} className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              +{s.qty} {s.qty === 1 ? 'carimbo' : 'carimbos'} no <b>{s.campaign}</b>
              {s.available > 0 && ' · tem prêmio para retirar! 🎉'}
            </p>
          ))}
          <Button className="w-full" onClick={onDone}>
            Concluir
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={data?.appointment ? 'Fechar atendimento' : 'Nova venda'} onClose={onClose}>
      {!data ? (
        <ErrorText error={error} />
      ) : (
        <div className="space-y-4">
          {data.appointment ? (
            <p className="rounded-xl bg-zinc-50 px-3 py-2 text-sm">
              <b>{data.appointment.customer_name}</b> · {stampLabel(data.appointment.starts_at)}
            </p>
          ) : customer ? (
            <div className="flex items-center justify-between rounded-xl bg-zinc-50 px-3 py-2 text-sm">
              <b>{customer.name}</b>
              {!presetCustomer && (
                <button className="text-zinc-500 hover:text-zinc-900" onClick={() => setCustomer(null)}>
                  Trocar
                </button>
              )}
            </div>
          ) : (
            <Field label="Cliente (opcional)" hint="Com o cliente, a venda conta no cartão fidelidade e no histórico dele.">
              <div className="relative">
                <Search className="absolute top-2.5 left-3 size-4 text-zinc-400" />
                <Input className="pl-9" placeholder="Nome ou celular" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              {found.map((c) => (
                <button key={c.id} type="button" onClick={() => setCustomer(c)} className="block w-full rounded-lg px-3 py-1.5 text-left text-sm hover:bg-zinc-100">
                  {c.name} <span className="text-zinc-500">{phone(c.phone)}</span>
                </button>
              ))}
            </Field>
          )}

          <div className="space-y-2">
            {lines.map((l) => (
              <div key={l.key} className="rounded-xl ring-1 ring-zinc-200 px-3 py-2">
                <div className="flex items-center gap-2">
                  <p className="min-w-0 flex-1 font-medium">{l.name}</p>
                  <span className="font-semibold whitespace-nowrap tabular-nums">{money(l.unit_price_cents * l.qty)}</span>
                  <button onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="text-zinc-400 hover:text-red-600" aria-label="Remover item">
                    <Trash2 className="size-4" />
                  </button>
                </div>
                {(() => {
                  const left = l.catalog_item_id ? data.catalog.find((c) => c.id === l.catalog_item_id)?.available : null;
                  if (left == null) return null;
                  // Mesma linha de produto somada (ex.: 2 linhas de cerveja).
                  const asked = lines.filter((x) => x.catalog_item_id === l.catalog_item_id).reduce((s, x) => s + x.qty, 0);
                  return (
                    <p className={`text-xs ${asked > left ? 'font-medium text-red-600' : 'text-zinc-500'}`}>
                      {asked > left ? `Estoque do sistema: ${Math.max(left, 0)}. Confira e ajuste o estoque depois.` : `${left} em estoque`}
                    </p>
                  );
                })()}
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                  <div className="flex items-center rounded-lg ring-1 ring-zinc-200">
                    <button className="p-1.5" onClick={() => update(l.key, { qty: Math.max(1, l.qty - 1) })} aria-label="Menos">
                      <Minus className="size-3.5" />
                    </button>
                    <span className="w-6 text-center font-semibold tabular-nums">{l.qty}</span>
                    <button className="p-1.5" onClick={() => update(l.key, { qty: Math.min(99, l.qty + 1) })} aria-label="Mais">
                      <Plus className="size-3.5" />
                    </button>
                  </div>
                  <span className="text-zinc-500">× {money(l.unit_price_cents)}</span>
                  <select
                    className="ml-auto rounded-md border border-zinc-300 px-1.5 py-1 text-xs"
                    value={l.barber_id ?? ''}
                    onChange={(e) => update(l.key, { barber_id: e.target.value ? Number(e.target.value) : null })}
                    aria-label="Quem atendeu ou vendeu"
                  >
                    <option value="">Sem comissão</option>
                    {data.barbers.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ))}
            <select className={inputClass} value={adding} onChange={(e) => addItem(e.target.value)}>
              <option value="">+ Adicionar serviço ou produto</option>
              <optgroup label="Serviços">
                {data.catalog
                  .filter((c) => c.kind === 'service')
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {money(c.price_cents)}
                    </option>
                  ))}
              </optgroup>
              <optgroup label="Produtos">
                {data.catalog
                  .filter((c) => c.kind === 'product')
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {money(c.price_cents)}
                      {c.available != null ? (c.available > 0 ? ` · ${c.available} em estoque` : ' · esgotado') : ''}
                    </option>
                  ))}
              </optgroup>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Desconto (R$)">
              <Input inputMode="decimal" placeholder="0,00" value={discount} onChange={(e) => setDiscount(e.target.value)} />
            </Field>
            <Field label="Observação">
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>

          <div>
            <p className="mb-1 text-sm font-medium text-zinc-700">Forma de pagamento</p>
            <div className="flex flex-wrap gap-2">
              {METHODS.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMethod(m.id)}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium ring-1 ${method === m.id ? 'bg-zinc-900 text-white ring-zinc-900' : 'ring-zinc-200 hover:bg-zinc-100'}`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1 rounded-xl bg-zinc-50 px-4 py-3 text-sm">
            <p className="flex justify-between">
              <span>Subtotal</span> <span className="tabular-nums">{money(subtotal)}</span>
            </p>
            {discountCents > 0 && (
              <p className="flex justify-between text-zinc-500">
                <span>Desconto</span> <span className="tabular-nums">− {money(discountCents)}</span>
              </p>
            )}
            <p className="flex justify-between text-lg font-bold">
              <span>Total</span> <span className="tabular-nums">{money(total)}</span>
            </p>
          </div>
          <ErrorText error={error} />
          <Button className="w-full" loading={busy} disabled={!lines.length} onClick={submit}>
            Registrar {money(total)} em {METHODS.find((m) => m.id === method)?.label}
          </Button>
        </div>
      )}
    </Modal>
  );
}
