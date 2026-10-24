// Cria uma barbearia de demonstração (para apresentar a clientes): npm run demo
// Login do dono: demo@barbearia.com / demo12345 · Site: /b/demo · Área do cliente: /b/demo/conta
import { hashPassword } from '../server/auth.js';
import { get, nowIso, run, tx } from '../server/db.js';
import { addStamps } from '../server/loyalty.js';
import { book } from '../server/scheduling.js';
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
  item('service', 'Barba', 3500, 30, 'Toalha quente e navalha.');
  item('service', 'Corte + Barba', 7500, 60);
  const beer = item('product', 'Cerveja long neck', 1200, null);
  item('product', 'Pomada modeladora', 4500, null);

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

  const beerCampaign = run(
    "INSERT INTO campaigns (barbershop_id, name, description, unit_label, goal, reward, catalog_item_id, created_at) VALUES (?, 'Clube da Cerveja', 'Cada long neck conta um carimbo.', 'cervejas', 5, 'Copo personalizado da barbearia', ?, ?)",
    [shop, beer, now],
  ).lastInsertRowid;
  run(
    "INSERT INTO campaigns (barbershop_id, name, unit_label, goal, reward, partner_id, created_at) VALUES (?, 'Corte Fiel', 'cortes', 10, 'Um corte grátis + um burger na Brasa', ?, ?)",
    [shop, burger, now],
  );

  // Barbeiros: terça a sábado, 9h às 20h (o Paulo almoça das 12h às 13h).
  const barber = (name: string, lunch: boolean) => {
    const id = run('INSERT INTO barbers (barbershop_id, name, created_at) VALUES (?, ?, ?)', [shop, name, now]).lastInsertRowid;
    for (let d = 2; d <= 6; d++) {
      const ranges = lunch ? [['09:00', '12:00'], ['13:00', '20:00']] : [['09:00', '20:00']];
      for (const [start, end] of ranges) run('INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)', [id, d, start, end]);
    }
    return id;
  };
  const paulo = barber('Paulo', true);
  const marcos = barber('Marcos', false);

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
  addStamps(shop, beerCampaign, joao, 3, null);

  // Histórico: o João vem toda sexta às 17h com o Paulo; a Maria sumiu há 40 dias.
  const today = localNow().date;
  let friday = addDays(today, -1);
  while (weekdayOf(friday) !== 5) friday = addDays(friday, -1);
  for (const weeks of [0, 1, 2]) {
    book({ shopId: shop, customerId: joao, barberId: paulo, serviceId: corte, date: addDays(friday, -7 * weeks), time: '17:00', source: 'painel' });
  }
  book({ shopId: shop, customerId: maria, barberId: marcos, serviceId: corte, date: addDays(today, -40), time: '10:00', source: 'painel' });
  let next = addDays(today, 1);
  while (weekdayOf(next) < 2) next = addDays(next, 1);
  book({ shopId: shop, customerId: pedro, barberId: marcos, serviceId: corte, date: next, time: '10:00', source: 'painel' });
});

console.log('Barbearia demo criada. Painel: demo@barbearia.com / demo12345 · Site: /b/demo · Área do cliente: /b/demo/conta (João: (11) 99999-0000)');
