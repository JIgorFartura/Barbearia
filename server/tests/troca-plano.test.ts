import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-troca-plano-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { all, get, nowIso, run } = await import('../db.js');
const { changePlan, clubBilling, memberView, subscribe } = await import('../club.js');
const { confirmCharge } = await import('../charges.js');
const { shopBot } = await import('../messaging.js');

const shopId = run("INSERT INTO barbershops (slug, name, bot_name, created_at) VALUES ('navalha', 'Navalha de Ouro', 'João', ?)", [nowIso()]).lastInsertRowid;
const plan = (name: string, price: number) => run('INSERT INTO club_plans (barbershop_id, name, price_cents, created_at) VALUES (?, ?, ?, ?)', [shopId, name, price, nowIso()]).lastInsertRowid;
const basico = plan('Básico', 6000);
const premium = plan('Premium', 9000);
const customer = (name: string, phone: string) =>
  run('INSERT INTO customers (barbershop_id, name, phone, created_at) VALUES (?, ?, ?, ?)', [shopId, name, phone, nowIso()]).lastInsertRowid;
const at = (date: string) => new Date(`${date}T12:00:00-03:00`);
const openCharges = (memberId: number) =>
  all<{ amount_cents: number; description: string; plan_change_to: number | null }>("SELECT amount_cents, description, plan_change_to FROM charges WHERE club_member_id = ? AND status = 'open'", [memberId]);

describe('troca de plano do clube', () => {
  const joao = customer('João Pereira', '11999990000');
  let memberId = 0;

  test('subir de plano no meio do mês cobra só a diferença dos dias que faltam; o plano novo vale quando paga', () => {
    memberId = subscribe(shopId, joao, basico, { now: at('2026-11-01'), paidMethod: 'pix' }).id;
    // Mês de 01/11 a 30/11 (30 dias); no dia 11 faltam 20: (R$ 90 − R$ 60) × 20/30 = R$ 20.
    const r = changePlan(shopId, memberId, premium, at('2026-11-11'));
    assert.equal(r.mode, 'diferenca');
    assert.equal(r.member.plan.id, basico, 'enquanto não paga, segue no plano atual');
    assert.deepEqual(openCharges(memberId), [{ amount_cents: 2000, description: 'Troca para o Clube Premium · diferença até 30/11', plan_change_to: premium }]);

    const charge = get<{ id: number }>("SELECT id FROM charges WHERE club_member_id = ? AND status = 'open'", [memberId])!;
    confirmCharge(shopId, charge.id, { method: 'pix', userId: null, now: at('2026-11-11') });
    const m = memberView(memberId, at('2026-11-11'));
    assert.deepEqual([m.plan.id, m.state, m.paid_until], [premium, 'ok', '2026-11-30']);
  });

  test('descer de plano vale na próxima mensalidade, sem devolução', async () => {
    const r = changePlan(shopId, memberId, basico, at('2026-11-15'));
    assert.equal(r.mode, 'proximo');
    assert.deepEqual([r.member.plan.id, r.member.next_plan?.name], [premium, 'Básico']);
    assert.deepEqual(openCharges(memberId), []);

    await clubBilling(shopBot(shopId), at('2026-11-27'));
    const m = memberView(memberId, at('2026-11-27'));
    assert.equal(m.plan.id, basico, 'a mensalidade nova já sai no plano mais barato');
    assert.equal(m.next_plan, null);
    assert.deepEqual(
      openCharges(memberId).map((c) => c.amount_cents),
      [6000],
    );
  });

  test('a diferença que não foi paga cai na mensalidade seguinte e não segura a cobrança dela', async () => {
    const ana = customer('Ana Lima', '11988880000');
    const id = subscribe(shopId, ana, basico, { now: at('2026-11-01'), paidMethod: 'pix' }).id;
    changePlan(shopId, id, premium, at('2026-11-20'));
    assert.equal(openCharges(id).length, 1);
    await clubBilling(shopBot(shopId), at('2026-11-27'));
    assert.deepEqual(
      openCharges(id).map((c) => [c.amount_cents, c.plan_change_to]),
      [[6000, null]],
    );
    assert.equal(memberView(id, at('2026-11-27')).plan.id, basico);
  });

  test('assinatura ainda sem pagamento: troca na hora e a cobrança em aberto muda de valor', () => {
    const bia = customer('Bia Souza', '11977770000');
    const id = subscribe(shopId, bia, basico, { now: at('2026-11-05') }).id;
    const r = changePlan(shopId, id, premium, at('2026-11-05'));
    assert.equal(r.mode, 'agora');
    assert.equal(r.member.plan.id, premium);
    assert.deepEqual(
      openCharges(id).map((c) => c.amount_cents),
      [9000],
    );
    assert.throws(() => changePlan(shopId, id, premium, at('2026-11-05')), /já é o seu plano/);
  });

  test('no débito automático a troca passa pela barbearia', () => {
    const caio = customer('Caio Lima', '11966660000');
    const id = subscribe(shopId, caio, basico, { now: at('2026-11-01'), paidMethod: 'pix' }).id;
    run("UPDATE club_members SET pix_auto_status = 'ACTIVE' WHERE id = ?", [id]);
    assert.throws(() => changePlan(shopId, id, premium, at('2026-11-10')), /débito automático/);
  });
});
