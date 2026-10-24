// Cria uma barbearia de demonstração (para apresentar a clientes): npm run demo
// Login do dono: demo@barbearia.com / demo12345 · Site: /b/demo · Área do cliente: /b/demo/conta
import { hashPassword } from '../server/auth.js';
import { get, nowIso, run, tx } from '../server/db.js';
import { ensureInvoices, savePlatformSettings } from '../server/billing.js';
import { addEntry, createSale } from '../server/finance.js';
import { book } from '../server/scheduling.js';
import { stockEntry } from '../server/stock.js';
import { addDays, localNow, weekdayOf } from '../server/time.js';

if (get("SELECT 1 AS ok FROM barbershops WHERE slug = 'demo'")) {
  console.log('A barbearia "demo" já existe.');
  process.exit(0);
}

tx(() => {
  const now = nowIso();
  const shop = run(
    `INSERT INTO barbershops (slug, name, tagline, about, primary_color, accent_color, whatsapp, instagram, address, hours, bot_name, created_at)
     VALUES ('demo', 'Barbearia Navalha de Ouro', 'Mais que um corte: uma comunidade.', ?, '#1c1917', '#f59e0b', '11988887777', '@navalhadeouro', 'Rua das Flores, 123 - Centro', 'Ter a Sáb, 9h às 20h', 'João', ?)`,
    ['Desde 2015 cuidando do visual da rapaziada. Cerveja gelada, resenha boa e corte na régua.', now],
  ).lastInsertRowid;
  run("INSERT INTO users (barbershop_id, role, name, email, password_hash, created_at) VALUES (?, 'owner', 'Dono Demo', 'demo@barbearia.com', ?, ?)", [
    shop,
    hashPassword('demo12345'),
    now,
  ]);

  const item = (kind: string, name: string, price: number, duration: number | null, description: string | null = null) =>
    run('INSERT INTO catalog_items (barbershop_id, kind, name, description, price_cents, duration_min, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      shop,
      kind,
      name,
      description,
      price,
      duration,
      now,
    ]).lastInsertRowid;
  const corte = item('service', 'Corte', 5000, 40, 'Máquina e tesoura, com lavagem.');
  const barba = item('service', 'Barba', 3500, 30, 'Toalha quente e navalha.');
  item('service', 'Corte + Barba', 7500, 60);
  const beer = item('product', 'Cerveja long neck', 1200, null);
  const pomada = item('product', 'Pomada modeladora', 4500, null);
  // Estoque: a compra da semana passada entrou no caixa; as vendas abaixo dão baixa sozinhas.
  run('UPDATE catalog_items SET stock_min = 6 WHERE id IN (?, ?)', [beer, pomada]);
  stockEntry(
    shop,
    [
      { catalog_item_id: beer, qty: 24, unit_cost_cents: 450 },
      { catalog_item_id: pomada, qty: 6, unit_cost_cents: 2200 },
    ],
    { supplier: 'Distribuidora Sul', cash: { status: 'paid', date: addDays(localNow().date, -7), method: 'pix' }, userId: null },
  );

  const partner = (name: string, category: string, benefit: string) =>
    run('INSERT INTO partners (barbershop_id, name, category, benefit, instagram, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      shop,
      name,
      category,
      benefit,
      `@${name.toLowerCase().replace(/\W+/g, '')}`,
      now,
    ]).lastInsertRowid;
  const burger = partner('Brasa Burger', 'Hamburgueria', '10% de desconto mostrando o cartão');
  partner('Academia Força Total', 'Academia', 'Matrícula grátis para membros');

  run(
    "INSERT INTO ads (barbershop_id, partner_id, title, body, placement, price_cents, created_at) VALUES (?, ?, 'Combo do mês: burger + fritas + refri', 'Só R$ 39,90 na Brasa Burger, a duas quadras daqui.', 'destaque', 15000, ?)",
    [shop, burger, now],
  );

  // Cada cerveja e cada corte vendidos viram carimbo automaticamente.
  run(
    "INSERT INTO campaigns (barbershop_id, name, description, unit_label, goal, reward, catalog_item_id, created_at) VALUES (?, 'Clube da Cerveja', 'Cada long neck conta um carimbo.', 'cervejas', 5, 'Copo personalizado da barbearia', ?, ?)",
    [shop, beer, now],
  );
  run(
    "INSERT INTO campaigns (barbershop_id, name, unit_label, goal, reward, partner_id, catalog_item_id, created_at) VALUES (?, 'Corte Fiel', 'cortes', 10, 'Um corte grátis + um burger na Brasa', ?, ?, ?)",
    [shop, burger, corte, now],
  );

  // Barbeiros: terça a sábado, 9h às 20h (o Paulo almoça das 12h às 13h).
  // Paulo: 40% nos serviços, R$ 15 fixos por barba e 10% nos produtos; Marcos: 50% e 10%.
  const barber = (name: string, lunch: boolean, phone: string | null, service: number) => {
    const id = run('INSERT INTO barbers (barbershop_id, name, phone, service_commission, product_commission, created_at) VALUES (?, ?, ?, ?, 10, ?)', [
      shop,
      name,
      phone,
      service,
      now,
    ]).lastInsertRowid;
    for (let d = 2; d <= 6; d++) {
      const ranges = lunch ? [['09:00', '12:00'], ['13:00', '20:00']] : [['09:00', '20:00']];
      for (const [start, end] of ranges) run('INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)', [id, d, start, end]);
    }
    return id;
  };
  const paulo = barber('Paulo', true, '11955554444', 40);
  const marcos = barber('Marcos', false, null, 50);
  run("INSERT INTO barber_service_rates (barber_id, service_id, mode, value) VALUES (?, ?, 'fixed', 1500)", [paulo, barba]);

  run(
    "INSERT INTO offers (barbershop_id, title, description, valid_days, per_customer, created_at) VALUES (?, 'Cerveja grátis no próximo corte', 'Mostre o voucher no balcão.', 7, 1, ?)",
    [shop, now],
  );
  run(
    "INSERT INTO offers (barbershop_id, title, description, partner_id, valid_days, per_customer, max_total, created_at) VALUES (?, 'Batata grátis na Brasa Burger', 'Na compra de qualquer burger.', ?, 15, 1, 50, ?)",
    [shop, burger, now],
  );

  const customer = (name: string, phone: string) =>
    run('INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, ?, ?, ?)', [shop, name, phone, now]).lastInsertRowid;
  const joao = customer('João Pereira', '11999990000');
  const maria = customer('Maria Souza', '11988880000');
  const pedro = customer('Pedro Alves', '11977770000');
  const at = (date: string, time = '18:00') => new Date(`${date}T${time}:00-03:00`);

  // Histórico: o João vem toda sexta às 17h com o Paulo, corta e toma 1 cerveja (os carimbos saem das vendas).
  const today = localNow().date;
  let friday = addDays(today, -1);
  while (weekdayOf(friday) !== 5) friday = addDays(friday, -1);
  for (const weeks of [2, 1, 0]) {
    const date = addDays(friday, -7 * weeks);
    const a = book({ shopId: shop, customerId: joao, barberId: paulo, serviceId: corte, date, time: '17:00', source: 'painel' });
    createSale({ shopId: shop, userId: null, appointmentId: a.id, items: [{ catalog_item_id: corte, qty: 1 }, { catalog_item_id: beer, qty: 1 }], method: 'pix', now: at(date) });
  }
  // A Maria sumiu há 40 dias.
  const mariaDay = addDays(today, -40);
  const m = book({ shopId: shop, customerId: maria, barberId: marcos, serviceId: corte, date: mariaDay, time: '10:00', source: 'painel' });
  createSale({ shopId: shop, userId: null, appointmentId: m.id, items: [{ catalog_item_id: corte, qty: 1 }], method: 'dinheiro', now: at(mariaDay, '10:40') });
  // Movimento do mês: Pedro (corte + barba com o Marcos) e vendas de balcão.
  for (const [days, items, method] of [
    [-6, [{ catalog_item_id: corte, qty: 1, barber_id: marcos }, { catalog_item_id: barba, qty: 1, barber_id: marcos }], 'credito'],
    [-4, [{ catalog_item_id: pomada, qty: 1, barber_id: paulo }], 'dinheiro'],
    [-3, [{ catalog_item_id: barba, qty: 1, barber_id: paulo }, { catalog_item_id: beer, qty: 2, barber_id: paulo }], 'pix'],
    [-2, [{ catalog_item_id: corte, qty: 1, barber_id: marcos }], 'debito'],
  ] as const) {
    createSale({ shopId: shop, userId: null, customerId: days === -6 ? pedro : null, items: items.map((i) => ({ ...i })), method, now: at(addDays(today, days)) });
  }
  let next = addDays(today, 1);
  while (weekdayOf(next) < 2) next = addDays(next, 1);
  book({ shopId: shop, customerId: pedro, barberId: marcos, serviceId: corte, date: next, time: '10:00', source: 'painel' });

  // Gastos: aluguel e estoque pagos; conta de luz a pagar.
  addEntry(shop, { type: 'out', category: 'Aluguel', description: 'Aluguel do salão', amount_cents: 180000, method: 'pix', date: addDays(today, -5), status: 'paid' }, null);
  addEntry(shop, { type: 'out', category: 'Contas (água, luz, internet)', description: 'Conta de luz', amount_cents: 31500, method: null, date: addDays(today, 3), status: 'pending' }, null);

  // Plataforma: plano, PIX do master e um aviso para as barbearias.
  const plan = run("INSERT INTO plans (name, price_cents, description, active, created_at) VALUES ('Comunidade', 14990, 'Robô, agenda, financeiro e fidelidade', 1, ?)", [now]).lastInsertRowid;
  run('UPDATE barbershops SET plan_id = ?, billing_day = 10 WHERE id = ?', [plan, shop]);
  savePlatformSettings({ grace_days: 5, trial_days: 14, pix_key: 'pix@sistemabarbearia.com.br', pix_name: 'Sistema Barbearia', pix_city: 'São Paulo' });
  run(
    "INSERT INTO announcements (title, body, level, active, created_at) VALUES ('Financeiro integrado', 'Agora cada atendimento fechado na Agenda entra no caixa, calcula a comissão do barbeiro e dá o carimbo do cartão fidelidade.', 'novidade', 1, ?)",
    [now],
  );
});
ensureInvoices();

console.log('Barbearia demo criada. Painel: demo@barbearia.com / demo12345 · Site: /b/demo · Área do cliente: /b/demo/conta (João: (11) 99999-0000)');
