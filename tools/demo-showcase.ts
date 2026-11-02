// Vitrine da demonstração (o npm run demo chama depois do cadastro básico): quatro meses de movimento para a
// agenda, o caixa e os relatórios, a ficha do cliente com fotos, o horário vazio, pacotes, vale-presente, a
// recepção, uma segunda unidade e o recontato de quem sumiu (clientes que voltaram com o desconto, uma
// cliente na segunda mensagem e outros ainda na fila). O sorteio é sempre o mesmo: a demonstração sai igual.
import { hashPassword } from '../server/auth.js';
import { sendFollowUp, sendWinback } from '../server/automations.js';
import { all, get, nowIso, run, tx } from '../server/db.js';
import { createSale, type Method } from '../server/finance.js';
import { shopBot } from '../server/messaging.js';
import { sellGiftCard, sellPackage } from '../server/prepaid.js';
import { addPhoto, saveNotes } from '../server/profile.js';
import { saveIdleSettings } from '../server/promo.js';
import { iconPng } from '../server/pwa.js';
import { book } from '../server/scheduling.js';
import { createShop, linkOwner } from '../server/shops.js';
import { stockEntry } from '../server/stock.js';
import { addDays, addMinutes, daysBetween, localNow, weekdayOf } from '../server/time.js';
import { joinWaitlist } from '../server/waitlist.js';

/** Sorteio repetível (mulberry32). */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const at = (date: string, time: string) => new Date(`${date}T${time}:00-03:00`);
/** A barbearia abre de terça a sábado. */
const isWorkday = (d: string) => weekdayOf(d) >= 2 && weekdayOf(d) <= 6;
/** O dia de trabalho mais perto, para trás (-1) ou para a frente (+1). */
function workday(d: string, dir: 1 | -1): string {
  while (!isWorkday(d)) d = addDays(d, dir);
  return d;
}

interface Regular {
  name: string;
  phone: string;
  every: number;
  /** Última visita, em dias atrás. */
  lastAgo: number;
  barber: 'Paulo' | 'Marcos';
  time: string;
  service: 'Corte' | 'Barba' | 'Corte + Barba';
  beer?: boolean;
  /** Sem variação nas datas (os casos que a demonstração conta). */
  exact?: boolean;
}

// Os casos do recontato: Rafael sumiu (na fila), Diego sumiu (chamado há 3 dias), Lucas está passando do
// tempo (o robô chama em alguns dias) e Carlos foi chamado há 12 dias e voltou com o desconto.
const REGULARS: Regular[] = [
  { name: 'Gustavo Rocha', phone: '11971110003', every: 7, lastAgo: 3, barber: 'Paulo', time: '19:00', service: 'Barba', beer: true },
  { name: 'Vinícius Lopes', phone: '11971110016', every: 7, lastAgo: 4, barber: 'Marcos', time: '17:00', service: 'Barba' },
  { name: 'Felipe Araújo', phone: '11971110004', every: 14, lastAgo: 6, barber: 'Marcos', time: '15:00', service: 'Corte + Barba', beer: true },
  { name: 'Bruno Dias', phone: '11971110007', every: 14, lastAgo: 9, barber: 'Paulo', time: '17:00', service: 'Corte' },
  { name: 'Henrique Alves', phone: '11971110011', every: 14, lastAgo: 12, barber: 'Paulo', time: '10:00', service: 'Corte' },
  { name: 'Matheus Pinto', phone: '11971110014', every: 14, lastAgo: 5, barber: 'Marcos', time: '11:00', service: 'Corte' },
  { name: 'Eduardo Melo', phone: '11971110010', every: 10, lastAgo: 7, barber: 'Marcos', time: '18:00', service: 'Barba', beer: true },
  { name: 'Thiago Nunes', phone: '11971110005', every: 21, lastAgo: 10, barber: 'Paulo', time: '11:00', service: 'Corte' },
  { name: 'Igor Freitas', phone: '11971110012', every: 21, lastAgo: 15, barber: 'Marcos', time: '19:00', service: 'Corte + Barba', beer: true },
  { name: 'André Souza', phone: '11971110006', every: 30, lastAgo: 18, barber: 'Marcos', time: '09:00', service: 'Corte' },
  { name: 'Leonardo Costa', phone: '11971110013', every: 30, lastAgo: 11, barber: 'Paulo', time: '15:00', service: 'Corte' },
  { name: 'Caio Ribeiro', phone: '11971110008', every: 28, lastAgo: 20, barber: 'Marcos', time: '16:00', service: 'Corte' },
  { name: 'Rafael Lima', phone: '11971110001', every: 14, lastAgo: 22, barber: 'Paulo', time: '18:00', service: 'Corte', exact: true },
  { name: 'Diego Santos', phone: '11971110009', every: 21, lastAgo: 35, barber: 'Paulo', time: '14:00', service: 'Corte', exact: true },
  { name: 'Lucas Martins', phone: '11971110002', every: 21, lastAgo: 26, barber: 'Marcos', time: '10:00', service: 'Corte', exact: true },
  { name: 'Carlos Mendes', phone: '11971110015', every: 14, lastAgo: 33, barber: 'Paulo', time: '16:00', service: 'Corte', exact: true },
];

const FIRST = ['Ricardo', 'Fábio', 'Sérgio', 'Renato', 'Marcelo', 'Otávio', 'Murilo', 'Daniel', 'Samuel', 'Wesley', 'Kauã', 'Rodrigo', 'Alex', 'Breno', 'César'];
const LAST = ['Gomes', 'Teixeira', 'Moura', 'Farias', 'Duarte', 'Brito', 'Cardoso', 'Moreira', 'Batista', 'Prado', 'Vieira', 'Ramos', 'Campos', 'Barros', 'Pires', 'Rezende'];
/** Clientes de vez em quando: 120 nomes diferentes. */
const OCCASIONAL = Array.from({ length: 120 }, (_, i) => `${FIRST[i % FIRST.length]} ${LAST[(i * 7 + Math.floor(i / FIRST.length)) % LAST.length]}`);
/** Horários mais procurados (fim de tarde e começo da noite). */
const BUSY = ['09:30', '10:30', '11:00', '14:00', '15:00', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:00', '18:30', '17:30'];

export async function showcase(shopId: number): Promise<void> {
  const rnd = random(2015);
  const pick = <T>(list: readonly T[]) => list[Math.floor(rnd() * list.length)];
  const clock = localNow();
  const today = clock.date;
  const idOf = (sql: string, params: unknown[]) => get<{ id: number }>(sql, params)!.id;
  const barbers = {
    Paulo: idOf("SELECT id FROM barbers WHERE barbershop_id = ? AND name = 'Paulo'", [shopId]),
    Marcos: idOf("SELECT id FROM barbers WHERE barbershop_id = ? AND name = 'Marcos'", [shopId]),
  };
  const item = (name: string) => idOf('SELECT id FROM catalog_items WHERE barbershop_id = ? AND name = ?', [shopId, name]);
  const services = { Corte: item('Corte'), Barba: item('Barba'), 'Corte + Barba': item('Corte + Barba') };
  const beer = item('Cerveja long neck');
  const pomada = item('Pomada modeladora');
  const methods: Method[] = ['pix', 'pix', 'pix', 'credito', 'debito', 'dinheiro'];
  const customer = (name: string, phone: string) =>
    run('INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, ?, ?, ?)', [shopId, name, phone, at(addDays(today, -130), '12:00').toISOString()]).lastInsertRowid;
  const confirm = (id: number | null) => id && run('UPDATE appointments SET confirmed_at = ? WHERE id = ?', [nowIso(), id]);

  /** Marca o horário (meia hora depois, se estiver ocupado) e, se já passou, fecha a comanda. */
  function visit(customerId: number, barberId: number, date: string, time: string, serviceId: number, extras: number[] = []): number | null {
    for (let shift = 0; shift < 8; shift++) {
      const t = addMinutes(`${date} ${time}`, (shift % 2 ? -1 : 1) * Math.ceil(shift / 2) * 30).slice(11);
      if (t < '09:00' || t > '19:00' || (barberId === barbers.Paulo && t >= '11:30' && t < '13:00')) continue;
      let id = 0;
      try {
        id = book({ shopId, customerId, barberId, serviceId, date, time: t, source: 'painel' }).id;
      } catch {
        continue;
      }
      if (`${date} ${t}` < clock.stamp) {
        createSale({
          shopId,
          userId: null,
          appointmentId: id,
          items: [{ catalog_item_id: serviceId, qty: 1 }, ...extras.map((p) => ({ catalog_item_id: p, qty: 1 }))],
          method: pick(methods),
          now: at(date, addMinutes(`${date} ${t}`, 40).slice(11)),
        });
      }
      return id;
    }
    return null;
  }
  const anyService = () => pick([services.Corte, services.Corte, services.Corte, services.Barba, services['Corte + Barba']]);
  const anyBarber = () => pick([barbers.Paulo, barbers.Marcos]);

  const ids = tx(() => {
    // Cerveja e pomada para quatro meses de movimento.
    stockEntry(
      shopId,
      [
        { catalog_item_id: beer, qty: 120, unit_cost_cents: 450 },
        { catalog_item_id: pomada, qty: 12, unit_cost_cents: 2200 },
      ],
      { supplier: 'Distribuidora Sul', cash: { status: 'paid', date: addDays(today, -60), method: 'pix' }, userId: null, now: at(addDays(today, -60), '10:00') },
    );

    // Clientes fiéis, cada um no seu ritmo (os carimbos e o caixa saem das comandas).
    const people = new Map<string, number>();
    for (const r of REGULARS) {
      const id = customer(r.name, r.phone);
      people.set(r.name, id);
      const days: string[] = [];
      for (let d = workday(addDays(today, -r.lastAgo), -1); d >= addDays(today, -120); ) {
        days.unshift(d);
        const jitter = r.exact || r.every < 10 ? 0 : Math.round(rnd() * 4) - 2;
        d = workday(addDays(d, -(r.every + jitter)), -1);
      }
      for (const d of days) {
        const time = r.exact || rnd() < 0.7 ? r.time : addMinutes(`${d} ${r.time}`, rnd() < 0.5 ? -30 : 30).slice(11);
        visit(id, barbers[r.barber], d, time, services[r.service], r.beer && rnd() < 0.6 ? [beer] : []);
      }
      // Quem está para voltar nos próximos dias já marcou (metade confirmou pelo lembrete).
      const next = workday(addDays(days[days.length - 1], r.every), 1);
      if (!r.exact && next > today && next <= addDays(today, 7)) {
        const a = visit(id, barbers[r.barber], next, r.time, services[r.service]);
        if (rnd() < 0.5) confirm(a);
      }
    }

    // Clientes de vez em quando: a cada 3 ou 4 semanas; um em cada seis sumiu (sem ritmo: vale o prazo).
    const occasional: { id: number; last: string }[] = [];
    OCCASIONAL.forEach((name, i) => {
      const id = customer(name, `1197333${String(i).padStart(4, '0')}`);
      const gone = i % 6 === 5;
      const gap = 18 + Math.floor(rnd() * 14);
      let d = workday(addDays(today, -(gone ? 34 + Math.floor(rnd() * 30) : 1 + Math.floor(rnd() * 24))), -1);
      const last = d;
      for (let n = 0; n < 2 + Math.floor(rnd() * 3) && d >= addDays(today, -120); n++) {
        visit(id, anyBarber(), d, pick(BUSY), anyService(), rnd() < 0.25 ? [beer] : []);
        d = workday(addDays(d, -gap), -1);
      }
      occasional.push({ id, last });
    });
    // Quem vem de novo nos próximos dias: hoje (o que já passou está atendido e no caixa) e os seguintes.
    const booked = new Set(all<{ customer_id: number }>("SELECT customer_id FROM appointments WHERE barbershop_id = ? AND status = 'scheduled' AND starts_at >= ?", [shopId, clock.stamp]).map((r) => r.customer_id));
    const free = occasional.filter((o) => !booked.has(o.id) && daysBetween(o.last, today) >= 14 && daysBetween(o.last, today) <= 24);
    if (isWorkday(today)) {
      const slots: [string, keyof typeof barbers, keyof typeof services][] = [
        ['09:30', 'Marcos', 'Corte'],
        ['10:30', 'Paulo', 'Corte + Barba'],
        ['14:00', 'Paulo', 'Barba'],
        ['15:00', 'Marcos', 'Corte'],
        ['16:30', 'Paulo', 'Corte'],
        ['17:30', 'Marcos', 'Corte + Barba'],
        ['18:30', 'Paulo', 'Corte'],
        ['19:00', 'Marcos', 'Barba'],
      ];
      slots.forEach(([time, b, sv], i) => {
        const o = free.shift();
        if (o) {
          const a = visit(o.id, barbers[b], today, time, services[sv]);
          if (i % 2 === 0) confirm(a);
        }
      });
    }
    let next = today;
    for (let day = 0; day < 4; day++) {
      next = workday(addDays(next, 1), 1);
      for (let i = 0; i < (weekdayOf(next) >= 5 ? 7 : 4) && free.length; i++) {
        const o = free.shift()!;
        const a = visit(o.id, anyBarber(), next, pick(BUSY), anyService());
        if (day === 0 || rnd() < 0.4) confirm(a);
      }
    }
    // Balcão: pomada e cerveja sem horário.
    for (let d = addDays(today, -56); d < today; d = addDays(d, 1)) {
      if (isWorkday(d) && rnd() < 0.4) {
        createSale({ shopId, userId: null, items: [{ catalog_item_id: pick([pomada, beer]), qty: 1, barber_id: anyBarber() }], method: pick(methods), now: at(d, '13:10') });
      }
    }

    // Ficha do cliente: o jeito que o João gosta e as fotos dos dois últimos cortes.
    const joao = idOf("SELECT id FROM customers WHERE barbershop_id = ? AND name = 'João Pereira'", [shopId]);
    saveNotes(shopId, joao, 'Máquina 2 nas laterais, tesoura em cima. Risquinho do lado esquerdo. Pomada matte, pouca.');
    saveNotes(shopId, people.get('Gustavo Rocha')!, 'Barba desenhada, navalha só no pescoço. Gosta da toalha quente.');
    const photo = (bg: string, fg: string) => `data:image/png;base64,${iconPng(480, bg, fg, true).toString('base64')}`;
    const cuts = all<{ id: number; starts_at: string }>("SELECT id, starts_at FROM appointments WHERE customer_id = ? AND status = 'scheduled' AND starts_at < ? ORDER BY starts_at DESC LIMIT 2", [
      joao,
      clock.stamp,
    ]);
    const notes = ['Degradê navalhado, 0,5 na nuca', 'Tesoura em cima, risquinho do lado esquerdo'];
    cuts.reverse().forEach((c, i) =>
      addPhoto({ shopId, customerId: joao, dataUrl: photo(i ? '#78350f' : '#3f3f46', i ? '#fde68a' : '#f59e0b'), appointmentId: c.id, note: notes[i], userId: null, now: at(c.starts_at.slice(0, 10), '18:00') }),
    );

    // Horário vazio: 20% de terça a quinta, das 9h às 17h, para quem marca no mesmo dia.
    saveIdleSettings(shopId, { percent: 20, weekdays: [2, 3, 4], from: '09:00', until: '17:00' });
    // Recontato: 15% de desconto de volta (marcando em até 14 dias) e a segunda mensagem 7 dias depois.
    run('UPDATE barbershops SET winback_discount = 15, winback_discount_days = 14, winback_followup_days = 7 WHERE id = ?', [shopId]);

    // Pacotes e vale-presente.
    const pack = run(
      "INSERT INTO packages (barbershop_id, name, service_id, uses, price_cents, valid_days, description, created_at) VALUES (?, '5 cortes', ?, 5, 20000, 120, 'Cinco cortes pagando quatro.', ?)",
      [shopId, services.Corte, nowIso()],
    ).lastInsertRowid;
    run(
      "INSERT INTO packages (barbershop_id, name, service_id, uses, price_cents, valid_days, description, created_at) VALUES (?, 'Barba em dia', ?, 4, 11200, 90, 'Quatro barbas com 20% de desconto.', ?)",
      [shopId, services.Barba, nowIso()],
    );
    sellPackage({ shopId, customerId: people.get('Felipe Araújo')!, packageId: pack, method: 'pix', userId: null, now: at(workday(addDays(today, -20), -1), '15:40') });
    sellGiftCard({
      shopId,
      amountCents: 10000,
      validDays: 90,
      buyerName: 'Igor Freitas',
      recipientName: 'Ana',
      message: 'Feliz aniversário! Vai lá ficar na régua.',
      buyerCustomerId: people.get('Igor Freitas')!,
      method: 'pix',
      userId: null,
      now: at(workday(addDays(today, -5), -1), '18:20'),
    });

    // Lista de espera: o Thiago quer a tarde do próximo dia de trabalho.
    joinWaitlist({ shopId, customerId: people.get('Thiago Nunes')!, date: workday(addDays(today, 1), 1), period: 'tarde', source: 'whatsapp' });

    // Recepção: a Bruna cuida do balcão (sem o caixa): (11) 96666-5555 / recepcao123.
    run("INSERT INTO users (barbershop_id, role, name, phone, password_hash, terms_accepted_at, created_at) VALUES (?, 'reception', 'Bruna', '11966665555', ?, ?, ?)", [
      shopId,
      hashPassword('recepcao123'),
      nowIso(),
      nowIso(),
    ]);

    // Rede: a unidade do Centro, com um barbeiro e o movimento do mês.
    const owner = idOf("SELECT id FROM users WHERE barbershop_id = ? AND role = 'owner'", [shopId]);
    const unit = createShop({ name: 'Navalha de Ouro – Centro', slug: 'demo-centro', copyFrom: shopId, trialDays: 14 });
    linkOwner(owner, unit);
    const rodrigo = run("INSERT INTO barbers (barbershop_id, name, service_commission, created_at) VALUES (?, 'Rodrigo', 45, ?)", [unit, nowIso()]).lastInsertRowid;
    for (let d = 2; d <= 6; d++) run("INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES (?, ?, '09:00', '19:00')", [rodrigo, d]);
    const unitCut = run("INSERT INTO catalog_items (barbershop_id, kind, name, price_cents, duration_min, created_at) VALUES (?, 'service', 'Corte', 4500, 40, ?)", [unit, nowIso()]).lastInsertRowid;
    for (let d = `${today.slice(0, 8)}01`; d < today; d = addDays(d, 1)) {
      if (!isWorkday(d)) continue;
      for (let i = 0; i < 3; i++) createSale({ shopId: unit, userId: null, items: [{ catalog_item_id: unitCut, qty: 1, barber_id: rodrigo }], method: pick(methods), now: at(d, '16:00') });
    }
    const sumidos = occasional.filter((o) => daysBetween(o.last, today) >= 34);
    return { people, sumidos, maria: idOf("SELECT id FROM customers WHERE barbershop_id = ? AND name = 'Maria Souza'", [shopId]) };
  });

  // ---- recontato de quem sumiu: o que o robô fez nos últimos dias (com a data em que aconteceu).
  const shop = shopBot(shopId);
  const lite = (id: number) => get<{ id: number; name: string; phone: string; wa_id: string | null }>('SELECT id, name, phone, wa_id FROM customers WHERE id = ?', [id])!;
  const lastVisit = (id: number, before: string) =>
    get<{ d: string }>("SELECT MAX(substr(starts_at, 1, 10)) AS d FROM appointments WHERE customer_id = ? AND status = 'scheduled' AND starts_at < ?", [id, before])!.d;
  /** As mensagens do robô ficam com a data em que ele mandou. */
  async function on(when: Date, send: () => Promise<unknown>) {
    const before = get<{ id: number | null }>('SELECT MAX(id) AS id FROM messages')!.id ?? 0;
    await send();
    run('UPDATE messages SET created_at = ? WHERE id > ?', [when.toISOString(), before]);
  }
  /** O robô chamou o cliente nesse dia. */
  async function call(customerId: number, day: string, time = '10:00') {
    const last = lastVisit(customerId, `${day} 00:00`);
    await on(at(day, time), () => sendWinback(shop, lite(customerId), daysBetween(last, day), last, at(day, time)));
  }
  /** Ele marcou depois da mensagem (o desconto entra sozinho) e veio: comanda fechada. */
  function comeBack(customerId: number, bookedOn: string, day: string, barberId: number) {
    for (const time of ['16:00', '16:30', '17:00', '15:00', '14:00', '10:00', '10:30', '18:00']) {
      try {
        const a = book({ shopId, customerId, barberId, serviceId: services.Corte, date: day, time, source: 'whatsapp', now: at(bookedOn, '10:30') });
        createSale({ shopId, userId: null, appointmentId: a.id, items: [{ catalog_item_id: services.Corte, qty: 1, unit_price_cents: a.price_cents }], method: 'pix', now: at(day, addMinutes(`${day} ${time}`, 40).slice(11)) });
        return;
      } catch {
        /* horário ocupado: tenta outro */
      }
    }
  }
  // Carlos: chamado há 12 dias, marcou pelo WhatsApp e voltou há 8 com os 15%.
  const carlos = ids.people.get('Carlos Mendes')!;
  const carlosCall = workday(addDays(today, -12), -1);
  await call(carlos, carlosCall);
  comeBack(carlos, carlosCall, workday(addDays(today, -8), 1), barbers.Paulo);
  // Três dos que sumiram: dois voltaram com o desconto; um foi chamado há 5 dias e ainda não respondeu.
  const [s1, s2, s3] = ids.sumidos.sort((a, b) => a.last.localeCompare(b.last));
  for (const [s, ago, backAgo] of [
    [s1, 14, 9],
    [s2, 11, 4],
  ] as const) {
    if (!s) continue;
    const day = workday(addDays(today, -ago), -1);
    await call(s.id, day, '11:00');
    comeBack(s.id, day, workday(addDays(today, -backAgo), 1), anyBarber());
  }
  if (s3) await call(s3.id, workday(addDays(today, -5), -1), '10:30');
  // Maria: chamada há 9 dias; não respondeu, e a segunda mensagem saiu há 2 dias.
  const mariaCall = addDays(today, -9);
  await call(ids.maria, mariaCall);
  const mariaLast = lastVisit(ids.maria, `${mariaCall} 00:00`);
  const followUp = addDays(today, -2);
  await on(at(followUp, '10:00'), () => sendFollowUp(shopBot(shopId), lite(ids.maria), daysBetween(mariaLast, followUp), mariaLast, at(followUp, '10:00')));
  // Diego: chamado há 3 dias. O Rafael e os outros sumidos estão na fila do robô.
  await call(ids.people.get('Diego Santos')!, addDays(today, -3), '11:00');
}
