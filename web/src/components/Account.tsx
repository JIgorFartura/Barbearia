import { useState, type FormEvent } from 'react';
import type { Me } from '../App';
import { api } from '../lib/api';
import { phone as fmtPhone } from '../lib/format';
import { Button, ErrorText, Field, Input, Modal } from './ui';

/** Minha conta: nome, celular (recebe o código de "esqueci minha senha" e os avisos) e troca de senha. */
export function AccountModal({ me, onClose, onSaved }: { me: Me; onClose: () => void; onSaved: () => void }) {
  const user = me.user!;
  const [name, setName] = useState(user.name);
  const [phone, setPhone] = useState(fmtPhone(user.phone));
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await api('PUT', '/api/auth/profile', { name, phone: phone || null });
      if (password) {
        await api('POST', '/api/auth/password', { current, password });
        setCurrent('');
        setPassword('');
      }
      setMsg(password ? 'Dados e senha atualizados.' : 'Dados atualizados.');
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Minha conta" onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <Field label="Nome">
          <Input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {user.email && <p className="text-sm text-zinc-500">Login: {user.email}</p>}
        <Field label="Celular (WhatsApp)" hint="Recebe o código se você esquecer a senha e os avisos importantes (ex.: WhatsApp da barbearia desconectado).">
          <Input type="tel" placeholder="(11) 98888-7777" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <div className="space-y-3 rounded-xl bg-zinc-50 p-3">
          <p className="text-sm font-semibold">Trocar a senha (opcional)</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Senha atual">
              <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </Field>
            <Field label="Nova senha" hint="Pelo menos 8 caracteres.">
              <Input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </div>
        </div>
        <ErrorText error={error} />
        {msg && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</p>}
        <Button type="submit" loading={busy} className="w-full">
          Salvar
        </Button>
      </form>
    </Modal>
  );
}
