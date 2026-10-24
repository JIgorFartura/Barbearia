# Sistema Barbearia

Plataforma **white-label** para barbearias: o sistema é um só, e cada barbearia ganha o **próprio
site com a sua marca** (logo, cores, fotos, contatos) e um **painel só dela**.

A ideia: o cliente não vive só o corte, vive uma **experiência de comunidade**: campanhas de
fidelidade, benefícios em comércios parceiros e um mural com as novidades do bairro.

## Perfis

- **Master** (dono da plataforma): cadastra as barbearias e o login do dono de cada uma; pode suspender
  ou reativar uma barbearia.
- **Dono da barbearia**: cuida da marca, catálogo, parceiros, anúncios, campanhas e clientes. Nunca vê
  dados de outra barbearia.
- **Cliente** (sem login): acessa o site da barbearia e consulta o **cartão fidelidade pelo celular**.

## O que já funciona (v0.1)

| Módulo | O que faz |
|---|---|
| **Site da barbearia** (`/b/<endereço>`) | Mesmo modelo para todas, com as cores, logo, capa, frase, serviços, produtos, campanhas, parceiros, anúncios, endereço e botão de agendar pelo WhatsApp. Funciona no celular. |
| **Minha marca** | Logo, capa, cor principal e de destaque, WhatsApp, Instagram, endereço e horários, com prévia das cores. |
| **Serviços e produtos** | Catálogo com preço, duração e foto, exibido no site. |
| **Campanhas de fidelidade** | "Junte N, ganhe 1": *tomou 5 cervejas, ganhou um copo*. Período de validade, produto ligado e patrocínio de parceiro. |
| **Balcão** | Acha o cliente pelo nome ou celular, lança o consumo (+1, +2...), avisa quando ele ganha o prêmio, entrega o prêmio e mostra o extrato com opção de desfazer. |
| **Meu cartão** (no site) | O cliente digita o celular e vê os carimbos e prêmios (só o primeiro nome aparece). |
| **Parceiros** | Comércios do bairro com o benefício para membros (ex.: 10% de desconto mostrando o cartão). |
| **Anúncios** | Espaço de propaganda vendido no site: **destaque** (topo) ou **mural**. Valor cobrado, período, contagem de visualizações e cliques. |
| **Resumo** | Membros, carimbos e prêmios do mês, campanhas e anúncios no ar, receita de anúncios e ranking dos membros mais ativos. |

## Rodar no computador

Requer **Node 22.13+**.

```bash
npm install
npm run demo   # opcional: cria a "Barbearia Navalha de Ouro" para apresentar
npm run dev    # interface em http://localhost:5173 (API na porta 3000)
```

- Primeiro acesso em `http://localhost:5173`: crie o login **master**.
- Demonstração: site em `/b/demo`; login do dono `demo@barbearia.com` / `demo12345`;
  cartão do cliente pelo celular `(11) 99999-0000`.

Outros comandos: `npm test` (testes da API e das regras de fidelidade), `npm run typecheck`,
`npm run build && npm start` (versão de produção na porta 3000).

## Hospedar

```bash
cp .env.example .env      # ajuste PUBLIC_URL e DOMAIN
docker compose --profile https up -d --build
```

O banco (SQLite) e as imagens enviadas ficam no volume `app-data` (`/data`).

## Como o código está organizado

```
server/            API (Express 5 + SQLite nativo do Node)
  db.ts            tabelas: barbershops, users, catalog_items, partners, ads, campaigns,
                   customers, loyalty_events (extrato do cartão)
  loyalty.ts       regras do cartão fidelidade (carimbos, prêmios, validade)
  routes/master.ts painel master (barbearias)
  routes/shop.ts   painel do dono (tudo filtrado pela barbearia logada)
  routes/public.ts site público e "Meu cartão"
web/src/           interface (React 19 + Tailwind 4)
  pages/ShopLanding.tsx  site da barbearia
  pages/Panel.tsx        painel do dono
  pages/Master.tsx       painel master
```

## Próximos passos sugeridos

1. **Robô de agendamento no WhatsApp** (o mesmo para todas as barbearias, lendo serviços,
   horários e barbeiros de cada uma).
2. **Agenda e barbeiros**: horários livres, folgas, confirmação e lembrete automático.
3. **Níveis da comunidade** (Bronze, Prata, Ouro) por frequência, com benefícios.
4. **Domínio próprio por barbearia** (ex.: `navalhadeouro.com.br`) apontando para o mesmo sistema.
5. **Cobrança da mensalidade** das barbearias e relatório de anúncios para enviar ao parceiro.
