import { Gift, Package, Search } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { CrudPage, type Row } from '../../components/CrudPage';
import { CopyField } from '../../components/CopyField';
import { Badge, Button, Card, ErrorText, Field, Input, Modal, inputClass } from '../../components/ui';
import { api } from '../../lib/api';
import { METHODS, parseMoney, type Method } from '../../lib/finance';
import { date, money, phone } from '../../lib/format';

interface SoldPackage {
  id: number;
  name: string;
  service_name: string | null;
  uses: number;
  used: number;
  left: number;
  price_cents: number;
  expires_on: string;
  status: 'active' | 'used' | 'expired' | 'cancelled';
  customer_name: string;
  customer_phone: string;
}

interface GiftCard {
  id: number;
  code: string;
  amount_cents: number;
  balance_cents: number;
  buyer_name: string | null;
  recipient_name: string | null;
  message: string | null;
  expires_on: string;
  status: 'active' | 'used' | 'expired' | 'cancelled';
}

const STATUS: Record<SoldPackage['status'], [string, 'green' | 'zinc' | 'red' | 'gold']> = {
  active: ['Valendo', 'green'],
  used: ['Usado', 'zinc'],
  expired: ['Venceu', 'gold'],
  cancelled: ['Cancelado', 'red'],
};

function MethodPicker({ value, onChange }: { value: Method; onChange: (m: Method) => void }) {
  return (
    <div>
      <p className="mb-1 text-sm font-medium text-zinc-700">Forma de pagamento</p>
      <div className="flex flex-wrap gap-2">
        {METHODS.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => onChange(m.id)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium ring-1 ${value === m.id ? 'bg-zinc-900 text-white ring-zinc-900' : 'ring-zinc-200 hover:bg-zinc-100'}`}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Vender um pacote: escolhe o cliente, o pacote e a forma de pagamento. */
function SellPackageModal({ packages, onClose, onDone }: { packages: Row[]; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ id: number; name: string; phone: string }[]>([]);
  const [customer, setCustomer] = useState<{ id: number; name: string } | null>(null);
  const [packageId, setPackageId] = useState<number | null>(packages[0]?.id ?? null);
  const [method, setMethod] = useState<Method>('pix');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (customer || !q.trim()) return setFound([]);
    const t = setTimeout(() => api<typeof found>('GET', `/api/shop/customers?q=${encodeURIComponent(q)}`).then((r) => setFound(r.slice(0, 5))), 250);
    return () => clearTimeout(t);
  }, [q, customer]);
  const pack = packages.find((p) => p.id === packageId);

  async function sell() {
    if (!customer || !packageId) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/shop/packages/sell', { customer_id: customer.id, package_id: packageId, method });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Vender pacote" onClose={onClose}>
      <div className="space-y-4">
        {customer ? (
          <p className="flex items-center justify-between rounded-xl bg-zinc-50 px-3 py-2 text-sm">
            <b>{customer.name}</b>
            <button className="text-zinc-500 hover:text-zinc-900" onClick={() => setCustomer(null)}>
              Trocar
            </button>
          </p>
        ) : (
          <Field label="Cliente">
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
        <Field label="Pacote">
          <select className={inputClass} value={packageId ?? ''} onChange={(e) => setPackageId(Number(e.target.value))}>
            {packages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {money(p.price_cents)} · {p.uses} usos
              </option>
            ))}
          </select>
        </Field>
        {pack && (
          <p className="text-sm text-zinc-500">
            {money(Math.round(pack.price_cents / pack.uses))} por uso · vale {pack.valid_days} dias. O cliente vê os usos que sobram na área dele e o barbeiro marca “pelo pacote” na
            comanda.
          </p>
        )}
        <MethodPicker value={method} onChange={setMethod} />
        <ErrorText error={error} />
        <Button className="w-full" loading={busy} disabled={!customer || !pack} onClick={sell}>
          Registrar {pack ? money(pack.price_cents) : ''}
        </Button>
      </div>
    </Modal>
  );
}

/** Vender um vale-presente: valor, de quem, para quem e a mensagem; sai com o código para mandar. */
function SellGiftModal({ shopName, onClose, onDone }: { shopName: string; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ amount: '100,00', buyer: '', recipient: '', message: '', days: 180 });
  const [method, setMethod] = useState<Method>('pix');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [card, setCard] = useState<GiftCard | null>(null);

  async function sell() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ card: GiftCard }>('POST', '/api/shop/gift-cards', {
        amount_cents: parseMoney(form.amount),
        valid_days: form.days,
        buyer_name: form.buyer || null,
        recipient_name: form.recipient || null,
        message: form.message || null,
        method,
      });
      setCard(r.card);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (card) {
    const text = [
      `🎁 Vale-presente da ${shopName}${card.recipient_name ? ` para ${card.recipient_name}` : ''}${card.buyer_name ? `, de ${card.buyer_name}` : ''}!`,
      card.message ? `"${card.message}"` : '',
      `Valor: ${money(card.amount_cents)} · Código: ${card.code}`,
      `Vale até ${date(card.expires_on)}. É só mostrar o código no balcão.`,
    ]
      .filter(Boolean)
      .join('\n');
    return (
      <Modal title="Vale-presente pronto! 🎁" onClose={onDone}>
        <div className="space-y-4 text-center">
          <p className="rounded-2xl bg-violet-50 px-4 py-5 ring-1 ring-violet-200">
            <span className="block text-sm text-violet-800">{money(card.amount_cents)}</span>
            <span className="block font-mono text-3xl font-bold tracking-widest text-violet-950">{card.code}</span>
            <span className="block text-xs text-violet-800">vale até {date(card.expires_on)}</span>
          </p>
          <CopyField label="Mensagem para mandar" value={text.replace(/\n/g, ' ')} />
          <a href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer" className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
            Mandar pelo WhatsApp
          </a>
          <Button variant="ghost" className="w-full" onClick={onDone}>
            Concluir
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Vender vale-presente" onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Valor (R$)">
            <Input inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </Field>
          <Field label="Vale por (dias)">
            <Input type="number" min={30} max={730} value={form.days} onChange={(e) => setForm({ ...form, days: Number(e.target.value) || 180 })} />
          </Field>
          <Field label="De (quem dá)">
            <Input value={form.buyer} onChange={(e) => setForm({ ...form, buyer: e.target.value })} placeholder="Ex.: Mariana" />
          </Field>
          <Field label="Para (quem ganha)">
            <Input value={form.recipient} onChange={(e) => setForm({ ...form, recipient: e.target.value })} placeholder="Ex.: Rafael" />
          </Field>
        </div>
        <Field label="Mensagem (opcional)">
          <Input maxLength={200} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} placeholder="Feliz aniversário! Capricha no visual." />
        </Field>
        <MethodPicker value={method} onChange={setMethod} />
        <ErrorText error={error} />
        <Button className="w-full" loading={busy} disabled={parseMoney(form.amount) < 1000} onClick={sell}>
          Registrar {money(parseMoney(form.amount))} e gerar o código
        </Button>
      </div>
    </Modal>
  );
}

/** Pacotes pré-pagos e vale-presente: vender, acompanhar e cadastrar os pacotes. */
export function Prepaid({ shopName }: { shopName: string }) {
  const [tab, setTab] = useState<'vendas' | 'cadastro'>('vendas');
  const [catalog, setCatalog] = useState<Row[]>([]);
  const [packages, setPackages] = useState<Row[]>([]);
  const [sold, setSold] = useState<{ packages: SoldPackage[]; giftCards: GiftCard[] } | null>(null);
  const [selling, setSelling] = useState<'pacote' | 'vale' | null>(null);
  const [lookup, setLookup] = useState('');
  const [found, setFound] = useState<GiftCard | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<typeof sold>('GET', '/api/shop/prepaid').then(setSold, (e) => setError(e.message));
    api<Row[]>('GET', '/api/shop/packages').then(setPackages, () => undefined);
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    api<Row[]>('GET', '/api/shop/catalog').then(setCatalog, () => undefined);
  }, []);
  const services = catalog.filter((c) => c.kind === 'service');
  const forSale = packages.filter((p) => p.active);

  async function check() {
    setError(null);
    setFound(null);
    await api<GiftCard>('GET', `/api/shop/gift-cards/${encodeURIComponent(lookup.trim())}`).then(setFound, (e) => setError(e.message));
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Pacotes e vale-presente</h1>
          <p className="text-sm text-zinc-500">O dinheiro entra no caixa na venda; depois, o pacote e o vale pagam os atendimentos na comanda.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" disabled={!forSale.length} onClick={() => setSelling('pacote')} title={forSale.length ? undefined : 'Cadastre um pacote primeiro'}>
            <Package className="size-4" /> Vender pacote
          </Button>
          <Button onClick={() => setSelling('vale')}>
            <Gift className="size-4" /> Vender vale-presente
          </Button>
        </div>
      </div>
      <div className="flex gap-1.5">
        {(
          [
            ['vendas', 'Vendidos'],
            ['cadastro', `Pacotes à venda (${packages.length})`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium ring-1 ${tab === id ? 'bg-zinc-900 text-white ring-zinc-900' : 'bg-white ring-zinc-200 hover:bg-zinc-100'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <ErrorText error={error} />

      {tab === 'cadastro' ? (
        <CrudPage
          title="Pacotes à venda"
          description="Ex.: 5 cortes por R$ 200 (o cliente paga de uma vez e economiza). Cada uso sai por R$ 0 na comanda, e o barbeiro recebe a comissão sobre o valor de cada uso."
          endpoint="/api/shop/packages"
          newLabel="Novo pacote"
          defaults={{ active: true, uses: 5, valid_days: 180, service_id: services[0]?.id ?? null }}
          empty={{ icon: <Package className="size-6" />, title: 'Nenhum pacote ainda', text: 'Crie o primeiro: “5 cortes”, “4 barbas”, “corte + barba ×4”.' }}
          onChange={load}
          fields={[
            { key: 'name', label: 'Nome do pacote', type: 'text', required: true, placeholder: '5 cortes' },
            { key: 'service_id', label: 'Serviço', type: 'select', options: services.map((s) => ({ value: s.id, label: `${s.name} · ${money(s.price_cents)}` })) },
            { key: 'uses', label: 'Quantos usos', type: 'number', required: true },
            { key: 'price_cents', label: 'Preço do pacote (R$)', type: 'money', required: true },
            { key: 'valid_days', label: 'Vale por (dias)', type: 'number', required: true },
            { key: 'description', label: 'Descrição (opcional)', type: 'textarea' },
            { key: 'active', label: 'À venda', type: 'checkbox' },
          ]}
          renderItem={(r) => {
            const service = services.find((s) => s.id === r.service_id);
            const full = service ? service.price_cents * r.uses : 0;
            return (
              <>
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold">{r.name}</p>
                  <Badge tone={r.active ? 'green' : 'zinc'}>{r.active ? 'À venda' : 'Fora de venda'}</Badge>
                </div>
                <p className="mt-1 text-sm">
                  <b>{money(r.price_cents)}</b> por {r.uses}× {service?.name.toLowerCase() ?? 'serviço'}
                  {full > r.price_cents && <span className="text-emerald-700"> · economia de {money(full - r.price_cents)}</span>}
                </p>
                <p className="mt-1 text-xs text-zinc-500">Vale {r.valid_days} dias depois da compra.</p>
              </>
            );
          }}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="min-w-0 space-y-3">
            <p className="flex items-center gap-2 font-semibold">
              <Package className="size-5 text-zinc-400" /> Pacotes dos clientes
            </p>
            {!sold?.packages.length ? (
              <p className="text-sm text-zinc-500">Nenhum pacote vendido ainda.</p>
            ) : (
              <ul className="divide-y divide-zinc-100 text-sm">
                {sold.packages.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                    <span className="min-w-0">
                      <b>{p.customer_name}</b> <span className="text-zinc-500">· {p.name}</span>
                      <span className="block text-xs text-zinc-500">
                        {p.status === 'active' ? `${p.left} de ${p.uses} sobrando · até ${date(p.expires_on)}` : `${p.used} de ${p.uses} usados`}
                      </span>
                    </span>
                    <Badge tone={STATUS[p.status][1]}>{STATUS[p.status][0]}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card className="min-w-0 space-y-3">
            <p className="flex items-center gap-2 font-semibold">
              <Gift className="size-5 text-zinc-400" /> Vales-presente
            </p>
            <div className="flex gap-2">
              <Input placeholder="Conferir saldo pelo código" value={lookup} onChange={(e) => setLookup(e.target.value.toUpperCase())} />
              <Button variant="ghost" disabled={lookup.trim().length < 4} onClick={check}>
                Conferir
              </Button>
            </div>
            {found && (
              <p className="rounded-lg bg-violet-50 px-3 py-2 text-sm text-violet-950">
                <b>{found.code}</b>: saldo {money(found.balance_cents)} de {money(found.amount_cents)} · {STATUS[found.status][0].toLowerCase()} · até {date(found.expires_on)}
              </p>
            )}
            {!sold?.giftCards.length ? (
              <p className="text-sm text-zinc-500">Nenhum vale vendido ainda. Ótimo para Dia dos Pais, Natal e aniversários.</p>
            ) : (
              <ul className="divide-y divide-zinc-100 text-sm">
                {sold.giftCards.map((g) => (
                  <li key={g.id} className="flex items-center justify-between gap-2 py-2">
                    <span className="min-w-0">
                      <b className="font-mono">{g.code}</b>
                      {g.recipient_name && <span className="text-zinc-500"> · para {g.recipient_name}</span>}
                      <span className="block text-xs text-zinc-500">
                        saldo {money(g.balance_cents)} de {money(g.amount_cents)} · até {date(g.expires_on)}
                      </span>
                    </span>
                    <Badge tone={STATUS[g.status][1]}>{STATUS[g.status][0]}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {selling === 'pacote' && (
        <SellPackageModal
          packages={forSale}
          onClose={() => setSelling(null)}
          onDone={() => {
            setSelling(null);
            load();
          }}
        />
      )}
      {selling === 'vale' && (
        <SellGiftModal
          shopName={shopName}
          onClose={() => setSelling(null)}
          onDone={() => {
            setSelling(null);
            load();
          }}
        />
      )}
    </section>
  );
}
