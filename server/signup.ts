import { hashPassword } from './auth.js';
import { platformSettings } from './billing.js';
import { all, get, nowIso, run, tx } from './db.js';
import { HttpError, normalizePhone } from './http.js';
import { sendPlatformMessage } from './platform.js';
import { assertFreeEmail, assertFreePhone, createShop, suggestSlug } from './shops.js';

/**
 * Cadastro sozinho: a barbearia cria a conta pelo site e começa nos dias grátis, já com o login do
 * dono (que aceitou os termos no cadastro). O master recebe um aviso no WhatsApp para dar as boas-vindas.
 */
export function signup(input: { shopName: string; name: string; phone: string; email: string | null; password: string }): { shopId: number; userId: number; slug: string } {
  const settings = platformSettings();
  if (!settings.signup_enabled) throw new HttpError(403, 'O cadastro pelo site está fechado no momento. Fale com a gente pelo WhatsApp.');
  const phone = normalizePhone(input.phone);
  const result = tx(() => {
    if (input.email) assertFreeEmail(input.email);
    assertFreePhone(phone);
    const slug = suggestSlug(input.shopName);
    // Começa no plano Equipe (o mais comum); o master ajusta depois do teste grátis.
    const plan = get<{ id: number }>("SELECT id FROM plans WHERE name = 'Equipe' AND active = 1");
    const shopId = createShop({ name: input.shopName, slug, planId: plan?.id ?? null });
    const userId = run("INSERT INTO users (barbershop_id, role, name, email, phone, password_hash, terms_accepted_at, created_at) VALUES (?, 'owner', ?, ?, ?, ?, ?, ?)", [
      shopId,
      input.name,
      input.email,
      phone,
      hashPassword(input.password),
      nowIso(),
      nowIso(),
    ]).lastInsertRowid;
    return { shopId, userId, slug };
  });
  // Aviso ao master (não atrasa o cadastro).
  for (const m of all<{ id: number; phone: string }>("SELECT id, phone FROM users WHERE role = 'master' AND phone IS NOT NULL")) {
    void sendPlatformMessage({
      phone: m.phone,
      text: `🆕 Nova barbearia no teste grátis: ${input.shopName} — ${input.name}, (${phone.slice(0, 2)}) ${phone.slice(2)}. Vale um oi de boas-vindas!`,
      kind: 'aviso',
      userId: m.id,
      shopId: result.shopId,
    });
  }
  return result;
}
