# Sistema Barbearia

Plataforma **white-label** para barbearias: o sistema é um só, e cada barbearia ganha o **próprio
site com a sua marca** (logo, cores, fotos, contatos), um **robô no WhatsApp com o nome que ela
escolher** e um **painel só dela**.

A ideia: o cliente não vive só o corte, vive uma **experiência de comunidade**: campanhas de
fidelidade, benefícios com voucher, clube de assinatura, indicação de amigos, presente de
aniversário, comércios parceiros e um robô que lembra dele (até da cerveja de sempre).

| Área do cliente (celular) | Robô no WhatsApp (simulador do painel) |
|---|---|
| <img src="docs/img/area-cliente.png" width="260" alt="Área do cliente"> | <img src="docs/img/robo-simulador.png" width="520" alt="Simulador do robô"> |

| Primeiros passos | Agenda | Fechar atendimento |
|---|---|---|
| <img src="docs/img/primeiros-passos.png" width="300" alt="Primeiros passos"> | <img src="docs/img/agenda.png" width="300" alt="Agenda"> | <img src="docs/img/fechar-atendimento.png" width="300" alt="Fechar atendimento"> |

| Clube de assinatura | Avaliações | Indicação e aniversário |
|---|---|---|
| <img src="docs/img/clube.png" width="300" alt="Clube de assinatura"> | <img src="docs/img/avaliacoes.png" width="300" alt="Avaliações"> | <img src="docs/img/indicacao.png" width="300" alt="Indicação e aniversário"> |

| Comprovante do PIX (cliente) | App do barbeiro (só a parte dele) | Recebimentos dos clientes (barbearia) |
|---|---|---|
| <img src="docs/img/comprovante-cliente.png" width="180" alt="Comprovante do PIX"> | <img src="docs/img/barbeiro.png" width="180" alt="App do barbeiro"> | <img src="docs/img/recebimentos.png" width="300" alt="Recebimentos dos clientes"> |

| Financeiro | Estoque |
|---|---|
| <img src="docs/img/financeiro.png" width="300" alt="Financeiro"> | <img src="docs/img/estoque.png" width="300" alt="Estoque"> |

| Painel master | Pronto para o piloto? | Mensalidades no master |
|---|---|---|
| <img src="docs/img/master.png" width="300" alt="Painel master"> | <img src="docs/img/master-piloto.png" width="300" alt="Checklist do piloto"> | <img src="docs/img/master-financeiro.png" width="300" alt="Financeiro do master"> |

| Clube no cartão (cliente) | Mensalidade no cartão automático | Receber no cartão (barbearia) | Mensalidades pagas (master) |
|---|---|---|---|
| <img src="docs/img/cartao-cliente.png" width="180" alt="Clube no cartão automático"> | <img src="docs/img/cartao-mensalidade.png" width="300" alt="Mensalidade no cartão automático"> | <img src="docs/img/cartao-barbearia.png" width="220" alt="Receber no cartão pela Cielo"> | <img src="docs/img/master-pagamentos.png" width="300" alt="Mensalidades pagas online no master"> |

## Quatro perfis

- **Master** (dono da plataforma) cuida **só do controle geral**: cria a barbearia e entrega o
  acesso ao dono (plano, valor, dia de vencimento, dias grátis e a mensagem pronta com o link e a
  senha), troca a senha e o celular do dono, suspende ou reativa, acompanha as **mensalidades** que
  as barbearias pagam a ele (inclusive as pagas online), configura a **Cielo** e o **Asaas**, o
  **WhatsApp da plataforma**, os **termos e a política de privacidade**,
  as **cópias de segurança** e os **avisos** que aparecem no painel de todas as barbearias. A aba
  *Sistema* tem o checklist **"Pronto para o piloto?"**. O master **não vê** agenda, barbeiros,
  clientes, conversas nem o que os clientes pagam às barbearias (é delas): a API recusa o master
  em qualquer rota do painel.
- **Dono da barbearia**: agenda, balcão, financeiro (com os **recebimentos de todos os clientes** e a
  cópia dos **comprovantes** do PIX), estoque, robô, avaliações, clube de assinatura, campanhas,
  benefícios, indicação e aniversário, parceiros, anúncios, barbeiros, serviços, produtos, marca e a
  própria mensalidade. Nunca vê dados de outra barbearia.
- **Barbeiro** (o dono libera em *Barbeiros → Acesso ao sistema*): entra pelo **celular** ou
  e-mail e vê só a **própria agenda**, fecha os **próprios atendimentos** (se o dono permitir),
  marca falta e acompanha **Meus ganhos** e a nota que os clientes dão para ele. Do dinheiro, vê só
  **a parte dele**: a comissão de cada atendimento, o que tem a receber e os pagamentos recebidos
  (não vê o total que o cliente pagou, o faturamento, o caixa nem a comissão dos colegas).
- **Cliente** (`/b/<endereço>/conta`): entra pelo celular com um **código enviado pelo robô no
  WhatsApp** (ou pelo link que o robô manda) e fica logado por 180 dias. Agenda e cancela, assina o
  **clube** e paga por PIX (mandando o **comprovante**) ou **cartão**, vê **Meus pagamentos** (só os
  dele), o cartão fidelidade, pega vouchers, manda o **link de indicação**, informa o
  **aniversário** e o horário de costume, **baixa os próprios dados** e pode **excluir a conta**
  (LGPD).

Todos (menos o cliente) têm **Minha conta** (nome, celular, senha) e **"Esqueci minha senha"**
com código pelo WhatsApp da plataforma.

## O robô do WhatsApp

Cada barbearia dá um **nome** ao robô (aba *Robô WhatsApp*) e ele se apresenta assim. O cliente
conversa naturalmente:

- *"João, quantas cervejas faltam pro meu prêmio?"* → consulta o cartão fidelidade.
- *"João, olha na agenda do Paulo se tem vaga sexta às 19h"* → mostra os horários livres do Paulo
  (nunca quem marcou) e marca se o cliente pedir.
- *"Cancela meu horário"*, *"me manda o link da minha área"*, *"quero o voucher da cerveja"*,
  *"costumo vir às sextas, 7 da noite"*, *"meu aniversário é 12 de março"*, *"me passa meu link
  de indicação"* → faz na hora.
- Número desconhecido → pergunta o nome, cadastra (com o aviso da política de privacidade) e
  aceita o **código de quem indicou**.
- *"Paguei"* → avisa a barbearia do PIX da mensalidade do clube e manda o link para enviar o
  **comprovante** pela área do cliente. Foto ou arquivo no WhatsApp (o robô só lê texto): com a
  mensalidade em aberto, ele responde com esse mesmo link.

**Ele aprende o consumo de cada cliente.** Se o João toma 1 cerveja em pelo menos metade das
visitas, ao confirmar o horário vem a pergunta: *"Posso avisar o Paulo que você vai querer 1
cerveja long neck hoje, pra ele deixar separado? 🍺"*. Com SIM, o barbeiro recebe o aviso, a
agenda mostra **🍺 Separar** e, ao fechar o atendimento, a cerveja já entra na comanda. Produto
esgotado no estoque não é oferecido.

Por baixo, o robô usa o **Claude** (Anthropic) com ferramentas que só enxergam a barbearia e o
celular da conversa. Respostas certeiras não passam pela IA: **SIM/NÃO** para um horário oferecido,
**CANCELAR**, **PARAR/VOLTAR**, **PAGUEI** e a **nota de 1 a 5** da avaliação. **Sem chave da
Anthropic**, o robô responde por menu (CARTÃO, HORÁRIOS, CANCELAR).

Canais (um por barbearia):

| Canal | Quando usar |
|---|---|
| **Simulador** | Padrão. Nada sai pelo WhatsApp; as conversas ficam no painel. Ótimo para testar e apresentar. |
| **Evolution API** | Conecta o WhatsApp da barbearia por QR Code (serviço próprio ou contratado). Mais simples de começar; não é a API oficial. |
| **WhatsApp oficial (Meta)** | Cloud API do WhatsApp Business. Exige conta verificada. Fora da janela de 24h, só saem **modelos aprovados** pela Meta: o painel lista um modelo por tipo de mensagem (lembrete, costume, sumido, código, avaliação, aniversário, indicação, clube...) com o texto sugerido e as variáveis. |

O painel mostra a URL do webhook de cada barbearia (com um segredo próprio), tem **envio de
teste** e confere a **conexão a cada 10 minutos**: se o WhatsApp cair, o dono recebe um aviso
pelo WhatsApp da plataforma (e o painel mostra uma faixa vermelha).

## Mensagens automáticas

Só das 8h às 21h (no fuso de cada barbearia), cada uma uma única vez, e quem responde PARAR deixa
de receber as de marketing.

- **Lembrete do horário** X horas antes (padrão 24h), com a opção de responder CANCELAR.
- **Horário de costume**: o sistema descobre pelo histórico o dia, a hora, o barbeiro e o ritmo de
  cada cliente e, no dia escolhido (padrão: segunda às 9h), oferece o horário de sempre.
- **Cliente sumido** depois de N dias (padrão 30), com sugestão de horário.
- **Avaliação depois do corte** (padrão 2h depois; no máximo uma por cliente a cada 30 dias).
- **Presente de aniversário** no dia, com voucher.
- **Mensalidade do clube** 3 dias antes de vencer (com o PIX em mensagem separada, fácil de
  copiar, e o link para pagar no cartão quando a barbearia aceita) e um lembrete se atrasar. No
  cartão automático não vai cobrança: só o aviso se o cartão não passar.

## Agenda e barbeiros

- **Agenda** por barbeiro, encaixe pelo balcão, falta, cancelamento e **fechar o atendimento**.
- **Barbeiros**: expediente com pausas, folgas, bloqueios, comissão (por serviço, inclusive valor
  fixo) e acesso ao sistema.

## Clube de assinatura

O cliente paga um valor fixo por mês e usa os serviços do plano **sem pagar na hora**, até o
limite do mês (ou à vontade). Ele assina pela **área do cliente** (ou o dono adiciona no balcão)
e paga por **PIX direto na chave da barbearia** (manda o **comprovante** ou avisa com *Já paguei*,
ou *paguei* no WhatsApp; o dono confere no banco e confirma pelo aviso no topo do painel, e só
então entra no caixa) ou
no **cartão automático pela Cielo**: a Cielo cobra sozinha todo mês e a baixa é automática (veja
*Pagamentos no cartão*). Na
comanda, o que o plano cobre já sai por **R$ 0**, e a comissão do barbeiro é calculada sobre o
preço normal (na % que o dono escolher). Atrasou, os benefícios pausam até o pagamento. Os planos
aparecem no site da barbearia.

## Financeiro e estoque

- **Fechar atendimento**: a comanda já vem com o serviço, o que o cliente pediu para separar e o
  que o clube cobre; dá para somar produtos, mudar quem atendeu, dar desconto e escolher a forma de
  pagamento.
- **Caixa** (entradas, saídas, contas a pagar), **comissões** (a receber, extrato e *Pagar
  comissão*), **resumo** com gráfico, faturamento por barbeiro, formas de pagamento e gastos.
- **Recebimentos**: tudo o que os clientes pagaram no período (vendas da agenda e do balcão,
  mensalidades do clube no PIX ou no cartão), com o cliente, a forma e o comprovante do PIX.
- **Carimbo automático**: o produto ou serviço ligado a uma campanha vira carimbo no cartão.
- **Estoque**: entrada de mercadoria (com lançamento no caixa), contagem, perda, consumo interno,
  baixa automática na venda (volta no cancelamento), reservado para os horários marcados e aviso
  de **estoque acabando** no resumo.

## Avaliações, indicação e aniversário

- **Avaliações**: depois do atendimento o robô pede uma nota de 1 a 5. Nota 4 ou 5 recebe o
  **link para avaliar no Google**; nota baixa, o robô pergunta o que melhorar e o comentário chega
  no **WhatsApp do dono**. O painel mostra a média, a nota por barbeiro e os comentários (com
  botão para chamar o cliente).
- **Indique um amigo**: cada cliente tem um link; quem chega por ele vê *"Fulano te indicou"* e
  pode ganhar um presente de boas-vindas; quem indicou ganha o prêmio quando o amigo **vem pela
  primeira vez** (venda fechada) e recebe o código pelo WhatsApp.
- **Aniversário**: o cliente informa dia e mês; no dia, ganha o presente (29/02 cai em 28/02 nos
  outros anos).
- Os prêmios são **vouchers** (validados no Balcão como qualquer benefício), fora da lista de
  benefícios comuns.

## Mensalidades da plataforma

- O master define **planos** (ou um valor por barbearia), o **dia de vencimento** e os **dias
  grátis**. As faturas são geradas sozinhas; dá para criar uma **cobrança avulsa**.
- **Cartão automático pela Cielo** (aba *Financeiro* do master): a barbearia paga a fatura no
  cartão uma vez e a Cielo cobra o mesmo valor **todo mês, no mesmo dia** (a mensalidade passa a
  vencer nesse dia). A baixa é automática; sem lembrete antes, só o aviso se o cartão não passar
  (aí dá para pagar no PIX ou usar outro cartão). Mudou o valor ou a barbearia foi suspensa: a
  cobrança no cartão é desligada.
- **Com o Asaas** (opcional): cada fatura vira um **PIX** com QR Code próprio e baixa automática
  (sem a Cielo, a página do Asaas também aceita cartão e boleto). Com a nota fiscal ligada, o
  Asaas emite a **NFS-e** de cada mensalidade paga, inclusive as pagas no cartão (link no painel do
  dono e do master). O dono informa CPF/CNPJ e nome na tela *Mensalidade*.
- **Sem o Asaas**: PIX copia e cola com a chave do master e confirmação manual (*Já paguei* →
  *Confirmar pagamento*).
- **Lembrete** pelo WhatsApp da plataforma antes de vencer e depois de vencida.
- **Carência** (padrão 5 dias): passou disso, o painel só abre a tela da mensalidade, o robô
  responde só pelo menu e as automáticas param. O **site e a área do cliente continuam no ar**.
  O master pode **liberar até uma data** ou **suspender**.

## Pagamentos no cartão (Cielo)

O cartão vai pela **Cielo** (API do Link de Pagamento): a menor taxa pública entre as plataformas
que recebem em 1 dia e deixam o sistema cobrar o cartão todo mês sozinho. O cliente digita o
cartão na **página segura da Cielo** (o sistema nunca vê dados de cartão) e, na cobrança
automática, quem guarda o cartão é a Cielo.

- **Mensalidade das barbearias** (Cielo da plataforma): cartão automático todo mês (acima).
- **Clientes das barbearias** (Cielo de cada barbearia): **clube no cartão automático** (a Cielo
  cobra todo mês no dia do primeiro pagamento; o clube vale até 3 dias a mais enquanto a Cielo
  tenta de novo; se não passar, sai a cobrança com PIX no WhatsApp e o cliente pode usar outro
  cartão). O dinheiro cai **direto na conta Cielo da barbearia**: a Cielo não divide pagamento,
  então a plataforma não fica com parte (ganha a mensalidade).
- **Baixa automática**: cada aviso da Cielo é **conferido na própria Cielo** antes da baixa (o
  aviso não é assinado). O pagamento entra no caixa e a **taxa do cartão** (a % que a barbearia
  informa, padrão 3,48%) sai como despesa, para o saldo bater com o que cai na conta. Aviso
  repetido não duplica; pago de dois jeitos (ou depois de cancelar) fica marcado para **devolver**;
  estorno na Cielo tira o valor do caixa.
  De hora em hora o sistema confere na Cielo os pagamentos cujo aviso não chegou, apaga os links
  que não valem mais e insiste em parar a cobrança de quem cancelou.
- **Cancelar**: o cliente (ou o dono) cancela o clube e a Cielo para de cobrar o cartão. Se a
  Cielo não responder, o dono vê o aviso para cancelar no site da Cielo.
- **Master** (*Financeiro → Mensalidades pagas online*): só as mensalidades das barbearias, por
  período (quanto foi pago, as taxas estimadas e cada pagamento: barbearia, forma, valor e
  situação). O cartão da Cielo mostra quando chegou o **último aviso**.
- **Dono** (*Clube de assinatura → Receber no cartão*): ClientId e Client Secret da conta Cielo
  dele, as URLs para colar na Cielo, a taxa e os **recebidos no cartão** (também em *Financeiro →
  Recebimentos*).

Para ligar (master e cada barbearia, cada um na sua conta Cielo): contratar o **Link de Pagamento**
no site da Cielo (sem mensalidade), ligar o **Recebimento Automático** (dinheiro em 1 dia útil),
pegar o **ClientId** e o **Client Secret** em Configurações e colar lá a **URL de notificação**
(nos campos de notificação e de mudança de status) e a **URL de retorno** que o painel mostra.
Para testar sem cobrar ninguém, use o modo de teste da loja na Cielo.

Comparativo das tabelas públicas (outubro de 2026, crédito à vista online; as taxas mudam e são
negociáveis, confira no app de cada uma):

| Plataforma | Taxa para receber em cerca de 1 dia | Cobrança recorrente pelo sistema (API) |
|---|---|---|
| **Cielo** (Link de Pagamento) | **3,48%** (com o Recebimento Automático) | Sim |
| Stone (link) | 2,99% (dia seguinte) | Não: a assinatura só é criada no app |
| Pagar.me | 4,19% (dia seguinte, após análise) | Sim |
| InfinitePay | 4,20% (1 dia útil) | Não: a recorrência só é criada no app |
| Asaas | 2,99% + R$ 0,49 em 32 dias; antecipação de 1,15% a 1,25% ao mês (até 2 dias úteis) | Sim |
| Mercado Pago | 4,98% (na hora) | Sim |
| PagBank | 4,99% + R$ 0,40 (o mais rápido é 14 dias) | Sim |

## Pagamentos: cada um vê só o que é seu

- **Master**: só as **mensalidades** que as barbearias pagam a ele. O que os clientes pagam às
  barbearias não passa pela plataforma e não aparece para o master.
- **Barbearia** (*Financeiro → Recebimentos*): tudo o que os clientes pagaram (vendas da agenda e
  do balcão, mensalidades do clube no PIX ou no cartão), com o cliente, a forma e a **cópia do
  comprovante** do PIX quando o cliente mandou.
- **Barbeiro** (*Minha agenda* e *Meus ganhos*): só **a parte dele**. No atendimento fechado
  aparece a comissão dele (não o total pago); em *Meus ganhos*, a parte dele no período, os
  atendimentos, o que tem a receber e os pagamentos recebidos.
- **Cliente** (*Meus pagamentos*, na área dele): só os pagamentos dele (compras e clube), com a
  forma, a situação e o comprovante que mandou.

**Comprovante do PIX.** Na área do cliente, junto do PIX do clube, o botão *Paguei: enviar
comprovante* aceita foto, print ou PDF (até 3 MB; a foto é reduzida no próprio celular antes de
subir). Vale como *Já paguei* (o clube já vale enquanto a barbearia confere) e a barbearia recebe
a **cópia**: no aviso do topo do painel (com a miniatura), na lista de assinantes, em
*Recebimentos* e numa mensagem no WhatsApp do dono, pelo WhatsApp da plataforma, com o link que
abre a conferência. O arquivo fica **fora da pasta pública**: só o próprio cliente e o dono abrem,
com login (o tipo é conferido pelo conteúdo; a foto abre na tela e o PDF baixa). *Não caiu*
descarta o comprovante, e o cliente pode mandar outro.

## Privacidade (LGPD) e segurança

- Termos de uso, política de privacidade da plataforma e **política de cada barbearia**
  (publicada no site dela). A conta do cliente só nasce com o **aceite**; o dono aceita os termos
  no primeiro acesso.
- O cliente **baixa os próprios dados** e **exclui a conta**; o dono faz o mesmo pelo Balcão
  (as vendas ficam no caixa sem identificar a pessoa).
- Limpeza automática: mensagens e comprovantes do PIX com mais de 1 ano, códigos com mais de 30
  dias, sessões vencidas. Excluir a conta apaga também os comprovantes do cliente.
- Os comprovantes ficam só no servidor (em `DATA_DIR/receipts`, fora da pasta pública) e não vão
  para a cópia de segurança externa.
- Cada barbearia só enxerga o que é dela; o barbeiro só o que é dele; o master só a plataforma.
- **Cópia de segurança** todo dia às 3h (guarda as últimas 14), com envio opcional para um
  armazenamento compatível com S3 (Cloudflare R2, Backblaze B2, AWS S3...) e criptografia
  opcional (AES-256-GCM). Como a cópia tem os dados de dentro das barbearias, o master só a
  **baixa criptografada** (precisa de `BACKUP_PASSWORD`); ela abre só com a senha, no restaurador.
- **Pagamento no cartão** só na página da Cielo: o sistema não recebe nem guarda dados de cartão.
  As credenciais da Cielo ficam no servidor e nunca voltam para a tela.

## Antes da primeira barbearia de verdade (piloto)

O master tem o checklist **"Pronto para o piloto?"** na aba *Sistema*:

1. `PUBLIC_URL` com **https** (links da área do cliente, webhooks e login seguro).
2. `DEMO_LOGIN_CODES=0` (senão o código de acesso aparece na tela).
3. **Cópia de segurança fora do servidor** (`BACKUP_S3_...`) funcionando; recomendado
   `BACKUP_PASSWORD` (guarde a senha fora do servidor).
4. **WhatsApp da plataforma** conectado (senha esquecida, lembrete da mensalidade, alerta de
   WhatsApp desconectado) e o **seu celular** em *Minha conta*.
5. **Dados da empresa** nos termos e na política (nome, CNPJ, e-mail).
6. **Recebimento das mensalidades**: chave PIX ou Asaas.
7. Opcional: **mensalidade no cartão automático** (Cielo configurada e recebendo os avisos).
8. Recomendado: `ANTHROPIC_API_KEY` para o robô conversar com IA.

Na barbearia, o resumo do painel mostra os **Primeiros passos** (marca, barbeiros, serviços,
WhatsApp conectado, celular do dono, primeiro cliente, primeiro atendimento fechado, chave PIX e
link do Google) e, opcional, o **cartão pela Cielo** em *Clube de assinatura*.

## Rodar no computador

Requer **Node 22.13+**.

```bash
npm install
npm run demo   # opcional: cria a "Barbearia Navalha de Ouro" (robô João) com dados de exemplo
npm run dev    # interface em http://localhost:5173 (API na porta 3000)
```

- Primeiro acesso em `http://localhost:5173`: crie o login **master**.
- Demonstração:
  - site em `/b/demo`;
  - painel do dono `demo@barbearia.com` / `demo12345`;
  - barbeiro Paulo `(11) 95555-4444` / `paulo1234`;
  - área do cliente em `/b/demo/conta` com o celular `(11) 99999-0000` (João). Sem WhatsApp
    conectado, o código aparece na tela em desenvolvimento.
  - A demo já tem vendas, despesas, comissões, estoque, um plano do clube (o Pedro é assinante),
    avaliações, uma indicação (o Pedro veio pelo João) e o aniversário do João chegando. O João
    toma uma cerveja toda sexta: marque um horário para ele e veja a pergunta da cerveja.
- Para o robô conversar com IA: `ANTHROPIC_API_KEY=... npm run dev`. Teste pela aba
  *Robô WhatsApp → Simulador*.

Outros comandos: `npm test` (agenda, costume, automações, robô, webhooks, área do cliente,
vouchers, financeiro, comissões, consumo, estoque, clube, comprovante do PIX, o que cada perfil
vê dos pagamentos, avaliações, indicação, aniversário, mensalidades, Asaas, cartão pela Cielo,
LGPD, cópia de segurança, acesso do barbeiro, limites do master, isolamento entre barbearias), `npm run typecheck`, `npm run build && npm start`.

## Hospedar

```bash
cp .env.example .env      # ajuste PUBLIC_URL, DOMAIN, ANTHROPIC_API_KEY e as cópias de segurança
docker compose --profile https up -d --build
```

O banco (SQLite), as imagens e os comprovantes do PIX ficam no volume `app-data` (`/data`). As automações rodam dentro do
próprio servidor, a cada minuto. Todas as variáveis estão comentadas no `.env.example`.

**Restaurar uma cópia de segurança** (com o sistema parado):

```bash
npm run restore -- barbearia-AAAA-MM-DD-HHMMSS.db.gz          # cópia local
npm run restore -- barbearia-AAAA-MM-DD-HHMMSS.db.gz.enc      # cópia criptografada, inclusive a baixada pelo master (pede BACKUP_PASSWORD)
npm run restore -- <arquivo> --forcar                          # substitui o banco atual
```

**Custo da IA:** cada mensagem respondida pelo robô consome tokens da Anthropic (o master vê o
consumo por barbearia nos últimos 30 dias). O padrão é o `claude-opus-5-5` com esforço baixo; dá
para trocar com `BOT_MODEL` e `BOT_EFFORT`. As respostas rápidas (SIM/NÃO/CANCELAR/PARAR/PAGUEI,
nota da avaliação) e todas as mensagens automáticas não usam IA.

## Como o código está organizado

```
server/
  db.ts             tabelas e migrações (SQLite nativo do Node)
  clock.ts, time.ts relógio de cada barbearia (fuso) e datas
  scheduling.ts     horários livres, marcação sem conflito, cancelamento
  habits.ts         descobre o horário de costume e o ritmo de cada cliente
  automations.ts    tudo que roda sozinho (a cada minuto)
  bot/              robô: tools.ts (ferramentas), brain.ts (Claude), inbound.ts (respostas rápidas e menu)
  whatsapp.ts       Meta Cloud API e Evolution API (envio, webhooks, conexão)
  templates.ts      modelos da Meta por tipo de mensagem
  messaging.ts      envio + histórico; platform.ts: WhatsApp da plataforma
  connection.ts     confere a conexão do WhatsApp e avisa o dono
  finance.ts        vendas, caixa, comissões, pagamentos aos barbeiros e relatórios
  stock.ts          estoque; consumption.ts: consumo de costume e itens separados
  charges.ts        cobranças PIX da barbearia (mensalidade do clube) e confirmação
  receipts.ts       comprovante do PIX (arquivo privado, cópia e aviso para a barbearia)
  payments.ts       pagamentos dos clientes: os de cada cliente e os recebimentos da barbearia
  club.ts           clube de assinatura; reviews.ts: avaliações
  growth.ts         indique um amigo e aniversário; offers.ts: benefícios e vouchers
  billing.ts        mensalidades da plataforma; asaas.ts: Asaas; invoiceReminders.ts
  cielo.ts          API do Link de Pagamento da Cielo; cardSettings.ts: contas Cielo da plataforma e das barbearias
  cards.ts          cartão: mensalidade e clube no automático, avisos da Cielo e conferência
  gatewayPayments.ts registro dos pagamentos online (o master vê só as mensalidades); asaasWebhook.ts: avisos do Asaas
  privacy.ts        LGPD; backup.ts: cópias de segurança; passwordReset.ts
  routes/           master, painel (shop, agenda, bot, finance, stock, club), barbeiro, cliente, público, webhooks
web/src/
  pages/ShopLanding.tsx   site da barbearia
  pages/CustomerArea.tsx  área do cliente (+ CustomerClub, CustomerGrowth)
  pages/Panel.tsx         painel do dono (pages/panel/*)
  pages/BarberApp.tsx     app do barbeiro
  pages/Master.tsx        painel master (pages/master/*)
  components/Checkout.tsx fechar atendimento / nova venda; Receipt.tsx: enviar e ver o comprovante
tools/                    seed-demo.ts (demonstração), restore-backup.ts (restaurar cópia)
```

## O que só dá para conferir com contas de verdade

Tudo acima tem teste automático e foi conferido no navegador com dados de demonstração. Ainda
precisam ser conferidos com as contas reais, no piloto: o envio pelo **WhatsApp oficial (Meta)**
e pela **Evolution** com os modelos aprovados, o **cartão e a cobrança automática na Cielo** e a
**cobrança e a nota fiscal no Asaas** (testados com simuladores das APIs), o envio da cópia de segurança para o seu
**armazenamento S3** e o **PIX** pago de verdade num aplicativo de banco.
