# Mudanças

Cada versão instalada no servidor. A `main` é sempre a versão estável.

## 1.2.0

- **Página de vendas dentro do sistema**: a landing da Bladr (no visual feito no Framer) é a página
  inicial, com os preços vindos do master (`/api/public/pricing`) e a entrada e o cadastro numa janela
  (`/#entrar` e `/#cadastro`). Um servidor só, sem o plano pago do Framer.

## 1.1.0

- **Fila de reenvio do WhatsApp**: mensagem que falha tenta de novo 1, 5 e 15 minutos depois. Se não
  chegar, aviso no painel do dono e na tela Sistema do master (migração 42).
- **Saúde do sistema** (`/api/health`): 503 se o banco não responde ou se as automações travaram,
  para o monitor de disponibilidade avisar no celular.
- **Testes**: isolamento entre barbearias em todas as rotas, relógio padrão (com a suíte rodando
  também 120 dias adiantada e toda noite) e testes de ponta a ponta nas telas (cadastro, agendamento,
  comanda no PIX, barbeiro e fila).

## 1.0.0

Primeira versão para o piloto: robô do WhatsApp, agenda, fila de chegada, financeiro, clube de
assinatura, pagamentos (PIX, Asaas e Cielo), loja e parceiros no app, relatórios, mensalidades da
plataforma e o master. Acesso da equipe (`/b/<endereço>/equipe`) e do cliente no topo do site de
cada barbearia.
