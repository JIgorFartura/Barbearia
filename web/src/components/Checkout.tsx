import { CheckCircle2, Gift, Minus, Plus, Search, Trash2 } from 'lucide-react';
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
    /** Horário vazio: o preço acima já tem o desconto. */
    promo_percent: number | null;
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
  /** Coberto pelo clube de assinatura do cliente (sai por R$ 0). */
  club?: boolean;
  /** Desconto do horário vazio já aplicado no preço. */
  promo?: number;
  /** Pacote pré-pago do cliente usado nesta linha (sai por R$ 0). */
  pack?: number | null;
}

/** Pacote pré-pago do cliente, valendo. */
interface CustomerPack {
  id: number;
  name: string;
  service_id: number;
  left: number;
  uses: number;
  expires_on: string;
}

/** O que o clube de assinatura do cliente cobre hoje. */
interface Coverage {
  plan: string;
  itemIds: number[];
  limit: number | null;
  left: number | null;
  periodEnd: string;
}

export interface SaleResult {
  sale: { id: number; total_cents: number; gift_cents: number };
  stamps: { campaign: string; qty: number; unit: string; available: number }[];
}

let nextKey = 1;

/** Endereços da comanda: o painel do dono ou a área do barbeiro. */
export interface CheckoutEndpoints {
  checkout: string;
  sales: string;
  customers: string;
  club: string;
  giftCards: string;
}

const OWNER: CheckoutEndpoints = {
  checkout: '/api/shop/finance/checkout',
  sales: '/api/shop/finance/sales',
  customers: '/api/shop/customers',
  club: '/api/shop/finance/club',
  giftCards: '/api/shop/gift-cards',
};

/**
 * Fechar o atendimento (ou uma venda de balcão): itens, quem atendeu, desconto e forma de pagamento.
 * Gera a entrada no caixa, a comissão do barbeiro e os carimbos das campanhas.
 */
export function CheckoutModal({
  appointmentId,
  customer: presetCustomer,
  onClose,
  onDone,
  endpoints = OWNER,
}: {
  appointmentId?: number;
  customer?: { id: number; name: string } | null;
  onClose: () => void;
  onDone: () => void;
  endpoints?: CheckoutEndpoints;
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
  const [club, setClub] = useState<Coverage | null>(null);
  const [packs, setPacks] = useState<CustomerPack[]>([]);
  const [giftInput, setGiftInput] = useState('');
  const [gift, setGift] = useState<{ code: string; balance: number } | null>(null);
  const [giftError, setGiftError] = useState<string | null>(null);
  const [result, setResult] = useState<SaleResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<CheckoutData>('GET', `${endpoints.checkout}${appointmentId ? `?appointment_id=${appointmentId}` : ''}`).then((d) => {
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
          // Horário vazio: o preço combinado na hora de marcar (com o desconto).
          unit_price_cents: a.promo_percent ? a.price_cents : (service?.price_cents ?? a.price_cents),
          barber_id: a.barber_id,
          promo: a.promo_percent ?? undefined,
        },
        // O que o cliente pediu para deixar separado já entra na comanda.
        ...d.reserved.map((r) => {
          const p = d.catalog.find((c) => c.id === r.catalog_item_id);
          return { key: nextKey++, catalog_item_id: r.catalog_item_id, kind: 'product' as const, name: r.name, qty: r.qty, unit_price_cents: p?.price_cents ?? 0, barber_id: a.barber_id };
        }),
      ];
      setLines(initial);
    }, (e) => setError(e.message));
  }, [appointmentId, endpoints.checkout]);

  useEffect(() => {
    if (customer || !q.trim()) {
      setFound([]);
      return;
    }
    const t = setTimeout(() => api<typeof found>('GET', `${endpoints.customers}?q=${encodeURIComponent(q)}`).then((r) => setFound(r.slice(0, 5))), 250);
    return () => clearTimeout(t);
  }, [q, customer, endpoints.customers]);

  // Assinante do clube: o que o plano cobre já entra por R$ 0, até o limite do mês. Pacote pré-pago:
  // o serviço do pacote entra "pelo pacote" (o clube tem a vez, para não gastar uso do pacote à toa).
  useEffect(() => {
    setClub(null);
    setPacks([]);
    if (!customer) {
      setLines((ls) => ls.map((l) => ({ ...l, club: false, pack: null })));
      return;
    }
    let alive = true;
    Promise.all([
      api<Coverage | null>('GET', `${endpoints.club}?customer_id=${customer.id}`).catch(() => null),
      api<CustomerPack[]>('GET', `${endpoints.customers}/${customer.id}/packages`).catch(() => []),
    ]).then(([c, p]) => {
      if (!alive) return;
      setClub(c);
      setPacks(p);
      let left = c?.left ?? Infinity;
      const packLeft = new Map(p.map((x) => [x.id, x.left]));
      setLines((ls) =>
        ls.map((l) => {
          const covered = Boolean(c && l.catalog_item_id && c.itemIds.includes(l.catalog_item_id) && l.qty <= left);
          if (covered) {
            left -= l.qty;
            return { ...l, club: true, pack: null };
          }
          const pack = p.find((x) => x.service_id === l.catalog_item_id && (packLeft.get(x.id) ?? 0) >= l.qty);
          if (pack) packLeft.set(pack.id, packLeft.get(pack.id)! - l.qty);
          return { ...l, club: false, pack: pack?.id ?? null };
        }),
      );
    });
    return () => {
      alive = false;
    };
  }, [customer, endpoints.club, endpoints.customers]);

  /** Usos que sobram em cada pacote, descontando as linhas desta comanda. */
  const packLeft = (id: number) => (packs.find((p) => p.id === id)?.left ?? 0) - lines.filter((l) => l.pack === id).reduce((s, l) => s + l.qty, 0);
  const packFor = (l: Line) => packs.find((p) => p.service_id === l.catalog_item_id && (l.pack === p.id || packLeft(p.id) >= l.qty)) ?? null;

  async function applyGift() {
    setGiftError(null);
    try {
      const g = await api<{ code: string; balance_cents: number; status: string; expires_on: string }>('GET', `${endpoints.giftCards}/${encodeURIComponent(giftInput.trim())}`);
      if (g.status !== 'active' || g.balance_cents <= 0) throw new Error(g.status === 'expired' ? 'Esse vale-presente venceu.' : 'Esse vale-presente não tem mais saldo.');
      setGift({ code: g.code, balance: g.balance_cents });
    } catch (err) {
      setGift(null);
      setGiftError((err as Error).message);
    }
  }

  const defaultBarber = data?.appointment?.barber_id ?? data?.barbers[0]?.id ?? null;
  const free = (l: Line) => l.club || Boolean(l.pack);
  const price = (l: Line) => (free(l) ? 0 : l.unit_price_cents * l.qty);
  const subtotal = useMemo(() => lines.reduce((s, l) => s + (l.club || l.pack ? 0 : l.unit_price_cents * l.qty), 0), [lines]);
  const clubQty = lines.filter((l) => l.club).reduce((s, l) => s + l.qty, 0);
  const clubOver = club?.left != null && clubQty > club.left;
  const coveredBy = (l: Line) => Boolean(club && l.catalog_item_id && club.itemIds.includes(l.catalog_item_id));
  const discountCents = Math.min(parseMoney(discount), subtotal);
  const total = subtotal - discountCents;
  // Vale-presente: paga até o saldo dele; o resto vai na forma de pagamento escolhida.
  const giftCents = gift ? Math.min(gift.balance, total) : 0;
  const toPay = total - giftCents;

  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  function addItem(id: string) {
    const c = data?.catalog.find((x) => String(x.id) === id);
    if (!c) return;
    const left = club?.left == null ? Infinity : club.left - clubQty;
    const covered = Boolean(club?.itemIds.includes(c.id) && left >= 1);
    const pack = covered ? null : packs.find((p) => p.service_id === c.id && packLeft(p.id) >= 1);
    setLines((ls) => [
      ...ls,
      { key: nextKey++, catalog_item_id: c.id, kind: c.kind, name: c.name, qty: 1, unit_price_cents: c.price_cents, barber_id: defaultBarber, club: covered, pack: pack?.id ?? null },
    ]);
    setAdding('');
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<SaleResult>('POST', endpoints.sales, {
        appointment_id: appointmentId ?? null,
        customer_id: appointmentId ? null : (customer?.id ?? null),
        items: lines.map((l) => ({
          catalog_item_id: l.catalog_item_id,
          name: l.catalog_item_id ? null : l.name,
          kind: l.kind,
          qty: l.qty,
          unit_price_cents: l.unit_price_cents,
          barber_id: l.barber_id,
          club: l.club || null,
          package_id: l.pack || null,
        })),
        discount_cents: discountCents,
        gift_code: giftCents > 0 ? gift!.code : null,
        gift_cents: giftCents > 0 ? giftCents : null,
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
          {result.sale.gift_cents > 0 && (
            <p className="text-sm text-zinc-600">
              {money(result.sale.gift_cents)} pagos com o vale-presente{gift && gift.balance - result.sale.gift_cents > 0 ? ` (sobrou ${money(gift.balance - result.sale.gift_cents)} no vale)` : ''}.
            </p>
          )}
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

          {club && (
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-950 ring-1 ring-amber-200">
              👑 Assinante do clube <b>{club.plan}</b>:{' '}
              {club.left == null ? 'uso à vontade' : `${Math.max(club.left - clubQty, 0)} de ${club.limit} usos sobrando no mês`} (vale até{' '}
              {club.periodEnd.split('-').reverse().slice(0, 2).join('/')}).
            </p>
          )}

          <div className="space-y-2">
            {lines.map((l) => (
              <div key={l.key} className="rounded-xl ring-1 ring-zinc-200 px-3 py-2">
                <div className="flex items-center gap-2">
                  <p className="min-w-0 flex-1 font-medium">{l.name}</p>
                  {free(l) && <span className="text-xs whitespace-nowrap text-zinc-400 line-through tabular-nums">{money(l.unit_price_cents * l.qty)}</span>}
                  <span className="font-semibold whitespace-nowrap tabular-nums">{money(price(l))}</span>
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
                  {l.promo && !free(l) && <span className="text-xs font-medium text-emerald-700">horário vazio −{l.promo}%</span>}
                  {!l.club &&
                    (() => {
                      const p = packFor(l);
                      if (!p) return null;
                      return (
                        <button
                          type="button"
                          onClick={() => update(l.key, { pack: l.pack ? null : p.id })}
                          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${l.pack ? 'bg-sky-100 text-sky-900 ring-sky-300' : 'text-zinc-500 ring-zinc-200 hover:bg-zinc-100'}`}
                          aria-pressed={Boolean(l.pack)}
                        >
                          {l.pack ? `✓ Pelo pacote (sobram ${packLeft(p.id)})` : `Usar o pacote (${packLeft(p.id)})`}
                        </button>
                      );
                    })()}
                  {coveredBy(l) && !l.pack && (
                    <button
                      type="button"
                      onClick={() => update(l.key, { club: !l.club })}
                      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${l.club ? 'bg-amber-100 text-amber-900 ring-amber-300' : 'text-zinc-500 ring-zinc-200 hover:bg-zinc-100'}`}
                      aria-pressed={Boolean(l.club)}
                    >
                      {l.club ? '✓ Pelo clube' : 'Usar o clube'}
                    </button>
                  )}
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

          {gift ? (
            <p className="flex items-center justify-between gap-2 rounded-xl bg-violet-50 px-3 py-2 text-sm text-violet-950 ring-1 ring-violet-200">
              <span>
                <Gift className="mb-0.5 inline size-4" /> Vale <b>{gift.code}</b>: saldo {money(gift.balance)}
              </span>
              <button type="button" className="text-violet-700 underline" onClick={() => setGift(null)}>
                Tirar
              </button>
            </p>
          ) : (
            <div>
              <div className="flex gap-2">
                <Input placeholder="Vale-presente (código)" value={giftInput} onChange={(e) => setGiftInput(e.target.value.toUpperCase())} aria-label="Código do vale-presente" />
                <Button type="button" variant="ghost" disabled={giftInput.trim().length < 4} onClick={applyGift}>
                  Usar vale
                </Button>
              </div>
              {giftError && <p className="mt-1 text-xs text-red-600">{giftError}</p>}
            </div>
          )}

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
            {giftCents > 0 && (
              <>
                <p className="flex justify-between text-violet-800">
                  <span>Pago com o vale-presente</span> <span className="tabular-nums">− {money(giftCents)}</span>
                </p>
                <p className="flex justify-between font-semibold">
                  <span>Falta pagar</span> <span className="tabular-nums">{money(toPay)}</span>
                </p>
              </>
            )}
          </div>
          <ErrorText error={error ?? (clubOver ? `O plano ${club!.plan} só tem mais ${club!.left} ${club!.left === 1 ? 'uso' : 'usos'} neste mês.` : null)} />
          <Button className="w-full" loading={busy} disabled={!lines.length || clubOver} onClick={submit}>
            {toPay > 0 || !giftCents ? `Registrar ${money(toPay)} em ${METHODS.find((m) => m.id === method)?.label}` : 'Registrar (pago com o vale-presente)'}
          </Button>
        </div>
      )}
    </Modal>
  );
}
