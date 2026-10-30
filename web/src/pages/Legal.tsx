import { ArrowLeft } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { phone as fmtPhone } from '../lib/format';

/** Termos de uso e políticas de privacidade (plataforma e de cada barbearia). */

const UPDATED = '24/10/2026';

interface Legal {
  company: string;
  document: string;
  email: string;
  address: string;
}

function Layout({ title, back, children }: { title: string; back: { href: string; label: string }; children: ReactNode }) {
  useEffect(() => {
    document.title = title;
  }, [title]);
  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="bg-zinc-950 text-white">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-4">
          <a href={back.href} className="flex items-center gap-1 text-sm text-zinc-300 hover:text-white">
            <ArrowLeft className="size-4" /> {back.label}
          </a>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-8">
        <article className="rounded-2xl bg-white p-6 text-sm leading-relaxed text-zinc-700 shadow-sm ring-1 ring-zinc-200 sm:p-8 [&_h2]:mt-6 [&_h2]:text-base [&_h2]:font-bold [&_h2]:text-zinc-900 [&_li]:mt-1 [&_p]:mt-2 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-5">
          <h1 className="text-2xl font-bold text-zinc-900">{title}</h1>
          <p className="!mt-1 text-xs text-zinc-500">Última atualização: {UPDATED}</p>
          {children}
        </article>
      </main>
    </div>
  );
}

function useLegal(): Legal | null {
  const [legal, setLegal] = useState<Legal | null>(null);
  useEffect(() => {
    api<Legal>('GET', '/api/public/legal').then(setLegal, () => setLegal({ company: 'Bladr', document: '', email: '', address: '' }));
  }, []);
  return legal;
}

const who = (l: Legal) => `${l.company}${l.document ? ` (${l.document})` : ''}`;
const contact = (l: Legal) => (l.email ? <a href={`mailto:${l.email}`}>{l.email}</a> : 'os canais de suporte da plataforma');

/** /termos — contrato entre a plataforma e a barbearia. */
export function TermsPage() {
  const l = useLegal();
  if (!l) return null;
  return (
    <Layout title="Termos de uso" back={{ href: '/', label: 'Bladr' }}>
      <h2>1. O serviço</h2>
      <p>
        {who(l)} oferece uma plataforma on-line para barbearias: site com a marca da barbearia, agenda, robô de atendimento no WhatsApp, programa de fidelidade,
        benefícios, financeiro e área do cliente. Estes termos valem entre {l.company} e a barbearia que contrata o serviço.
      </p>
      <h2>2. Cadastro e acesso</h2>
      <ul>
        <li>A barbearia informa dados verdadeiros e mantém atualizados o e-mail e o celular dos logins.</li>
        <li>Cada login é pessoal. A barbearia responde pelo que for feito com os logins dela (dono, sócios, gerentes e barbeiros).</li>
        <li>Guarde a senha em segredo. Se suspeitar de uso indevido, troque a senha e avise o suporte.</li>
      </ul>
      <h2>3. Mensalidade</h2>
      <ul>
        <li>O valor, o dia de vencimento e o período grátis (se houver) são combinados na contratação e aparecem no painel, na tela Mensalidade.</li>
        <li>
          A mensalidade pode ser paga no cartão de crédito pela Cielo, com cobrança automática todo mês no mesmo dia (a barbearia desliga quando quiser), ou
          por PIX. A confirmação dos pagamentos no cartão e no PIX pelo Asaas é automática.
        </li>
        <li>
          Com a mensalidade vencida além da carência informada no painel, o painel fica limitado à tela de pagamento e o robô responde só por menu até a
          confirmação do pagamento. O site e a área dos clientes continuam no ar.
        </li>
        <li>A barbearia pode cancelar quando quiser; o mês em curso não é devolvido.</li>
      </ul>
      <h2>4. Pagamentos dos clientes no cartão</h2>
      <ul>
        <li>
          A barbearia pode oferecer aos clientes o clube de assinatura no cartão pela Cielo, com cobrança automática todo mês. Para isso, a barbearia mantém uma
          conta própria na Cielo, sujeita às regras da Cielo, e informa no painel as credenciais da API dessa conta.
        </li>
        <li>O dinheiro vai direto para a conta Cielo da barbearia: {l.company} não recebe nem repassa esses valores.</li>
        <li>
          Os dados do cartão são digitados só na página da Cielo: a plataforma não recebe nem guarda dados de cartão. Na cobrança automática, quem guarda o
          cartão é a Cielo.
        </li>
        <li>
          A barbearia responde pela relação com o cliente que pagou no cartão, inclusive devoluções, contestações, notas fiscais e o cancelamento da cobrança
          automática no site da Cielo quando o sistema avisar que não conseguiu cancelar.
        </li>
      </ul>
      <h2>5. WhatsApp e mensagens aos clientes</h2>
      <ul>
        <li>A barbearia conecta o próprio número de WhatsApp e segue as regras do WhatsApp/Meta, inclusive sobre mensagens automáticas e modelos aprovados.</li>
        <li>
          As mensagens automáticas (lembretes, oferta do horário de costume, recontato, avaliação, aniversário) saem só em horário comercial, e o cliente pode
          parar de recebê-las respondendo PARAR.
        </li>
        <li>É proibido usar a plataforma para enviar spam, conteúdo ilegal ou mensagens para quem não é cliente da barbearia.</li>
      </ul>
      <h2>6. Dados pessoais (LGPD)</h2>
      <ul>
        <li>
          A barbearia é a controladora dos dados pessoais dos clientes dela; {l.company} é a operadora e trata esses dados só para prestar o serviço, conforme as
          instruções da barbearia e a Lei nº 13.709/2018 (LGPD).
        </li>
        <li>
          A administração da plataforma não tem acesso pelo sistema à agenda, aos barbeiros, aos clientes, às conversas nem ao que os clientes pagam à barbearia:
          cuida só do cadastro, do acesso do dono e da mensalidade do sistema. As cópias de segurança só podem ser baixadas criptografadas, para restaurar o
          serviço.
        </li>
        <li>
          {l.company} usa fornecedores necessários ao serviço (hospedagem, armazenamento das cópias de segurança, envio de mensagens de WhatsApp, processamento
          de pagamentos pela Cielo e pelo Asaas e, quando ligada, a inteligência artificial que interpreta as mensagens recebidas pelo robô).
        </li>
        <li>
          A barbearia mantém a sua política de privacidade (a plataforma publica uma no site da barbearia) e atende aos pedidos dos clientes; o painel tem as
          ferramentas para exportar e excluir os dados de um cliente.
        </li>
        <li>Incidentes de segurança que afetem dados pessoais serão comunicados à barbearia em prazo razoável.</li>
      </ul>
      <h2>7. Disponibilidade e cópias de segurança</h2>
      <p>
        {l.company} se esforça para manter a plataforma no ar e faz cópias de segurança diárias, mas não garante funcionamento ininterrupto. Manutenções
        programadas são avisadas no painel.
      </p>
      <h2>8. Responsabilidades</h2>
      <ul>
        <li>
          A barbearia responde pelo conteúdo que publica (textos, fotos, preços, anúncios de parceiros) e pela relação com os clientes dela, inclusive vendas, notas
          fiscais e comissões dos barbeiros.
        </li>
        <li>
          {l.company} não responde por indisponibilidade de serviços de terceiros (WhatsApp, internet, bancos) nem por lucros cessantes. Em qualquer caso, a
          responsabilidade de {l.company} fica limitada ao valor pago nos últimos 3 meses.
        </li>
      </ul>
      <h2>9. Fim do contrato</h2>
      <p>No cancelamento, a barbearia pode pedir uma cópia dos seus dados em até 30 dias. Depois disso, os dados são excluídos, exceto o que a lei mandar guardar.</p>
      <h2>10. Alterações</h2>
      <p>Estes termos podem mudar. Mudanças relevantes são avisadas no painel com antecedência.</p>
      <h2>11. Contato e foro</h2>
      <p>
        Dúvidas: {contact(l)}
        {l.address ? ` · ${l.address}` : ''}. Fica eleito o foro da comarca da sede de {l.company}.
      </p>
    </Layout>
  );
}

/** /privacidade — política da plataforma. */
export function PrivacyPage() {
  const l = useLegal();
  if (!l) return null;
  return (
    <Layout title="Política de privacidade" back={{ href: '/', label: 'Bladr' }}>
      <h2>1. Quem somos</h2>
      <p>
        {who(l)} é a responsável pela plataforma Bladr. Encarregado de dados (DPO): {contact(l)}.
      </p>
      <h2>2. Dados que tratamos</h2>
      <ul>
        <li>De quem usa o painel (donos, gerentes e barbeiros): nome, e-mail, celular, senha (guardada criptografada), registros de acesso e ações feitas no painel.</li>
        <li>
          Da barbearia, para a mensalidade e a nota fiscal: CPF ou CNPJ, nome ou razão social e e-mail para a nota; para receber dos clientes no cartão, as
          credenciais da API da conta Cielo dela (guardadas no servidor e nunca mostradas de volta).
        </li>
        <li>
          Das mensalidades pagas online: valor, forma de pagamento e situação. Os dados do cartão são digitados só na página da Cielo; não recebemos nem guardamos
          dados de cartão.
        </li>
        <li>
          Dos clientes das barbearias: tratamos em nome de cada barbearia, que é a controladora. A política de cada barbearia fica no site dela, no link
          “Política de privacidade”.
        </li>
      </ul>
      <h2>3. Para que usamos</h2>
      <ul>
        <li>Prestar o serviço contratado (execução de contrato).</li>
        <li>Segurança, prevenção de fraudes e cópias de segurança (legítimo interesse).</li>
        <li>Cobrança da mensalidade e notas fiscais (obrigação legal e execução de contrato).</li>
        <li>Avisos sobre o serviço pelo WhatsApp, como o código para trocar a senha ou o aviso de WhatsApp da barbearia desconectado.</li>
      </ul>
      <h2>4. Com quem compartilhamos</h2>
      <p>
        Só com fornecedores necessários: hospedagem e armazenamento de cópias de segurança, envio de mensagens de WhatsApp, processamento de pagamentos (Cielo e
        Asaas), notas fiscais (Asaas) e, quando ligada, a inteligência artificial que lê as mensagens recebidas pelo robô para respondê-las. Não vendemos dados pessoais.
      </p>
      <h2>5. Por quanto tempo</h2>
      <p>
        Enquanto a conta estiver ativa. Mensagens do robô são apagadas depois de 12 meses e códigos de acesso, depois de 30 dias. Registros fiscais são guardados
        pelo prazo da lei (5 anos).
      </p>
      <h2>6. Segurança</h2>
      <p>Senhas criptografadas, conexão segura (HTTPS), acesso restrito por perfil e cópias de segurança diárias, criptografadas quando saem do servidor.</p>
      <h2>7. Cookies</h2>
      <p>Usamos só os cookies necessários para manter você conectado. Não usamos cookies de publicidade.</p>
      <h2>8. Seus direitos</h2>
      <p>
        Pela LGPD (art. 18) você pode confirmar o tratamento, acessar, corrigir, pedir a portabilidade, a anonimização ou a exclusão dos seus dados, saber com
        quem compartilhamos e revogar consentimentos. Se você é cliente de uma barbearia, use a área do cliente (Meus dados) ou fale com a barbearia.
      </p>
      <h2>9. Contato</h2>
      <p>
        {contact(l)}
        {l.address ? ` · ${l.address}` : ''}
      </p>
    </Layout>
  );
}

interface ShopPolicy {
  shop: { name: string; address: string | null; whatsapp: string | null; instagram: string | null; bot_name: string };
  legal: Legal;
  ai: boolean;
  whatsapp: boolean;
  /** Aceita pagamento no cartão pela Cielo. */
  online: boolean;
}

/** /b/:slug/privacidade — política da barbearia para os clientes dela. */
export function ShopPrivacyPage({ slug }: { slug: string }) {
  const [p, setP] = useState<ShopPolicy | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    api<ShopPolicy>('GET', `/api/public/shops/${slug}/privacy`).then(setP, () => setMissing(true));
  }, [slug]);
  if (missing) return <div className="flex min-h-screen items-center justify-center text-zinc-500">Barbearia não encontrada.</div>;
  if (!p) return null;
  const s = p.shop;
  return (
    <Layout title={`Política de privacidade · ${s.name}`} back={{ href: `/b/${slug}`, label: s.name }}>
      <p>Esta política explica como a {s.name} cuida dos dados de quem é cliente e usa o site, a área do cliente e o WhatsApp da barbearia.</p>
      <h2>1. Quem cuida dos seus dados</h2>
      <p>
        A {s.name} é a controladora dos seus dados{s.address ? ` (${s.address})` : ''}
        {s.whatsapp ? `. Contato: WhatsApp ${fmtPhone(s.whatsapp)}` : ''}. O sistema usado pela barbearia é fornecido por {p.legal.company}, que atua como operadora.
      </p>
      <h2>2. Quais dados</h2>
      <ul>
        <li>Nome e celular.</li>
        <li>Horários marcados, serviços e produtos que você consumiu.</li>
        <li>Cartão fidelidade, vouchers e indicações.</li>
        <li>Horário de costume (informado por você ou percebido pelo seu histórico).</li>
        <li>Mensagens trocadas com o {s.bot_name} no WhatsApp.</li>
        <li>Data de nascimento, se você informar (para o presente de aniversário).</li>
        <li>Seus pagamentos à barbearia (compras e clube de assinatura): valor, forma e data.</li>
        <li>O comprovante do PIX (foto ou PDF), se você enviar pela sua área.</li>
        <li>Fotos do seu corte e anotações sobre como você gosta, se a barbearia registrar. As fotos você vê e apaga na sua área, em Meus cortes.</li>
        <li>Os dias em que você pediu para ser avisado de vaga (lista de espera) e se confirmou a presença.</li>
      </ul>
      {p.online && (
        <p>
          Se você pagar no cartão, os dados do cartão são digitados só na página segura da Cielo, que processa o pagamento: a barbearia e o sistema não recebem
          nem guardam esses dados. No clube, quem guarda o cartão para a cobrança automática de cada mês é a Cielo; você cancela quando quiser, pela sua área.
        </p>
      )}
      <h2>3. Para que usamos</h2>
      <ul>
        <li>Agendar, lembrar e cancelar seus horários.</li>
        <li>Cartão fidelidade, benefícios e vouchers.</li>
        <li>
          Sugerir seu horário de costume, chamar você quando faz tempo que não vem, oferecer horários vagos do dia com desconto e mandar o presente de aniversário.
          Você pode parar quando quiser respondendo PARAR no WhatsApp.
        </li>
        <li>Avisar o barbeiro do que você pediu para deixar separado e perguntar como foi o atendimento.</li>
        <li>Repetir o corte do seu jeito, com qualquer barbeiro da casa (anotações e fotos do corte).</li>
        <li>Pedir a confirmação da presença no lembrete e avisar você quando abrir vaga num dia em que está na lista de espera.</li>
        <li>Guardar os registros de vendas que a lei exige.</li>
      </ul>
      {p.ai && (
        <>
          <h2>4. Robô e inteligência artificial</h2>
          <p>
            O {s.bot_name} usa inteligência artificial (Claude, da Anthropic) para entender suas mensagens e responder. As mensagens são enviadas ao serviço de
            inteligência artificial só para gerar a resposta.
          </p>
        </>
      )}
      <h2>{p.ai ? 5 : 4}. Com quem compartilhamos</h2>
      <p>
        Só com os fornecedores necessários: o sistema da barbearia, o WhatsApp, a hospedagem{p.online ? ', a Cielo (quando você paga no cartão)' : ''}
        {p.ai ? ' e a inteligência artificial do robô' : ''}. Parceiros da barbearia só veem o voucher que você apresentar. Não vendemos seus dados.
      </p>
      <h2>{p.ai ? 6 : 5}. Bases legais</h2>
      <p>
        Execução de contrato (agendamentos e compras), legítimo interesse (fidelidade, lembretes e ofertas, sempre com a opção de parar), consentimento (cadastro
        na área do cliente e data de nascimento) e obrigação legal (registros de vendas).
      </p>
      <h2>{p.ai ? 7 : 6}. Por quanto tempo</h2>
      <p>
        Enquanto você for cliente. As mensagens do WhatsApp e os comprovantes de PIX são apagados depois de 12 meses. Se você excluir sua conta, apagamos nome,
        celular, mensagens, comprovantes, fotos do corte, anotações, cartão e vouchers; os registros de vendas ficam sem identificação, pelo prazo que a lei exige.
      </p>
      <h2>{p.ai ? 8 : 7}. Seus direitos</h2>
      <p>
        Na <a href={`/b/${slug}/conta`}>área do cliente</a>, em Meus dados, você baixa uma cópia dos seus dados e pode excluir sua conta. Para corrigir dados ou
        tirar dúvidas, fale com a barbearia{s.whatsapp ? ` pelo WhatsApp ${fmtPhone(s.whatsapp)}` : ''}.
      </p>
    </Layout>
  );
}

/** Rodapé com os links legais da plataforma. */
export function LegalLinks({ className = '' }: { className?: string }) {
  return (
    <p className={`flex justify-center gap-4 text-xs ${className}`}>
      <a href="/termos" className="hover:underline">
        Termos de uso
      </a>
      <a href="/privacidade" className="hover:underline">
        Política de privacidade
      </a>
    </p>
  );
}

