// Cria uma barbearia de demonstração (para apresentar a clientes): npm run demo
// Login do dono: demo@barbearia.com / demo12345 · Site: /b/demo
import { hashPassword } from '../server/auth.js';
import { get, nowIso, run, tx } from '../server/db.js';
import { addStamps } from '../server/loyalty.js';

if (get("SELECT 1 AS ok FROM barbershops WHERE slug = 'demo'")) {
  console.log('A barbearia "demo" já existe.');
  process.exit(0);
}

tx(() => {
  const now = nowIso();
  const shop = run(
    `INSERT INTO barbershops (slug, name, tagline, about, primary_color, accent_color, whatsapp, instagram, address, hours, created_at)
     VALUES ('demo', 'Barbearia Navalha de Ouro', 'Mais que um corte: uma comunidade.', ?, '#1c1917', '#f59e0b', '11988887777', '@navalhadeouro', 'Rua das Flores, 123 - Centro', 'Ter a Sáb, 9h às 20h', ?)`,
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
  item('service', 'Corte', 5000, 40, 'Máquina e tesoura, com lavagem.');
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

  const joao = run("INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, 'João Pereira', '11999990000', ?)", [shop, now]).lastInsertRowid;
  addStamps(shop, beerCampaign, joao, 3, null);
});

console.log('Barbearia demo criada. Login: demo@barbearia.com / demo12345 · Site: /b/demo · Cartão do João: (11) 99999-0000');
