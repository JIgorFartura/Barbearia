import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { E2E_NOW } from './now.mjs';

/** O navegador no mesmo relógio do servidor (quarta-feira, 10h em Brasília). */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.clock.install({ time: new Date(E2E_NOW) });
    await use(page);
  },
});
export { expect };

/** Dono, recepção e barbeiro da demonstração (tools/seed-demo.ts). */
export const DEMO = {
  owner: { login: 'demo@barbearia.com', password: 'demo12345' },
  barber: { login: '11955554444', password: 'paulo1234' },
  customerPhone: '11999990000',
};

/** Termos de uso no primeiro acesso: espera aparecer a tela esperada ou a dos termos, e aceita se for ela. */
export async function acceptTermsIfAsked(page: Page, ready: Locator) {
  const gate = page.getByText('Antes de começar');
  await expect(gate.or(ready).first()).toBeVisible();
  if (await gate.isVisible()) {
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Continuar' }).click();
    await expect(gate).toBeHidden();
  }
  await expect(ready).toBeVisible();
}

/** Celular novo a cada execução (o cadastro e o login do cliente são por celular). */
export const freshPhone = (prefix: string) => `${prefix}${String(Date.now()).slice(-8)}`;
