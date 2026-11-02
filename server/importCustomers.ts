import { nowIso, run, tx } from './db.js';
import { birthdayKey } from './growth.js';
import { HttpError, normalizePhone } from './http.js';
import { customerByPhone } from './messaging.js';

/**
 * Importação de clientes por planilha (CSV do sistema antigo ou do Excel): nome, celular e, se tiver,
 * o aniversário. Quem já está cadastrado (mesmo celular) fica como está; linhas sem nome ou com celular
 * inválido são puladas e voltam na lista para o dono conferir.
 */

export interface ImportRow {
  name?: string | null;
  phone?: string | null;
  birth?: string | null;
}

export interface ImportResult {
  created: number;
  skipped: { line: number; name: string; reason: string }[];
}

/** "25/12", "25/12/1990", "1990-12-25" → "12-25". */
export function parseBirth(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return birthdayKey(Number(m[3]), Number(m[2]));
  m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/.exec(t);
  return m ? birthdayKey(Number(m[1]), Number(m[2])) : null;
}

export function importCustomers(shopId: number, rows: ImportRow[]): ImportResult {
  const skipped: ImportResult['skipped'] = [];
  const seen = new Set<string>();
  let created = 0;
  tx(() => {
    rows.forEach((r, i) => {
      // Linha 1 é o cabeçalho da planilha.
      const line = i + 2;
      const name = (r.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (name.length < 2) return skipped.push({ line, name, reason: 'sem nome' });
      let phone: string;
      try {
        phone = normalizePhone(r.phone ?? '');
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        return skipped.push({ line, name, reason: 'celular inválido' });
      }
      const key = `${phone.slice(0, 2)}${phone.slice(-8)}`;
      if (seen.has(key) || customerByPhone(shopId, phone)) return skipped.push({ line, name, reason: 'já cadastrado' });
      seen.add(key);
      run('INSERT INTO customers (barbershop_id, name, phone, birth_date, created_at) VALUES (?, ?, ?, ?, ?)', [shopId, name, phone, parseBirth(r.birth), nowIso()]);
      created++;
    });
  });
  return { created, skipped };
}
