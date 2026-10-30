import type { Router } from 'express';
import type { z } from 'zod';
import { shopId } from '../auth.js';
import { all, get, nowIso, run } from '../db.js';
import { HttpError, idParam, parseBody } from '../http.js';

interface CrudOptions {
  /** Caminho no roteador do painel, ex.: "/partners". */
  path: string;
  table: string;
  schema: z.ZodObject;
  order: string;
  /** Campos que apontam para outras tabelas da barbearia: { partner_id: 'partners' }. */
  refs?: Record<string, string>;
  label: string;
  /** Condição fixa (do código) das linhas que esta tela enxerga, ex.: "reward_only = 0". */
  scope?: string;
}

/**
 * Listar / criar / alterar / excluir sempre presos à barbearia do dono logado.
 * Os nomes de coluna vêm do schema (código), nunca do corpo da requisição.
 */
export function crudRoutes(router: Router, opts: CrudOptions): void {
  const columns = Object.keys(opts.schema.shape);
  const scope = opts.scope ? ` AND ${opts.scope}` : '';

  const parse = (req: { body: unknown }, shop: number) => {
    const data = parseBody(opts.schema, req.body) as Record<string, unknown>;
    for (const [field, table] of Object.entries(opts.refs ?? {})) {
      const ref = data[field];
      if (ref != null && !get(`SELECT 1 AS ok FROM ${table} WHERE id = ? AND barbershop_id = ?`, [ref, shop])) {
        throw new HttpError(400, `${field}: item não encontrado nesta barbearia.`);
      }
    }
    return data;
  };

  router.get(opts.path, (req, res) => {
    res.json(all(`SELECT * FROM ${opts.table} WHERE barbershop_id = ?${scope} ORDER BY ${opts.order}`, [shopId(req)]));
  });

  router.post(opts.path, (req, res) => {
    const shop = shopId(req);
    const data = parse(req, shop);
    const { lastInsertRowid } = run(
      `INSERT INTO ${opts.table} (barbershop_id, created_at, ${columns.join(', ')})
       VALUES (:barbershop_id, :created_at, ${columns.map((c) => `:${c}`).join(', ')})`,
      { ...data, barbershop_id: shop, created_at: nowIso() },
    );
    res.status(201).json(get(`SELECT * FROM ${opts.table} WHERE id = ?`, [lastInsertRowid]));
  });

  router.put(`${opts.path}/:id`, (req, res) => {
    const shop = shopId(req);
    const id = idParam(req);
    const data = parse(req, shop);
    const { changes } = run(
      `UPDATE ${opts.table} SET ${columns.map((c) => `${c} = :${c}`).join(', ')} WHERE id = :id AND barbershop_id = :barbershop_id${scope}`,
      { ...data, id, barbershop_id: shop },
    );
    if (!changes) throw new HttpError(404, `${opts.label} não encontrado(a).`);
    res.json(get(`SELECT * FROM ${opts.table} WHERE id = ?`, [id]));
  });

  router.delete(`${opts.path}/:id`, (req, res) => {
    const { changes } = run(`DELETE FROM ${opts.table} WHERE id = ? AND barbershop_id = ?${scope}`, [idParam(req), shopId(req)]);
    if (!changes) throw new HttpError(404, `${opts.label} não encontrado(a).`);
    res.json({ ok: true });
  });
}
