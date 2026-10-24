import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { loadUser } from './auth.js';
import { startAutomations } from './automations.js';
import { llmEnabled } from './bot/brain.js';
import { config } from './config.js';
import { HttpError, errorHandler } from './http.js';
import { authRouter } from './routes/auth.js';
import { customerRouter } from './routes/customer.js';
import { masterRouter } from './routes/master.js';
import { publicRouter } from './routes/public.js';
import { shopRouter } from './routes/shop.js';
import { uploadsRouter } from './routes/uploads.js';
import { webhooksRouter } from './routes/webhooks.js';

export const app = express();
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'img-src': ["'self'", 'data:', 'blob:'],
        'connect-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'font-src': ["'self'", 'data:'],
        'upgrade-insecure-requests': null,
      },
    },
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: false,
  }),
);
// Guarda o corpo original: a Meta assina o webhook sobre os bytes exatos.
app.use(
  express.json({
    limit: '5mb',
    verify: (req, _res, buf) => {
      (req as express.Request).rawBody = buf;
    },
  }),
);

// Além do cookie SameSite, recusa alterações vindas de outros sites (Origin diferente do host).
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.headers.origin) return next();
  let host = '';
  try {
    host = new URL(req.headers.origin).host;
  } catch {
    host = '';
  }
  const allowed = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean).map(String);
  if (!allowed.includes(host)) {
    res.status(403).json({ error: 'Origem não permitida.' });
    return;
  }
  next();
});

app.use('/api', loadUser);
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});
app.use('/api/auth', authRouter);
app.use('/api/public', publicRouter);
app.use('/api/master', masterRouter);
app.use('/api/shop', shopRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/customer/:slug', customerRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api', () => {
  throw new HttpError(404, 'Rota não encontrada.');
});

app.use('/uploads', express.static(config.uploadsDir, { maxAge: '30d', immutable: true, fallthrough: false }));

// Interface (build do Vite). Qualquer outra rota abre o app, que decide a tela pela URL.
const webDir = path.resolve('dist/web');
if (fs.existsSync(webDir)) {
  app.use(express.static(webDir, { index: false, maxAge: '1h' }));
  app.get('/{*path}', (_req, res) => {
    res.sendFile(path.join(webDir, 'index.html'));
  });
}

app.use(errorHandler);

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  app.listen(config.port, () => {
    console.log(`Sistema Barbearia em http://localhost:${config.port}`);
    console.log(llmEnabled() ? `Robô com IA ligado (${config.botModel}).` : 'Robô sem IA (defina ANTHROPIC_API_KEY): respostas por menu.');
  });
  if (config.automations) startAutomations();
}
