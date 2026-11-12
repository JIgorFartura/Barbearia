import { defineConfig, devices } from '@playwright/test';

// Testes de clique de ponta a ponta nos caminhos que geram dinheiro. Rodam contra o build com a
// barbearia de demonstração (e2e/serve.mjs): npm run build && npm run e2e
const port = process.env.E2E_PORT ?? '3200';

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'celular', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'node e2e/serve.mjs',
    cwd: '..',
    // Pronto quando o master já existe (o serve.mjs cria logo depois de subir).
    url: `http://127.0.0.1:${port}/api/public/signup`,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
