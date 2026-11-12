import { DEMO, acceptTermsIfAsked, expect, freshPhone, test } from './fixtures';

// Os caminhos que geram dinheiro, clicando como uma pessoa: se algum quebrar, o GitHub avisa antes de
// chegar às barbearias. Relógio: quarta-feira, 04/11/2026, 10h (o mesmo do servidor de teste).

test('a página de vendas mostra os planos do master e abre o cadastro', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Agenda cheia/ })).toBeVisible();
  const plans = page.locator('#planos');
  await expect(plans.getByText('Mais escolhido')).toBeVisible();
  await expect(plans.getByText('99,90')).toBeVisible();
  // O link /#cadastro (usado nos anúncios e no WhatsApp) abre direto o cadastro.
  await page.goto('/#cadastro');
  await expect(page.getByRole('dialog', { name: 'Criar minha barbearia' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('a barbearia cria a conta sozinha e monta a marca', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Testar grátis' }).first().click();
  const form = page.getByRole('dialog', { name: 'Criar minha barbearia' });
  await form.getByLabel('Nome da barbearia').fill('Barbearia Teste E2E');
  await expect(form.getByText('Seu site:')).toBeVisible();
  await form.getByLabel('Seu nome').fill('Rafael Teste');
  await form.getByLabel('Celular (WhatsApp)').fill(freshPhone('219'));
  await form.getByLabel('Senha').fill('senha-forte-1');
  await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: 'Criar minha barbearia', exact: true }).click();
  await expect(page.getByText('Monte sua marca em 1 minuto')).toBeVisible();
  await page.getByRole('button', { name: 'Usar esta marca' }).click();
  await page.goto('/painel');
  await expect(page.getByText('Primeiros passos')).toBeVisible();
  await expect(page.getByText(/Seu teste grátis vai até/)).toBeVisible();
});

test('cliente novo entra pelo celular e agenda um horário', async ({ page }) => {
  await page.goto('/b/demo');
  await page.getByRole('link', { name: /Área do cliente/ }).click();
  await page.getByLabel('Celular com DDD').fill(freshPhone('119'));
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByLabel('Seu nome').fill('Lucas Teste');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Continuar' }).click();
  // Sem WhatsApp conectado, a demonstração mostra o código na tela.
  const code = (await page.getByText(/seu código é \d{6}/).innerText()).match(/\d{6}/)![0];
  await page.getByLabel('Código de 6 dígitos').fill(code);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByText('Olá, Lucas!')).toBeVisible();

  await page.getByRole('button', { name: 'Agendar', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  const corte = await dialog.getByLabel('Serviço').locator('option', { hasText: /^Corte ·/ }).getAttribute('value');
  await dialog.getByLabel('Serviço').selectOption(corte!);
  await dialog.getByRole('button').filter({ hasText: /^qui/i }).first().click();
  await dialog.getByRole('button', { name: /^10:00/ }).first().click();
  await dialog.getByRole('button', { name: /^Confirmar quinta, 05\/11 às 10h/ }).click();
  await expect(page.getByText('Quinta, 05/11 às 10h')).toBeVisible();
  await expect(page.getByText(/Corte com \w+ · R\$\s50,00/)).toBeVisible();
});

test('o dono fecha a comanda no PIX e o atendimento fica pago', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Entrar', exact: true }).first().click();
  const login = page.getByRole('dialog', { name: 'Entrar' });
  await login.getByLabel('E-mail ou celular').fill(DEMO.owner.login);
  await login.getByLabel('Senha').fill(DEMO.owner.password);
  await login.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.waitForURL('**/painel');
  await page.goto('/painel/agenda');
  await acceptTermsIfAsked(page, page.getByText('15:00 Ricardo Vieira'));
  // O horário do Ricardo na agenda de hoje (cada horário é um item da lista).
  const card = page.getByRole('listitem').filter({ hasText: '15:00 Ricardo Vieira' });
  await card.getByRole('button', { name: 'Fechar', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Fechar atendimento')).toBeVisible();
  await dialog.getByRole('button', { name: 'PIX', exact: true }).click();
  await dialog.getByRole('button', { name: 'Registrar R$ 50,00 em PIX' }).click();
  // Confirmação: entrou no caixa, com a comissão calculada e o carimbo do cartão fidelidade.
  await expect(dialog.getByText('Venda registrada')).toBeVisible();
  await expect(dialog.getByText('Entrou no caixa e a comissão do barbeiro já foi calculada.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Concluir' }).click();
  await expect(dialog).toBeHidden();
  // Agora o horário mostra o pagamento e não tem mais "Fechar".
  await expect(card.getByText(/Pago R\$\s50,00 · PIX/)).toBeVisible();
  await expect(card.getByRole('button', { name: 'Fechar', exact: true })).toHaveCount(0);
});

test('o barbeiro entra pelo site da barbearia e vê a agenda dele', async ({ page }) => {
  await page.goto('/b/demo');
  await page.getByRole('link', { name: 'Equipe' }).click();
  await expect(page.getByText('Acesso da equipe: barbeiros, balcão e dono')).toBeVisible();
  await page.getByLabel('E-mail ou celular').fill(DEMO.barber.login);
  await page.getByLabel('Senha').fill(DEMO.barber.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await acceptTermsIfAsked(page, page.getByText('Murilo Vieira').first());
  // Só a agenda dele: o horário do Marcos não aparece.
  await expect(page.getByText('Ricardo Vieira')).toHaveCount(0);
});

test('cliente sem horário entra na fila de chegada pelo QR Code', async ({ page }) => {
  await page.goto('/b/demo/fila');
  await page.getByLabel('Seu nome').fill('Tiago Fila');
  await page.getByLabel('Celular (WhatsApp)').fill(freshPhone('119'));
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: 'Entrar na fila' }).click();
  await expect(page.getByText('Sua senha')).toBeVisible();
});
