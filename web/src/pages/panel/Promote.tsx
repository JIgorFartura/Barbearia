import { AtSign, Globe, MapPin, Printer, QrCode } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CopyField } from '../../components/CopyField';
import { Button, Card, ErrorText, Field, Input } from '../../components/ui';
import { api } from '../../lib/api';

interface PromoteData {
  site: string;
  area: string;
  queue: string | null;
  guide: { listed: boolean; city: string | null; district: string | null; url: string };
}

/** Divulgar a barbearia: o link de agendar no Google e no Instagram, o QR Code e o guia da Bladr. */
export function Promote({ shopName }: { shopName: string }) {
  const [data, setData] = useState<PromoteData | null>(null);
  const [svg, setSvg] = useState('');
  const [guide, setGuide] = useState({ listed: false, city: '', district: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<PromoteData>('GET', '/api/shop/promote').then((d) => {
      setData(d);
      setGuide({ listed: d.guide.listed, city: d.guide.city ?? '', district: d.guide.district ?? '' });
    }, (e) => setError(e.message));
    fetch('/api/shop/promote/qr', { credentials: 'same-origin' })
      .then((r) => r.text())
      .then(setSvg, () => undefined);
  }, []);
  if (!data) return <ErrorText error={error} />;

  function printPoster() {
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Agende pelo celular</title>
      <style>body{font-family:system-ui,sans-serif;text-align:center;padding:48px}h1{font-size:44px;margin:0 0 8px}p{font-size:22px;color:#444}svg{width:420px;height:420px;margin:24px auto}</style></head>
      <body><h1>${shopName.replace(/</g, '&lt;')}</h1><p>Aponte a câmera e agende o seu horário pelo celular.</p>${svg}<p style="font-size:16px">${data!.site}</p>
      <script>window.onload=()=>window.print()</script></body></html>`);
    w.document.close();
  }

  async function saveGuide() {
    setMsg(null);
    setError(null);
    try {
      await api('PUT', '/api/shop/promote/guide', { listed: guide.listed, city: guide.city || null, district: guide.district || null });
      setMsg(guide.listed ? 'Pronto: a barbearia aparece no guia.' : 'Salvo: a barbearia não aparece no guia.');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Divulgar a barbearia</h1>
        <p className="text-sm text-zinc-500">Coloque o link de agendar onde o cliente já procura: Google, Instagram e WhatsApp.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="space-y-3">
          <p className="flex items-center gap-2 font-semibold">
            <Globe className="size-5 text-zinc-400" /> Seus links
          </p>
          <CopyField label="Site com o botão Agendar" value={data.site} />
          {data.queue && <CopyField label="Fila de chegada" value={data.queue} />}
          <CopyField label="Área do cliente (app)" value={data.area} />
        </Card>
        <Card className="space-y-3 text-center">
          <p className="flex items-center justify-center gap-2 font-semibold">
            <QrCode className="size-5 text-zinc-400" /> QR Code do site
          </p>
          <div className="mx-auto size-44 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: svg }} />
          <p className="text-sm text-zinc-500">Para o balcão, o espelho e o cartão de visita.</p>
          <Button variant="ghost" onClick={printPoster}>
            <Printer className="size-4" /> Imprimir cartaz
          </Button>
        </Card>
        <Card className="space-y-2 text-sm">
          <p className="flex items-center gap-2 font-semibold">
            <MapPin className="size-5 text-zinc-400" /> Botão Agendar no Google
          </p>
          <ol className="list-decimal space-y-1 pl-5 text-zinc-600">
            <li>Abra o Google Maps (ou a busca) com a conta que administra a barbearia.</li>
            <li>No Perfil da Empresa, toque em <b>Editar perfil</b> → <b>Links de agendamento</b> (ou <b>Reservas</b>).</li>
            <li>Cole o link do site e salve. O botão <b>Agendar</b> aparece na busca e no Maps.</li>
          </ol>
        </Card>
        <Card className="space-y-2 text-sm">
          <p className="flex items-center gap-2 font-semibold">
            <AtSign className="size-5 text-zinc-400" /> Instagram e WhatsApp
          </p>
          <ol className="list-decimal space-y-1 pl-5 text-zinc-600">
            <li>
              Instagram: <b>Editar perfil</b> → <b>Botões de ação</b> → <b>Reservar</b> (ou <b>Adicionar link</b>) → cole o link do site. Coloque também na bio.
            </li>
            <li>Nos stories, use a figurinha de <b>Link</b> com o mesmo endereço.</li>
            <li>
              WhatsApp Business: <b>Ferramentas comerciais</b> → <b>Mensagem de saudação</b> com o link, para quem chama fora do horário.
            </li>
          </ol>
        </Card>
      </div>
      <Card className="space-y-3">
        <p className="font-semibold">Guia de barbearias da Bladr</p>
        <p className="text-sm text-zinc-500">
          Apareça no guia público ({data.guide.url}), com o nome, a cidade, o bairro, a nota dos clientes e o botão de agendar. Só aparece quem marcar abaixo.
        </p>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" className="size-4 accent-zinc-900" checked={guide.listed} onChange={(e) => setGuide({ ...guide, listed: e.target.checked })} />
          Aparecer no guia
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Cidade">
            <Input value={guide.city} onChange={(e) => setGuide({ ...guide, city: e.target.value })} placeholder="São Paulo" />
          </Field>
          <Field label="Bairro (opcional)">
            <Input value={guide.district} onChange={(e) => setGuide({ ...guide, district: e.target.value })} placeholder="Pinheiros" />
          </Field>
        </div>
        <ErrorText error={error} />
        {msg && <p className="text-sm text-emerald-700">{msg}</p>}
        <Button onClick={saveGuide}>Salvar</Button>
      </Card>
    </div>
  );
}
