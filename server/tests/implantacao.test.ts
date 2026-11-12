import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-implantacao-'));
process.env.AUTOMATIONS = '0';
process.env.ANTHROPIC_API_KEY = '';

const { all, run } = await import('../db.js');
const { ensureInvoices, platformSettings, savePlatformSettings } = await import('../billing.js');

const shop = (slug: string, extra: { waived?: boolean; cycle?: 'mensal' | 'anual' } = {}) =>
  run("INSERT INTO barbershops (slug, name, bot_name, monthly_price_cents, billing_day, setup_fee_waived, billing_months, created_at) VALUES (?, ?, 'João', 9990, 28, ?, ?, ?)", [
    slug,
    slug,
    extra.waived ? 1 : 0,
    extra.cycle === 'anual' ? 12 : 1,
    '2025-01-01T12:00:00.000Z',
  ]).lastInsertRowid;
const refs = (shopId: number) => all<{ reference: string; amount_cents: number }>('SELECT reference, amount_cents FROM invoices WHERE barbershop_id = ? ORDER BY id', [shopId]);

describe('taxa de implantação', () => {
  test('sem taxa configurada, nada muda', () => {
    const a = shop('sem-taxa');
    ensureInvoices();
    assert.deepEqual(
      refs(a).map((r) => r.reference.replace(/^\d{4}-\d{2}$/, 'mes')),
      ['mes'],
    );
  });

  test('com a taxa: vem uma vez, junto com a primeira cobrança; isenta e anual não pagam', () => {
    savePlatformSettings({ ...platformSettings(), setup_fee_cents: 19700, setup_free_on_annual: true });
    const nova = shop('nova');
    const isenta = shop('isenta', { waived: true });
    const anual = shop('anual', { cycle: 'anual' });
    ensureInvoices();
    ensureInvoices();
    assert.deepEqual(
      refs(nova).map((r) => [r.reference.replace(/^\d{4}-\d{2}$/, 'mes'), r.amount_cents]),
      [
        ['implantacao', 19700],
        ['mes', 9990],
      ],
    );
    assert.equal(refs(isenta).filter((r) => r.reference === 'implantacao').length, 0);
    assert.equal(refs(anual).filter((r) => r.reference === 'implantacao').length, 0, 'implantação grátis no anual');
    assert.equal(refs(anual).filter((r) => r.reference.startsWith('anual:')).length, 1);
  });

  test('quem já pagava antes da taxa existir não é cobrado', () => {
    const a = all<{ id: number }>("SELECT id FROM barbershops WHERE slug = 'sem-taxa'")[0].id;
    assert.equal(refs(a).filter((r) => r.reference === 'implantacao').length, 0);
  });
});
