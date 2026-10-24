import { ExternalLink, LogOut, Plus, Scissors, Store } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Me } from '../App';
import { Badge, Button, Card, EmptyState, ErrorText, Field, Input, Modal } from '../components/ui';
import { api } from '../lib/api';
import { date } from '../lib/format';

interface ShopRow {
  id: number;
  slug: string;
  name: string;
  active: number;
  created_at: string;
  owners: string | null;
  customers: number;
  campaigns: number;
}

const slugify = (v: string) =>
  v
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

/** Painel do dono da plataforma: lista e cadastra barbearias. */
export function Master({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [shops, setShops] = useState<ShopRow[] | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => {
    api<ShopRow[]>('GET', '/api/master/shops').then(setShops);
  }, []);
  useEffect(load, [load]);

  async function toggle(shop: ShopRow) {
    await api('PUT', `/api/master/shops/${shop.id}`, { name: shop.name, slug: shop.slug, active: !shop.active });
    load();
  }

  return (
    <div className="min-h-screen">
      <header className="bg-zinc-950 text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-2 font-bold">
            <Scissors className="size-5 text-gold" /> Sistema Barbearia <Badge tone="gold">Master</Badge>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-zinc-400 sm:inline">{me.user?.name}</span>
            <button className="flex items-center gap-1 text-zinc-300 hover:text-white" onClick={() => api('POST', '/api/auth/logout').then(onLogout)}>
              <LogOut className="size-4" /> Sair
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">Barbearias</h1>
            <p className="text-sm text-zinc-500">Cada barbearia tem seu site com a própria marca e um painel só dela. O sistema é o mesmo para todas.</p>
          </div>
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" /> Nova barbearia
          </Button>
        </div>

        {shops?.length === 0 && (
          <EmptyState icon={<Store className="size-6" />} title="Nenhuma barbearia ainda" text="Cadastre a primeira e entregue o login para o dono." />
        )}
        <div className="grid gap-3 md:grid-cols-2">
          {shops?.map((s) => (
            <Card key={s.id}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">{s.name}</p>
                  <a href={`/b/${s.slug}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900">
                    /b/{s.slug} <ExternalLink className="size-3" />
                  </a>
                </div>
                <Badge tone={s.active ? 'green' : 'red'}>{s.active ? 'Ativa' : 'Suspensa'}</Badge>
              </div>
              <p className="mt-3 text-sm text-zinc-600">
                {s.customers} clientes · {s.campaigns} campanhas ativas · desde {date(s.created_at)}
              </p>
              <p className="text-xs text-zinc-500">Login: {s.owners ?? '—'}</p>
              <Button variant={s.active ? 'danger' : 'ghost'} className="mt-3 !py-1.5" onClick={() => toggle(s)}>
                {s.active ? 'Suspender' : 'Reativar'}
              </Button>
            </Card>
          ))}
        </div>
      </main>

      {creating && (
        <NewShopModal
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function NewShopModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ name: '', slug: '', ownerName: '', ownerEmail: '', ownerPassword: '' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/master/shops', form);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Nova barbearia" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nome da barbearia">
          <Input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value, slug: slugTouched ? form.slug : slugify(e.target.value) })}
          />
        </Field>
        <Field label="Endereço do site" hint={`O site fica em ${location.origin}/b/${form.slug || '...'}`}>
          <Input
            required
            value={form.slug}
            onChange={(e) => {
              setSlugTouched(true);
              setForm({ ...form, slug: slugify(e.target.value) });
            }}
          />
        </Field>
        <hr className="border-zinc-100" />
        <p className="text-sm font-semibold">Login do dono</p>
        <Field label="Nome">
          <Input required value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} />
        </Field>
        <Field label="E-mail">
          <Input type="email" required value={form.ownerEmail} onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })} />
        </Field>
        <Field label="Senha inicial" hint="Pelo menos 8 caracteres. O dono pode trocar depois.">
          <Input required minLength={8} value={form.ownerPassword} onChange={(e) => setForm({ ...form, ownerPassword: e.target.value })} />
        </Field>
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={busy}>
            Cadastrar
          </Button>
        </div>
      </form>
    </Modal>
  );
}
