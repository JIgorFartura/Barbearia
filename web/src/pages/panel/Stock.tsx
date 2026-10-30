import { AlertTriangle, Boxes, PackagePlus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, EmptyState, ErrorText, Field, Input, Modal, inputClass } from '../../components/ui';
import { api } from '../../lib/api';
import { METHODS, centsToInput, parseMoney } from '../../lib/finance';
import { money, todayStr } from '../../lib/format';

interface Item {
  id: number;
  name: string;
  price_cents: number;
  cost_cents: number | null;
  active: number;
  track_stock: number;
  stock_qty: number;
  stock_min: number | null;
  reserved: number;
  available: number;
  low: boolean;
}

interface MoveRow {
  id: number;
  catalog_item_id: number;
  name: string;
  qty: number;
  kind: 'venda' | 'cancelamento' | 'compra' | 'ajuste' | 'perda' | 'uso';
  notes: string | null;
  created_at: string;
}

const KIND: Record<MoveRow['kind'], string> = {
  venda: 'Venda',
  cancelamento: 'Venda cancelada',
  compra: 'Entrada',
  ajuste: 'Contagem',
  perda: 'Perda',
  uso: 'Uso interno',
};

/** Estoque: quanto tem de cada produto, entradas de mercadoria, ajustes e histórico. */
export function Stock() {
  const [data, setData] = useState<{ items: Item[]; moves: MoveRow[] } | null>(null);
  const [entry, setEntry] = useState<number | 'new' | null>(null);
  const [adjusting, setAdjusting] = useState<Item | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<{ items: Item[]; moves: MoveRow[] }>('GET', '/api/shop/stock').then(setData, (e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  if (!data) return <ErrorText error={error} />;
  const tracked = data.items.filter((i) => i.track_stock);
  const untracked = data.items.filter((i) => !i.track_stock);
  const low = tracked.filter((i) => i.low && i.active);

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Boxes className="size-6" /> Estoque
          </h1>
          <p className="text-sm text-zinc-500">A venda dá baixa sozinha. Lance aqui as compras de mercadoria e as perdas.</p>
        </div>
        <Button onClick={() => setEntry('new')} disabled={!data.items.length}>
          <PackagePlus className="size-4" /> Entrada de mercadoria
        </Button>
      </div>

      {low.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            <b>Acabando:</b> {low.map((i) => `${i.name} (${i.stock_qty})`).join(', ')}. Hora de repor.
          </span>
        </div>
      )}

      {!data.items.length && <EmptyState icon={<Boxes className="size-6" />} title="Nenhum produto cadastrado" text="Cadastre os produtos em Produtos e depois lance a entrada aqui." />}

      {tracked.length > 0 && (
        <Card className="!p-0">
          <ul className="divide-y divide-zinc-100 text-sm">
            {tracked.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-1 basis-48">
                  <p className="font-medium">
                    {i.name} {!i.active && <Badge>Oculto</Badge>}
                  </p>
                  <p className="text-xs text-zinc-500">
                    Venda {money(i.price_cents)}
                    {i.cost_cents ? ` · custo ${money(i.cost_cents)}` : ''}
                    {i.stock_min != null ? ` · mínimo ${i.stock_min}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-4 text-center">
                  <span>
                    <b className={`block text-lg tabular-nums ${i.stock_qty < 0 ? 'text-red-600' : ''}`}>{i.stock_qty}</b>
                    <span className="text-xs text-zinc-500">na prateleira</span>
                  </span>
                  {i.reserved > 0 && (
                    <span>
                      <b className="block text-lg tabular-nums text-amber-700">{i.reserved}</b>
                      <span className="text-xs text-zinc-500">separado</span>
                    </span>
                  )}
                  {i.low && <Badge tone="red">Repor</Badge>}
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" className="!px-3 !py-1.5" onClick={() => setEntry(i.id)}>
                    <PackagePlus className="size-4" /> Entrada
                  </Button>
                  <Button variant="ghost" className="!px-3 !py-1.5" onClick={() => setAdjusting(i)}>
                    <SlidersHorizontal className="size-4" /> Ajustar
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {untracked.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-semibold">Sem controle de estoque</p>
          <p className="mb-2 text-xs text-zinc-500">Lance uma entrada para começar a controlar (a quantidade passa a baixar sozinha nas vendas).</p>
          <div className="flex flex-wrap gap-2">
            {untracked.map((i) => (
              <button key={i.id} className="rounded-full bg-white px-3 py-1.5 text-sm ring-1 ring-zinc-200 hover:bg-zinc-100" onClick={() => setEntry(i.id)}>
                {i.name} · controlar
              </button>
            ))}
          </div>
        </div>
      )}

      {data.moves.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-semibold">Movimentações recentes</p>
          <Card className="!p-0">
            <ul className="divide-y divide-zinc-100 text-sm">
              {data.moves.slice(0, 30).map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-2">
                  <span className="min-w-0">
                    <span className="font-medium">{m.name}</span>{' '}
                    <span className="text-zinc-500">
                      · {KIND[m.kind]}
                      {m.notes ? ` · ${m.notes}` : ''} · {new Date(m.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                    </span>
                  </span>
                  <b className={`shrink-0 tabular-nums ${m.qty < 0 ? 'text-zinc-700' : 'text-emerald-700'}`}>
                    {m.qty > 0 ? '+' : '−'}
                    {Math.abs(m.qty)}
                  </b>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {entry && (
        <EntryModal
          items={data.items}
          initial={entry === 'new' ? null : entry}
          onClose={() => setEntry(null)}
          onDone={() => {
            setEntry(null);
            load();
          }}
        />
      )}
      {adjusting && (
        <AdjustModal
          item={adjusting}
          onClose={() => setAdjusting(null)}
          onDone={() => {
            setAdjusting(null);
            load();
          }}
        />
      )}
    </section>
  );
}

interface Line {
  key: number;
  id: number;
  qty: string;
  cost: string;
}
let nextKey = 1;

function EntryModal({ items, initial, onClose, onDone }: { items: Item[]; initial: number | null; onClose: () => void; onDone: () => void }) {
  const start = (id: number): Line => ({ key: nextKey++, id, qty: '', cost: centsToInput(items.find((i) => i.id === id)?.cost_cents ?? 0) });
  const [lines, setLines] = useState<Line[]>([start(initial ?? items[0].id)]);
  const [supplier, setSupplier] = useState('');
  const [cash, setCash] = useState<'paid' | 'pending' | 'none'>('paid');
  const [date, setDate] = useState(todayStr());
  const [method, setMethod] = useState('pix');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const total = lines.reduce((s, l) => s + (Number(l.qty) || 0) * parseMoney(l.cost), 0);
  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/shop/stock/entries', {
        items: lines.map((l) => ({ catalog_item_id: l.id, qty: Number(l.qty), unit_cost_cents: l.cost ? parseMoney(l.cost) : null })),
        supplier: supplier || null,
        cash: cash === 'none' ? null : { status: cash, date, method: cash === 'paid' ? method : null },
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Entrada de mercadoria" onClose={onClose}>
      <div className="space-y-4">
        {lines.map((l) => (
          <div key={l.key} className="grid grid-cols-[1fr_4.5rem_6rem_auto] items-end gap-2">
            <Field label="Produto">
              <select className={inputClass} value={l.id} onChange={(e) => update(l.key, { id: Number(e.target.value) })}>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Qtd.">
              <Input inputMode="numeric" value={l.qty} onChange={(e) => update(l.key, { qty: e.target.value.replace(/\D/g, '') })} />
            </Field>
            <Field label="Custo (R$)">
              <Input inputMode="decimal" value={l.cost} onChange={(e) => update(l.key, { cost: e.target.value })} />
            </Field>
            <button
              type="button"
              className="mb-2.5 text-zinc-400 hover:text-red-600 disabled:opacity-30"
              disabled={lines.length === 1}
              onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
              aria-label="Remover"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
        <button type="button" className="text-sm font-medium text-zinc-600 hover:text-zinc-900" onClick={() => setLines((ls) => [...ls, start(items[0].id)])}>
          + Outro produto
        </button>
        <Field label="Fornecedor (opcional)">
          <Input value={supplier} onChange={(e) => setSupplier(e.target.value)} />
        </Field>
        <div className="space-y-2 rounded-xl bg-zinc-50 p-3 text-sm">
          <p className="font-medium">Lançar a compra no caixa ({money(total)})</p>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ['paid', 'Já paguei'],
                ['pending', 'Conta a pagar'],
                ['none', 'Não lançar'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setCash(id)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium ring-1 ${cash === id ? 'bg-zinc-900 text-white ring-zinc-900' : 'bg-white ring-zinc-200 hover:bg-zinc-100'}`}
              >
                {label}
              </button>
            ))}
          </div>
          {cash !== 'none' && (
            <div className="grid grid-cols-2 gap-2">
              <Field label={cash === 'paid' ? 'Pago em' : 'Vence em'}>
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
              {cash === 'paid' && (
                <Field label="Forma">
                  <select className={inputClass} value={method} onChange={(e) => setMethod(e.target.value)}>
                    {METHODS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
          )}
        </div>
        <ErrorText error={error} />
        <Button className="w-full" loading={busy} disabled={lines.some((l) => !Number(l.qty))} onClick={submit}>
          Dar entrada
        </Button>
      </div>
    </Modal>
  );
}

function AdjustModal({ item, onClose, onDone }: { item: Item; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<'ajuste' | 'perda' | 'uso'>('ajuste');
  const [qty, setQty] = useState(kind === 'ajuste' ? String(item.stock_qty) : '');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`Ajustar · ${item.name}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {(
            [
              ['ajuste', 'Contagem'],
              ['perda', 'Perda / quebra'],
              ['uso', 'Uso interno'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setKind(id);
                setQty(id === 'ajuste' ? String(item.stock_qty) : '');
              }}
              className={`rounded-full px-3 py-1.5 text-sm font-medium ring-1 ${kind === id ? 'bg-zinc-900 text-white ring-zinc-900' : 'ring-zinc-200 hover:bg-zinc-100'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <Field label={kind === 'ajuste' ? 'Quantidade que tem na prateleira' : 'Quantas unidades saíram'} hint={kind === 'ajuste' ? `O sistema mostra ${item.stock_qty}.` : undefined}>
          <Input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} />
        </Field>
        <Field label="Observação (opcional)">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <ErrorText error={error} />
        <Button
          className="w-full"
          disabled={qty === ''}
          onClick={() => api('POST', `/api/shop/stock/${item.id}/adjust`, { kind, qty: Number(qty), notes: notes || null }).then(onDone, (e) => setError(e.message))}
        >
          Salvar
        </Button>
      </div>
    </Modal>
  );
}
