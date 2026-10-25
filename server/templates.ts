/**
 * Modelos de mensagem do WhatsApp oficial (Meta). Fora da janela de 24h depois da última mensagem do
 * cliente, a Meta só entrega mensagens de modelos aprovados. Cada barbearia cadastra os modelos abaixo
 * na conta dela (WhatsApp Manager → Modelos de mensagem) e informa o nome aprovado no painel.
 * No canal por QR Code (Evolution) nada disso é necessário: o texto vai como está.
 */

export type TemplateCategory = 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';

export interface TemplateDef {
  label: string;
  category: TemplateCategory;
  /** Texto sugerido para cadastrar na Meta, com as variáveis {{1}}, {{2}}... */
  body: string;
  /** Exemplo de cada variável (a Meta pede no cadastro). */
  example: string[];
  /** Mensagem da plataforma (WhatsApp do master), não da barbearia. */
  platform?: boolean;
}

export const TEMPLATES = {
  lembrete: {
    label: 'Lembrete do horário',
    category: 'UTILITY',
    body: 'Olá, {{1}}! Lembrete do seu horário na {{2}}: {{3}} com {{4}}. Você confirma? Responda SIM para confirmar ou NÃO se não puder vir.',
    example: ['João', 'Barbearia Navalha de Ouro', 'amanhã (sábado, 24/10) às 11h', 'Paulo'],
  },
  espera: {
    label: 'Vaga da lista de espera',
    category: 'UTILITY',
    body: 'Olá, {{1}}! Abriu uma vaga na {{2}}: {{3}} com {{4}}. Quer? Responda SIM para marcar.',
    example: ['João', 'Barbearia Navalha de Ouro', 'sábado, 24/10 às 15h', 'Paulo'],
  },
  liberado: {
    label: 'Horário liberado por falta de confirmação',
    category: 'UTILITY',
    body: 'Olá, {{1}}! Como não recebemos a sua confirmação, liberamos o horário de {{2}} na {{3}}. Se ainda quiser vir, responda que a gente vê outro horário.',
    example: ['João', 'sábado, 24/10 às 11h', 'Barbearia Navalha de Ouro'],
  },
  costume: {
    label: 'Oferta do horário de costume',
    category: 'MARKETING',
    body: 'Olá, {{1}}! Aqui é da {{2}}. Bora garantir seu horário de sempre? Separei {{3}} com {{4}}. Responda SIM para confirmar ou me diga outro horário.',
    example: ['João', 'Barbearia Navalha de Ouro', 'sexta, 30/10 às 17h', 'Paulo'],
  },
  vazio: {
    label: 'Horário vazio com desconto',
    category: 'MARKETING',
    body: 'Olá, {{1}}! Hoje tem horário livre na {{2}}: {{3}} com {{4}}, e marcando hoje o serviço sai com {{5}} de desconto. Quer? Responda SIM para marcar.',
    example: ['João', 'Barbearia Navalha de Ouro', 'hoje às 15h', 'Paulo', '20%'],
  },
  sumido: {
    label: 'Cliente sumido',
    category: 'MARKETING',
    body: 'Olá, {{1}}! Aqui é da {{2}}. Faz {{3}} dias que você não vem cortar com a gente. Bora deixar o visual em dia? Me diga o melhor dia e horário que eu marco pra você.',
    example: ['João', 'Barbearia Navalha de Ouro', '35'],
  },
  codigo: {
    label: 'Código de acesso do cliente',
    category: 'AUTHENTICATION',
    body: '*{{1}}* é seu código de verificação.',
    example: ['123456'],
  },
  barbeiro: {
    label: 'Aviso ao barbeiro (item separado)',
    category: 'UTILITY',
    body: 'Oi, {{1}}! Pedido de cliente para o seu atendimento: {{2}} vem {{3}} e pediu para deixar separado: {{4}}.',
    example: ['Paulo', 'João Pereira', 'hoje às 11h', '1 cerveja long neck'],
  },
  avaliacao: {
    label: 'Avaliação depois do corte',
    category: 'UTILITY',
    body: 'Olá, {{1}}! Obrigado por vir à {{2}}. Como foi seu atendimento com {{3}}? Responda com uma nota de 1 a 5.',
    example: ['João', 'Barbearia Navalha de Ouro', 'Paulo'],
  },
  aniversario: {
    label: 'Presente de aniversário',
    category: 'MARKETING',
    body: 'Feliz aniversário, {{1}}! A {{2}} preparou um presente pra você: {{3}}. Mostre o código {{4}} no balcão até {{5}}.',
    example: ['João', 'Barbearia Navalha de Ouro', '1 cerveja grátis', 'NAV-7K2P9Q', '30/11/2026'],
  },
  indicacao: {
    label: 'Prêmio por indicação',
    category: 'MARKETING',
    body: 'Olá, {{1}}! {{2}} veio à {{3}} por indicação sua. Seu prêmio: {{4}}. Mostre o código {{5}} no balcão até {{6}}.',
    example: ['João', 'Pedro', 'Barbearia Navalha de Ouro', 'R$ 10 de desconto', 'NAV-3M8T2R', '30/11/2026'],
  },
  assinatura: {
    label: 'Mensalidade do clube',
    category: 'UTILITY',
    body: 'Olá, {{1}}! A mensalidade do {{2}} ({{3}}) vence em {{4}}. PIX copia e cola: {{5}}',
    example: ['João', 'Clube Navalha', 'R$ 99,90', '10/11/2026', '00020126...'],
  },
  senha: {
    label: 'Código para trocar a senha (plataforma)',
    category: 'AUTHENTICATION',
    body: '*{{1}}* é seu código de verificação.',
    example: ['123456'],
    platform: true,
  },
  alerta: {
    label: 'WhatsApp da barbearia desconectado (plataforma)',
    category: 'UTILITY',
    body: 'Atenção: o WhatsApp da {{1}} desconectou em {{2}}. O robô e os lembretes estão parados. Reconecte em Painel, Robô WhatsApp, aba WhatsApp.',
    example: ['Barbearia Navalha de Ouro', '24/10 às 14h32'],
    platform: true,
  },
  comprovante: {
    label: 'Comprovante de PIX enviado por um cliente (plataforma)',
    category: 'UTILITY',
    body: 'Comprovante de PIX na {{1}}: {{2}} pagou {{3}} ({{4}}). Confira no extrato e confirme no painel: {{5}}',
    example: ['Barbearia Navalha de Ouro', 'João Pereira', 'R$ 99,90', 'Clube Ouro · novembro', 'https://app.exemplo.com.br/painel?conferir=1'],
    platform: true,
  },
  nota_baixa: {
    label: 'Avaliação baixa de um cliente (plataforma)',
    category: 'UTILITY',
    body: 'Avaliação {{1}}/5 na {{2}}: {{3}} escreveu "{{4}}". Vale um contato com o cliente.',
    example: ['2', 'Barbearia Navalha de Ouro', 'João Pereira (atendido pelo Paulo)', 'Demorou para ser atendido'],
    platform: true,
  },
  sistema: {
    label: 'Erros no sistema (aviso ao master)',
    category: 'UTILITY',
    body: 'Atenção: {{1}} erro(s) no Sistema Barbearia desde {{2}}. O mais recente: {{3}}. Veja em Master, aba Sistema.',
    example: ['3', '25/10/2026 14:32', 'Cannot read properties of undefined'],
    platform: true,
  },
  fatura: {
    label: 'Mensalidade do sistema (plataforma)',
    category: 'UTILITY',
    body: 'Olá, {{1}}! A mensalidade do sistema da {{2}} ({{3}}) vence em {{4}}. Pague pelo painel, na tela Mensalidade.',
    example: ['Carlos', 'Barbearia Navalha de Ouro', 'R$ 149,90', '10/11/2026'],
    platform: true,
  },
} satisfies Record<string, TemplateDef>;

export type TemplateKind = keyof typeof TEMPLATES;
export const TEMPLATE_KINDS = Object.keys(TEMPLATES) as TemplateKind[];
export const SHOP_TEMPLATE_KINDS = TEMPLATE_KINDS.filter((k) => !(TEMPLATES[k] as TemplateDef).platform);
export const PLATFORM_TEMPLATE_KINDS = TEMPLATE_KINDS.filter((k) => (TEMPLATES[k] as TemplateDef).platform);

/** Mensagem automática com as variáveis do modelo correspondente. */
export interface TemplateUse {
  kind: TemplateKind;
  params: string[];
}

/** Campo da configuração da Meta onde fica o nome aprovado de cada modelo. */
export const templateField = (kind: TemplateKind) => `tpl_${kind}`;
