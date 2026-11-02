import { shopNow } from './clock.js';
import { all, get, nowIso, run, tx } from './db.js';
import { HttpError } from './http.js';
import { photoFilesOf, removePhotoFiles } from './profile.js';
import { cancelAsaasChargeOf, cancelPixAuto, shopAsaasCall } from './shopAsaas.js';
import { purgeReceipts } from './receipts.js';

/**
 * LGPD. A barbearia é a controladora dos dados dos clientes dela; a plataforma é a operadora.
 * Aqui ficam os dados da empresa que aparecem nos termos, a exportação e a exclusão (anonimização)
 * dos dados de um cliente e a limpeza periódica do que não precisa ser guardado.
 */

export interface LegalInfo {
  company: string;
  document: string;
  email: string;
  address: string;
}

const LEGAL_KEYS: Record<keyof LegalInfo, string> = { company: 'legal_company', document: 'legal_document', email: 'legal_email', address: 'legal_address' };

export function legalInfo(): LegalInfo {
  const rows = all<{ key: string; value: string }>("SELECT key, value FROM platform_settings WHERE key LIKE 'legal_%'");
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    company: map.legal_company || 'Bladr',
    document: map.legal_document ?? '',
    email: map.legal_email ?? '',
    address: map.legal_address ?? '',
  };
}

export function saveLegalInfo(info: LegalInfo): void {
  tx(() => {
    for (const [field, key] of Object.entries(LEGAL_KEYS)) {
      run('INSERT INTO platform_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, info[field as keyof LegalInfo]]);
    }
  });
}

function assertCustomer(shopId: number, customerId: number): void {
  if (!get('SELECT 1 AS ok FROM customers WHERE id = ? AND barbershop_id = ? AND anonymized_at IS NULL', [customerId, shopId])) {
    throw new HttpError(404, 'Cliente não encontrado.');
  }
}

/** Tudo o que a barbearia guarda sobre o cliente (direito de acesso e portabilidade). */
export function exportCustomerData(shopId: number, customerId: number) {
  assertCustomer(shopId, customerId);
  const shop = get<{ name: string }>('SELECT name FROM barbershops WHERE id = ?', [shopId])!;
  return {
    gerado_em: nowIso(),
    barbearia: shop.name,
    cliente: get(
      `SELECT name AS nome, phone AS celular, birth_date AS nascimento, created_at AS cadastro, pref_weekday AS dia_costume, pref_time AS hora_costume,
              reminders_opt_out AS nao_quer_lembretes, privacy_accepted_at AS aceitou_privacidade, notes AS anotacoes_da_barbearia, cpf
         FROM customers WHERE id = ?`,
      [customerId],
    ),
    // As fotos abrem e podem ser baixadas na área do cliente (Meus cortes).
    fotos_do_corte: all(
      `SELECT p.created_at AS quando, b.name AS barbeiro, p.note AS descricao FROM cut_photos p LEFT JOIN barbers b ON b.id = p.barber_id
        WHERE p.customer_id = ? ORDER BY p.created_at DESC`,
      [customerId],
    ),
    lista_de_espera: all('SELECT date AS dia, period AS periodo, status AS situacao, created_at AS quando FROM waitlist WHERE customer_id = ? ORDER BY id', [customerId]),
    descontos_de_volta: all('SELECT percent AS desconto_percentual, valid_until AS marcando_ate, created_at AS quando FROM comeback_promos WHERE customer_id = ? ORDER BY id', [
      customerId,
    ]),
    pacotes: all(
      'SELECT name AS pacote, uses AS usos, used AS usados, price_cents AS valor_centavos, expires_on AS validade, status AS situacao, created_at AS comprado_em FROM customer_packages WHERE customer_id = ? ORDER BY id',
      [customerId],
    ),
    horarios: all(
      `SELECT a.starts_at AS quando, b.name AS barbeiro, a.service_name AS servico, a.price_cents AS valor_centavos, a.status AS situacao
         FROM appointments a JOIN barbers b ON b.id = a.barber_id WHERE a.customer_id = ? ORDER BY a.starts_at DESC`,
      [customerId],
    ),
    compras: all<{ id: number; date: string; total_cents: number }>("SELECT id, date, total_cents FROM sales WHERE customer_id = ? AND status = 'closed' ORDER BY date DESC", [
      customerId,
    ]).map((s) => ({
      data: s.date,
      total_centavos: s.total_cents,
      itens: all('SELECT name AS item, qty AS quantidade, total_cents AS valor_centavos FROM sale_items WHERE sale_id = ?', [s.id]),
    })),
    fidelidade: all(
      `SELECT c.name AS campanha, e.kind AS tipo, e.qty AS quantidade, e.created_at AS quando
         FROM loyalty_events e JOIN campaigns c ON c.id = e.campaign_id WHERE e.customer_id = ? ORDER BY e.created_at DESC`,
      [customerId],
    ),
    vouchers: all(
      'SELECT v.code AS codigo, o.title AS beneficio, v.status AS situacao, v.expires_on AS validade FROM vouchers v JOIN offers o ON o.id = v.offer_id WHERE v.customer_id = ?',
      [customerId],
    ),
    mensagens: all("SELECT direction AS sentido, body AS texto, created_at AS quando FROM messages WHERE customer_id = ? AND kind <> 'codigo' ORDER BY id", [customerId]),
    clube: all(
      `SELECT p.name AS plano, m.status AS situacao, m.paid_until AS pago_ate, m.created_at AS assinou_em, m.cancelled_at AS cancelou_em
         FROM club_members m JOIN club_plans p ON p.id = m.plan_id WHERE m.customer_id = ? ORDER BY m.id`,
      [customerId],
    ),
    cobrancas: all(
      `SELECT description AS descricao, amount_cents AS valor_centavos, status AS situacao, paid_at AS pago_em, created_at AS criada_em,
              receipt_at AS comprovante_enviado_em
         FROM charges WHERE customer_id = ? ORDER BY id`,
      [customerId],
    ),
  };
}

/**
 * Exclui os dados pessoais do cliente: apaga mensagens, comprovantes, fotos do corte, anotações, cartão,
 * vouchers, ofertas e sessões, cancela os horários futuros e tira nome e celular do cadastro. As vendas
 * continuam no caixa (obrigação fiscal), mas sem identificar a pessoa.
 */
export function anonymizeCustomer(shopId: number, customerId: number, now: Date = new Date()): void {
  assertCustomer(shopId, customerId);
  const phone = get<{ phone: string }>('SELECT phone FROM customers WHERE id = ?', [customerId])!.phone;
  const photos = photoFilesOf(customerId);
  // Débito automático e cobranças no Asaas da barbearia: cancelados lá também (depois do banco).
  const members = all<{ id: number }>("SELECT id FROM club_members WHERE customer_id = ? AND status <> 'cancelled'", [customerId]).map((m) => m.id);
  const asaasCharges = all<{ id: number }>("SELECT id FROM charges WHERE customer_id = ? AND status = 'open' AND asaas_payment_id IS NOT NULL", [customerId]).map((c) => c.id);
  const pixComandas = all<{ asaas_payment_id: string }>(
    "SELECT asaas_payment_id FROM pix_checkouts WHERE customer_id = ? AND status = 'pending' AND asaas_payment_id IS NOT NULL",
    [customerId],
  ).map((c) => c.asaas_payment_id);
  tx(() => {
    const stamp = shopNow(shopId, now).stamp;
    run("UPDATE appointments SET status = 'cancelled', cancelled_at = ? WHERE customer_id = ? AND status = 'scheduled' AND starts_at >= ?", [nowIso(), customerId, stamp]);
    run('DELETE FROM messages WHERE barbershop_id = ? AND (customer_id = ? OR phone = ?)', [shopId, customerId, phone]);
    // Clube: encerra a assinatura e as cobranças em aberto (as pagas ficam no caixa, sem identificar a pessoa).
    run("UPDATE club_members SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, ?) WHERE customer_id = ? AND status <> 'cancelled'", [nowIso(), customerId]);
    run("UPDATE charges SET status = 'cancelled' WHERE customer_id = ? AND status = 'open'", [customerId]);
    for (const table of [
      'loyalty_events',
      'vouchers',
      'bot_offers',
      'bot_questions',
      'customer_codes',
      'customer_sessions',
      'reviews',
      'waitlist',
      'cut_photos',
      'push_subscriptions',
      'comeback_promos',
      'pix_checkouts',
    ]) {
      run(`DELETE FROM ${table} WHERE customer_id = ?`, [customerId]);
    }
    run(
      `UPDATE customers SET name = 'Cliente removido', phone = ?, wa_id = NULL, pref_weekday = NULL, pref_time = NULL, pref_barber_id = NULL,
              pref_service_id = NULL, pref_interval_days = NULL, reminders_opt_out = 1, birth_date = NULL, referral_code = NULL, notes = NULL,
              cpf = NULL, asaas_shop_customer_id = NULL,
              anonymized_at = ? WHERE id = ?`,
      [`removido-${customerId}`, nowIso(), customerId],
    );
  });
  // Os arquivos (comprovantes e fotos) saem depois que o banco já foi atualizado.
  purgeReceipts({ customerId });
  removePhotoFiles(photos);
  for (const id of members) void cancelPixAuto(id);
  for (const id of asaasCharges) void cancelAsaasChargeOf(id);
  for (const id of pixComandas) void shopAsaasCall(shopId, 'DELETE', `/payments/${id}`).catch((err) => console.warn('[asaas da barbearia]', (err as Error).message));
}

/** Limpeza diária: o que não precisa mais ser guardado (mensagens e comprovantes antigos, códigos usados, sessões vencidas). */
export function purgeOldData(now: Date = new Date()): { messages: number; codes: number; receipts: number } {
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000).toISOString();
  const messages = run('DELETE FROM messages WHERE created_at < ?', [daysAgo(365)]).changes + run('DELETE FROM platform_messages WHERE created_at < ?', [daysAgo(365)]).changes;
  // Comprovante do PIX: guardado por 12 meses (o pagamento continua registrado no caixa).
  const receipts = purgeReceipts({ before: daysAgo(365) });
  const codes =
    run('DELETE FROM customer_codes WHERE created_at < ?', [daysAgo(30)]).changes + run('DELETE FROM password_codes WHERE created_at < ?', [daysAgo(30)]).changes;
  const iso = now.toISOString();
  run('DELETE FROM customer_sessions WHERE expires_at < ?', [iso]);
  run('DELETE FROM sessions WHERE expires_at < ?', [iso]);
  return { messages, codes, receipts };
}
