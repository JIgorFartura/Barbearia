import { Ticket } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CrudPage, type Row } from '../../components/CrudPage';
import { Badge, Card } from '../../components/ui';
import { api } from '../../lib/api';
import { date } from '../../lib/format';

interface Voucher {
  id: number;
  code: string;
  status: 'active' | 'used' | 'expired';
  expires_on: string;
  used_at: string | null;
  created_at: string;
  title: string;
  customer_name: string;
}

const today = () => new Date().toLocaleDateString('en-CA');
const running = (r: Row) => Boolean(r.active) && (!r.starts_on || r.starts_on <= today()) && (!r.ends_on || r.ends_on >= today());

/** Benefícios que viram voucher na área do cliente (e no robô). */
export function Benefits({ partners }: { partners: Row[] }) {
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const loadVouchers = () => void api<Voucher[]>('GET', '/api/shop/vouchers').then(setVouchers);
  useEffect(loadVouchers, []);
  const partnerName = (id: number | null) => partners.find((p) => p.id === id)?.name;

  return (
    <div className="space-y-8">
      <CrudPage
        title="Benefícios"
        description="Descontos e brindes que o cliente pega como voucher na área dele ou pedindo ao robô. O código é validado no Balcão."
        endpoint="/api/shop/offers"
        newLabel="Novo benefício"
        defaults={{ active: true, valid_days: 7, per_customer: 1, max_total: null, partner_id: null }}
        onChange={loadVouchers}
        empty={{ icon: <Ticket className="size-6" />, title: 'Nenhum benefício ainda', text: 'Ex.: cerveja grátis no próximo corte, 20% na barba, desconto no parceiro.' }}
        fields={[
          { key: 'title', label: 'Benefício', type: 'text', required: true, placeholder: 'Cerveja grátis no próximo corte' },
          { key: 'description', label: 'Regras', type: 'textarea', placeholder: 'Válido de terça a quinta.' },
          {
            key: 'partner_id',
            label: 'Usado em um parceiro? (opcional)',
            type: 'select',
            options: [{ value: null, label: '— na própria barbearia —' }, ...partners.map((p) => ({ value: p.id, label: p.name }))],
          },
          { key: 'valid_days', label: 'Voucher vale por quantos dias', type: 'number', required: true },
          { key: 'per_customer', label: 'Quantos cada cliente pode pegar', type: 'number', required: true },
          { key: 'max_total', label: 'Quantidade total (vazio = sem limite)', type: 'number' },
          { key: 'image_url', label: 'Imagem', type: 'image' },
          { key: 'starts_on', label: 'Começa em', type: 'date' },
          { key: 'ends_on', label: 'Termina em', type: 'date' },
          { key: 'active', label: 'Benefício ativo', type: 'checkbox' },
        ]}
        renderItem={(r) => {
          const issued = vouchers.filter((v) => v.title === r.title);
          return (
            <>
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold">{r.title}</p>
                <Badge tone={running(r) ? 'green' : 'zinc'}>{running(r) ? 'Valendo' : 'Fora do ar'}</Badge>
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                Vale {r.valid_days} dias · {r.per_customer} por cliente{r.max_total ? ` · ${r.max_total} no total` : ''}
                {partnerName(r.partner_id) && ` · no parceiro ${partnerName(r.partner_id)}`}
              </p>
              <p className="mt-2 text-sm text-zinc-600">
                {issued.length} pegos · {issued.filter((v) => v.status === 'used').length} usados
              </p>
            </>
          );
        }}
      />

      <div>
        <h2 className="mb-3 text-lg font-bold">Vouchers emitidos</h2>
        {vouchers.length === 0 ? (
          <p className="text-sm text-zinc-500">Os vouchers que os clientes pegarem aparecem aqui.</p>
        ) : (
          <Card className="!p-0">
            <ul className="divide-y divide-zinc-100 text-sm">
              {vouchers.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                  <span>
                    <span className="font-mono font-semibold">{v.code}</span> <span className="text-zinc-500">· {v.title} · {v.customer_name}</span>
                  </span>
                  <span className="flex items-center gap-2 text-xs text-zinc-500">
                    {v.status === 'used' ? `usado em ${date(v.used_at)}` : `vale até ${date(v.expires_on)}`}
                    <Badge tone={v.status === 'active' ? 'gold' : v.status === 'used' ? 'green' : 'zinc'}>
                      {v.status === 'active' ? 'Ativo' : v.status === 'used' ? 'Usado' : 'Vencido'}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
