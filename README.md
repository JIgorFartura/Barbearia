# Bladr

Plataforma **white-label** para barbearias: o sistema é um só, e cada barbearia ganha o **próprio
site com a sua marca** (logo, cores, fotos, contatos), um **robô no WhatsApp com o nome que ela
escolher** e um **painel só dela**.

A ideia: o cliente não vive só o corte, vive uma **experiência de comunidade**: campanhas de
fidelidade, benefícios com voucher, clube de assinatura, indicação de amigos, presente de
aniversário, comércios parceiros e um robô que lembra dele (até da cerveja de sempre).

E o sistema trabalha pelo dono: a agenda se enche sozinha (lembrete com confirmação, lista de
espera, horário vazio com desconto, o robô chamando quem sumiu), o PIX do clube tem **baixa
automática** (e débito automático pelo **Pix Automático**), o dono pergunta ao **gerente virtual**
no WhatsApp quanto entrou e recebe o **resumo da semana**, e os **relatórios** mostram a ocupação
por dia e hora, quem está voltando e a previsão do mês. Cada barbearia tem o **app dela** para o
cliente instalar, com avisos no celular. Serve da barbearia de uma cadeira à **rede com filiais**.

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

| Relatórios | Ficha do cliente (fotos do corte) | Horário vazio com desconto |
|---|---|---|
| <img src="docs/img/relatorios.png" width="300" alt="Relatórios"> | <img src="docs/img/ficha-cliente.png" width="300" alt="Ficha do cliente"> | <img src="docs/img/horario-vazio.png" width="180" alt="Horário vazio com desconto"> |

| Repetir o último corte | PIX com confirmação automática | Pacote e vale-presente na comanda |
|---|---|---|
| <img src="docs/img/repetir-corte.png" width="180" alt="Repetir o último corte"> | <img src="docs/img/pix-automatico.png" width="180" alt="PIX com confirmação automática"> | <img src="docs/img/pacote-vale.png" width="300" alt="Pacote e vale-presente"> |

| PIX na comanda (confirma sozinho) |
|---|
| <img src="docs/img/pix-comanda.png" width="520" alt="PIX na comanda: QR na tela, aguardando o pagamento e PIX recebido"> |

| Recepção | Unidades da rede | Criar a barbearia (teste grátis) | Importar clientes |
|---|---|---|---|
| <img src="docs/img/recepcao.png" width="300" alt="Painel da recepção"> | <img src="docs/img/unidades.png" width="300" alt="Unidades da rede"> | <img src="docs/img/inicio.png" width="300" alt="Página inicial com o cadastro"> | <img src="docs/img/importar-planilha.png" width="260" alt="Importar clientes por planilha"> |

## Cinco perfis

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
  cópia dos **comprovantes** do PIX), **relatórios**, estoque, robô, avaliações, clube de assinatura,
  **pacotes e vale-presente**, campanhas, benefícios, indicação e promoções, parceiros, anúncios,
  barbeiros, serviços, produtos, marca, **unidades** e a própria mensalidade. Nunca vê dados de outra
  barbearia. Com **várias unidades** (rede), troca de unidade no topo do menu e vê os números de
  todas lado a lado.
- **Recepção** (o dono cria o login em *Barbeiros → Recepção*): agenda, balcão (clientes,
  carimbos, vouchers), ficha do cliente, comanda e venda de pacote e vale-presente. Não vê o caixa,
  os relatórios, as comissões, a mensalidade nem as configurações (o servidor libera só uma lista
  fechada de rotas para ela).
- **Barbeiro** (o dono libera em *Barbeiros → Acesso ao sistema*): entra pelo **celular** ou
  e-mail e vê só a **própria agenda**, fecha os **próprios atendimentos** (se o dono permitir),
  marca falta e acompanha **Meus ganhos** e a nota que os clientes dão para ele. Do dinheiro, vê só
  **a parte dele**: a comissão de cada atendimento, o que tem a receber e os pagamentos recebidos
  (não vê o total que o cliente pagou, o faturamento, o caixa nem a comissão dos colegas).
- **Cliente** (`/b/<endereço>/conta`): entra pelo celular com um **código enviado pelo robô no
  WhatsApp** (ou pelo link que o robô manda) e fica logado por 180 dias. Agenda e cancela, assina o
  **clube** e paga por PIX (com **confirmação automática** ou mandando o **comprovante**), pelo **Pix
  Automático** ou no **cartão**, vê **Meus pagamentos** (só os
  dele, com a **nota fiscal** quando a barbearia emite), o cartão fidelidade, pega vouchers, manda o
  **link de indicação**, informa o **aniversário** e o horário de costume, vê **Meus cortes** (as
  fotos), **repete o último corte** num toque, acompanha os **pacotes**, instala o **app da
  barbearia** com avisos no celular, **baixa os próprios dados** e pode **excluir a conta** (LGPD).

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
- *"Vou sim"* / *"não vou conseguir"* ao lembrete → confirma a presença ou cancela e oferece a vaga
  para a **lista de espera**. Dia lotado → *"me avisa se abrir vaga"* entra na lista de espera.
- Sabe dos **pacotes** do cliente (quantos usos sobram) e do **horário vazio com desconto** do dia.

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

- **Lembrete do horário** X horas antes (padrão 24h), pedindo a **confirmação** (SIM confirma; NÃO
  libera a vaga). Se o dono quiser, quem não confirma até N horas antes tem o horário liberado.
- **Lista de espera**: abriu vaga (cancelamento, horário liberado), o robô oferece na ordem da fila;
  cada um tem 30 minutos para responder SIM.
- **Horário vazio com desconto**: nos dias e horários fracos que o dono escolhe, às 9h o robô
  oferece as vagas do dia (com o desconto) para até 10 clientes que já estão na hora de cortar.
- **Resumo da semana** para o dono, toda segunda às 8h, no WhatsApp do sistema.
- **Avisos no celular** (app instalado): horário novo e cancelado para o barbeiro, o dono e a
  recepção; o lembrete do horário para o cliente.
- **Horário de costume**: o sistema descobre pelo histórico o dia, a hora, o barbeiro e o ritmo de
  cada cliente e, no dia escolhido (padrão: segunda às 9h), oferece o horário de sempre.
- **Cliente sumido**, pelo **ritmo de cada um**: quem já veio 3 vezes ou mais é chamado quando passa
  bem do tempo dele (corta a cada 20 dias → chamado no dia 30; a cada 40 → no dia 60); quem ainda não
  tem ritmo, depois do prazo da barbearia (padrão 30 dias). A mensagem sugere o horário de costume e
  pode levar um **desconto de volta** (ex.: 15% no próximo horário, marcando em até 14 dias), que entra
  sozinho no horário marcado pelo robô, pela área do cliente ou no balcão e aparece na agenda e na
  comanda (não soma com o horário vazio: fica o maior; cancelou, volta a valer). Quem não responde
  nem marca recebe uma **segunda mensagem** N dias depois (padrão 7), uma só. Em *Robô WhatsApp →
  Sumidos* o dono vê a fila, quem já foi chamado e **quantos voltaram** e quanto gastaram desde a
  mensagem. No mesmo dia, o cliente recebe no máximo uma oferta (costume, horário vazio ou
  recontato).
- **Avaliação depois do corte** (padrão 2h depois; no máximo uma por cliente a cada 30 dias).
- **Presente de aniversário** no dia, com voucher.
- **Mensalidade do clube** 3 dias antes de vencer (com o PIX em mensagem separada, fácil de
  copiar, e o link para pagar no cartão quando a barbearia aceita) e um lembrete se atrasar. No
  cartão automático não vai cobrança: só o aviso se o cartão não passar.

## Agenda e barbeiros

- **Agenda** por barbeiro, encaixe pelo balcão, falta, cancelamento e **fechar o atendimento**,
  com a **presença confirmada**, a **lista de espera** do dia e o preço do **horário vazio**.
- **Ficha do cliente** no cartão do horário: o jeito que ele gosta ("máquina 2 nas laterais") e as
  **fotos do corte** (tiradas no celular, com miniatura leve). Na próxima visita, qualquer barbeiro
  repete igual. O barbeiro só abre a ficha de quem é da agenda dele; o cliente vê as fotos em *Meus
  cortes* e pode apagar.
- **Horário vazio com desconto** (*Indicação e promoções*): nos dias e horários escolhidos, a vaga
  do dia sai com X% de desconto para quem marca no mesmo dia (marcando antes, preço normal).
- **Barbeiros**: expediente com pausas, folgas, bloqueios, comissão (por serviço, inclusive valor
  fixo) e acesso ao sistema. **Recepção**: logins do balcão, sem o financeiro.

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

**PIX com baixa automática (Asaas da barbearia).** Com a conta Asaas da própria barbearia ligada
(*Clube de assinatura → PIX com baixa automática*), a mensalidade sai com o PIX do Asaas e o
dinheiro cai direto na conta dela. Quando o cliente paga, o aviso do Asaas libera o mês, lança no
caixa e manda a confirmação no WhatsApp: o dono não confere extrato. O cliente informa o CPF uma
vez; sem ele, continua o PIX da chave com o comprovante. O mesmo vale para o **PIX na comanda**
(veja *Financeiro e estoque*).

**Pix Automático** (opcional; o Asaas libera na conta): o cliente autoriza pagando o 1º mês e, com
a autorização ativa, as mensalidades seguintes vão para o débito automático 8 dias antes do
vencimento e caem sozinhas. Cancelar o clube ou desligar o débito cancela também no Asaas.

## Financeiro e estoque

- **Fechar atendimento**: a comanda já vem com o serviço, o que o cliente pediu para separar e o
  que o clube cobre; dá para somar produtos, mudar quem atendeu, dar desconto e escolher a forma de
  pagamento.
- **PIX na comanda com confirmação automática** (com o Asaas da barbearia ligado): em PIX, o botão
  vira *Gerar PIX* e o QR aparece na tela para o cliente pagar no balcão. Nada entra no caixa
  enquanto espera; quando o Asaas avisa que caiu, a venda é registrada sozinha (caixa, comissão,
  estoque, carimbos e nota automática) e a tela mostra *PIX recebido*. O valor é o da comanda
  conferido no servidor (menos o vale-presente). Sem CPF na ficha, a tela pede o de quem paga (fica
  guardado); cliente de balcão sem cadastro paga só com o CPF. *Cancelar PIX* tira a cobrança do
  Asaas; se mesmo assim pagarem, o valor entra no caixa marcado *conferir*, sem virar venda em
  dobro. Dono e recepção usam; o PIX da chave continua em *Já recebi no PIX da chave*.
- **Caixa** (entradas, saídas, contas a pagar), **comissões** (a receber, extrato e *Pagar
  comissão*), **resumo** com gráfico, faturamento por barbeiro, formas de pagamento e gastos.
- **Recebimentos**: tudo o que os clientes pagaram no período (vendas da agenda e do balcão,
  mensalidades do clube no PIX ou no cartão), com o cliente, a forma e o comprovante do PIX.
- **Carimbo automático**: o produto ou serviço ligado a uma campanha vira carimbo no cartão.
- **Estoque**: entrada de mercadoria (com lançamento no caixa), contagem, perda, consumo interno,
  baixa automática na venda (volta no cancelamento), reservado para os horários marcados e aviso
  de **estoque acabando** no resumo.
- **Pacotes pré-pagos** (ex.: 5 cortes por R$ 200): vendidos no balcão, o dinheiro entra na hora;
  na comanda o serviço sai por R$ 0 *pelo pacote* e o barbeiro ganha a comissão sobre o valor de
  cada uso. O cliente vê os usos que sobram na área dele.
- **Vale-presente** com código (VP-XXXXXX), pronto para mandar pelo WhatsApp: paga a conta até o
  saldo e o resto vai na forma de pagamento. Cancelar a venda devolve o uso e o saldo.
- **Nota fiscal de serviço (NFS-e)** pelo Asaas da barbearia: quando o dono pedir (botão em *Vendas*)
  ou automática (toda venda com serviço de cliente com CPF e cada mensalidade do clube). Só os
  serviços entram; o PDF aparece na venda e em *Meus pagamentos* do cliente.
- **Relatórios**: entrou, atendimentos e ticket médio com a comparação, **previsão do mês**, mapa
  de calor da **ocupação por dia e hora** (e por barbeiro), **retorno dos clientes** e quem está
  passando do tempo de voltar (com botão para chamar no WhatsApp).

## Gerente virtual do dono (WhatsApp do sistema)

O dono conversa com o WhatsApp do sistema (o mesmo que avisa da mensalidade), do celular cadastrado
no login dele: *"quanto entrou hoje?"*, *"e a semana?"*, *"previsão do mês"*, *"agenda de
amanhã"*, *"quem está sumindo?"*, *"bloquear o Paulo amanhã das 14h às 16h"*, *"resumo"*. Com a IA
ligada entende frases livres; sem ela, responde às palavras-chave. O barbeiro pergunta *"agenda"*,
*"amanhã"* e *"ganhos"* (só os dele). Toda segunda às 8h chega o **resumo da semana** (entrou,
comparação, atendimentos, ocupação, faltas, clientes novos, nota dos clientes e quem mais atendeu);
dá para desligar em *Relatórios*. O master cadastra no WhatsApp da plataforma o endereço que recebe
as mensagens (aba *Sistema*).

## App instalável e avisos no celular

Cada barbearia tem o **app dela** (nome, cores e ícone dela) para o cliente instalar pela área do
cliente; o painel e o app do barbeiro instalam como o app da plataforma. Os **avisos no celular**
usam o padrão dos navegadores (Web Push, sem custo por mensagem, criptografado e assinado com a
chave da plataforma, gerada sozinha). No iPhone, os avisos funcionam com o app instalado (iOS 16.4
ou mais novo). Na área do cliente, **Repetir o último corte** já abre com o mesmo serviço, o mesmo
barbeiro, o dia em que ele costuma voltar e o horário de sempre.

## Rede com filiais

O dono abre mais unidades em *Unidades* (começam nos dias grátis, com as cores e o nome do robô da
unidade atual) e troca de unidade no topo do menu. Cada unidade tem agenda, barbeiros, robô, caixa e
mensalidade próprios; a tela *Unidades* mostra os números de todas lado a lado, e os avisos, o
resumo da semana e as notificações chegam ao dono de todas. O master também liga um dono já
cadastrado a outra barbearia.

## Cadastro sozinho e importação de clientes

- **Criar minha barbearia** na página inicial: nome, celular, senha e o aceite dos termos; começa
  nos dias grátis e já entra no painel. O master recebe um aviso no WhatsApp a cada cadastro e pode
  fechar o cadastro (*Financeiro → Cadastro aberto no site*, ao lado dos dias grátis).
- **Assistente de marca** (abre logo depois do cadastro e em *Minha marca*): o dono envia o logo e as
  cores saem dele sozinhas (a principal escurecida até o texto branco ficar legível), ou o sistema
  desenha um logo com as iniciais (círculo, quadrado ou selo). Escolhe a paleta (a do logo ou uma das
  prontas), a frase, vê como o site fica e salva tudo de uma vez.
- **Importar planilha** (*Balcão*): CSV do Excel, do Google Planilhas ou do sistema antigo, com
  nome, celular e aniversário. As colunas são achadas pelo cabeçalho, as primeiras linhas aparecem
  antes de importar, quem já está cadastrado fica como está e cada linha pulada diz o motivo.

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
- **Planos já cadastrados** numa instalação nova (o master pode mudar ou criar outros): Solo R$ 69,90
  (1 barbeiro), Equipe R$ 99,90 (2 a 6), Equipe 10 R$ 149,90 (7 a 10), Ilimitado R$ 189,90 e Rede
  de 2, 3, 4 ou 10 unidades (valor por unidade, barbeiros ilimitados). Quem se cadastra pelo site
  começa no Equipe; o master ajusta depois do teste grátis.
- **Períodos com desconto**: mensal, **trimestral (10%)**, **semestral (15%)** e **anual (25%)**, sobre
  as mensalidades do período (os descontos ficam nas configurações do master). A barbearia escolhe em
  *Mensalidade* (ou o master na mensalidade dela); a mensalidade do mês que ainda não venceu vira a
  fatura do período. Paga no **PIX**, no **boleto** ou no **cartão** pela página do Asaas (o cartão é
  digitado lá), parcelando até o número de meses do período (trimestral em 3x, anual em 12x): sem
  juros até 2x e, a partir de 3x, com juros ao mês (padrão 2,99%, tabela Price) **pagos por quem
  parcela**; a plataforma recebe o valor da fatura. Qualquer parcela aprovada baixa a fatura. Voltando
  para o mensal, o período já pago vale até o fim.
- **Taxa de implantação** (configurações do master; 0 = não cobra): vem **uma vez**, junto com a
  primeira cobrança depois do teste grátis, e dá para pagar no PIX, no boleto ou no cartão parcelado
  (até 3x). O master isenta por barbearia e pode deixar a implantação **grátis no semestral e no anual**
  (passando para eles, a implantação ainda não paga é cancelada). Quem já pagava antes não é cobrado.
- **Fim do teste grátis** (padrão numa instalação nova: **7 dias** e implantação de **R$ 197**, grátis
  no semestral e no anual): 2 dias antes de acabar, o dono recebe um aviso no WhatsApp da plataforma e o painel
  pergunta **"Quer continuar com o Bladr?"**. *Continuar* no mensal, trimestral, semestral ou anual
  (implantação grátis a partir do semestral) gera a cobrança, que vence no dia seguinte ao último dia grátis. *Não quero
  continuar* cancela a contratação (com o motivo, que vai para o master) e fecha o painel; os dados
  ficam guardados. Quem não responde segue no plano mensal, cobrado depois do teste.
- **Cortesia** (botão *Cortesia* na barbearia): a barbearia usa tudo **sem mensalidade até o master
  desmarcar**. Não sai fatura, o acesso não bloqueia, o cartão automático da mensalidade é desligado e
  as faturas em aberto que ainda não venceram são canceladas. A data "combinado até" e a anotação são
  só para lembrar; quando a data passa, o master vê o aviso na lista. O dono vê "cortesia" em *Mensalidade*.
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
  - recepção `(11) 96666-5555` / `recepcao123`;
  - barbeiro Paulo `(11) 95555-4444` / `paulo1234`;
  - área do cliente em `/b/demo/conta` com o celular `(11) 99999-0000` (João). Sem WhatsApp
    conectado, o código aparece na tela em desenvolvimento.
  - A demo já tem quatro meses de movimento (cerca de 140 clientes, agenda de hoje e dos próximos
    dias, caixa, comissões, estoque e os relatórios cheios), um plano do clube (o Pedro é
    assinante), avaliações, uma indicação (o Pedro veio pelo João), o aniversário do João chegando,
    a ficha do João com fotos, horário vazio (terça a quinta), pacotes, um vale-presente, a lista de
    espera, a unidade do Centro e o recontato em andamento (clientes que voltaram com o desconto,
    uma na segunda mensagem e outros na fila do robô). O João toma uma cerveja toda sexta: marque
    um horário para ele e veja a pergunta da cerveja.
- Para o robô conversar com IA: `ANTHROPIC_API_KEY=... npm run dev`. Teste pela aba
  *Robô WhatsApp → Simulador*.

Outros comandos: `npm test` (agenda, costume, automações, robô, webhooks, área do cliente,
vouchers, financeiro, comissões, consumo, estoque, clube, comprovante do PIX, o que cada perfil
vê dos pagamentos, avaliações, indicação, aniversário, mensalidades, Asaas, cartão pela Cielo,
LGPD, cópia de segurança, acesso do barbeiro, limites do master, isolamento entre barbearias,
confirmação e lista de espera, ficha do cliente, horário vazio, app e avisos no celular (com o
exemplo oficial da criptografia RFC 8291), gerente virtual e relatórios, pacotes e vale-presente,
recepção e rede, cadastro e importação, PIX com baixa automática e Pix Automático, PIX na comanda, nota fiscal,
recontato pelo ritmo com desconto de volta e segunda mensagem),
`npm run typecheck`, `npm run build && npm start`. Os testes rodam no GitHub a cada envio.

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
para trocar com `BOT_MODEL` (ex.: `claude-sonnet-5-5` ou o mais barato `claude-haiku-5-5`) e `BOT_EFFORT`. As respostas rápidas (SIM/NÃO/CANCELAR/PARAR/PAGUEI,
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
  attendance.ts     confirmação de presença; waitlist.ts: lista de espera
  profile.ts        ficha do cliente (anotações e fotos); files.ts: arquivos privados
  promo.ts, idle.ts horário vazio com desconto (a regra e a oferta da manhã); comeback.ts: desconto de volta
  push.ts, pwa.ts   avisos no celular (Web Push) e app instalável (manifest e ícones)
  insights.ts       indicadores (ocupação, retorno, previsão); manager.ts: gerente virtual e resumo da semana
  prepaid.ts        pacotes pré-pagos e vale-presente
  shops.ts          cadastro de barbearias e unidades da rede; signup.ts; importCustomers.ts
  shopAsaas.ts      Asaas da barbearia (PIX com baixa automática, Pix Automático); shopNfse.ts: nota fiscal
  pixCheckout.ts    PIX na comanda com confirmação automática (a venda fecha quando o Asaas avisa)
  routes/           master, painel (shop, agenda, bot, finance, stock, club, reports, prepaid, team), barbeiro, cliente, público, webhooks
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

Também no piloto:

- **Pix Automático**: o Asaas precisa liberar na conta da barbearia. Teste antes no sandbox: os
  campos da autorização seguem a referência oficial do Asaas (`POST /v3/pix/automatic/authorizations`
  com o QR Code do 1º pagamento e os avisos `PIX_AUTOMATIC_RECURRING_AUTHORIZATION_*`), conferida
  pela busca porque o site de documentação não abria no ambiente em que o sistema foi feito.
- **Nota fiscal da barbearia**: o cadastro na prefeitura e o certificado ficam na conta Asaas dela;
  emita uma nota de teste antes de ligar a automática.
- **Avisos no celular** num Android e num iPhone de verdade (no iPhone, com o app instalado).
- **Gerente virtual**: cadastrar no WhatsApp da plataforma o endereço que o master vê na aba
  *Sistema* e mandar uma mensagem do celular do dono.
