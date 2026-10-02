import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInput } from './transfer/parse-input.js';
import { suggestMapping, detectPriceCurrency } from './transfer/mapping.js';
import { getEurRate } from './transfer/cbr-rate.js';
import { buildArchive } from './transfer/build-archive.js';
import { createAccountStore } from './admin/account-store.js';
import { createAdminRouter } from './admin/routes.js';
import { createAdminSession } from './admin/session.js';
import { rateLimit } from './http/limits.js';
import { CaptchaError, createTurnstile } from './http/captcha.js';
import { createAutomaticRouter } from './automatic/routes.js';
import { createAiService } from './ai/service.js';
import { createJobStore } from './jobs/store.js';
import { createRecognitionWorker } from './jobs/recognize.js';
import { createAdminJobsRouter } from './admin/jobs-routes.js';
import { createOrderStore } from './orders/store.js';
import { createAdminOrdersRouter } from './admin/orders-routes.js';
import { createOrderProcessing, createOrderJobLifecycle } from './orders/processing.js';
import { createGuestOrdersRouter } from './orders/guest-routes.js';
import { createOrderDelivery } from './orders/delivery.js';
import { createArchiveCapacity } from './transfer/archive-capacity.js';
import { createGuestTransferRouter, guestProcessingConfigured } from './orders/transfer-routes.js';

export function createApp({ captcha, env = process.env, accountStore: suppliedStore, orderStore: suppliedOrders, aiFetchImpl = fetch } = {}) {
  captcha ??= createTurnstile({ env });
  const app = express();
  app.disable('x-powered-by');
  const trustedProxies = (env.TRUST_PROXY ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (trustedProxies.length) app.set('trust proxy', trustedProxies);
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const pagePath = path.resolve(currentDirectory, '../public/index.html');
  const guidePagePath = path.resolve(currentDirectory, '../public/guide.html');
  const automaticPagePath = path.resolve(currentDirectory, '../public/automatic.html');
  const automaticStylePath = path.resolve(currentDirectory, '../public/automatic.css');
  const processingPagePath = path.resolve(currentDirectory, '../public/processing.html');
  const adminPagePath = path.resolve(currentDirectory, '../public/admin.html');
  const adminScriptPath = path.resolve(currentDirectory, '../public/admin.js');
  const adminLoginPagePath = path.resolve(currentDirectory, '../public/admin-login.html');
  const adminLoginScriptPath = path.resolve(currentDirectory, '../public/admin-login.js');
  const themeStylePath = path.resolve(currentDirectory, '../public/theme.css');
  const themeScriptPath = path.resolve(currentDirectory, '../public/theme.js');
  const fontsPath = path.resolve(currentDirectory, '../public/fonts');
  const dataDir = env.DATA_DIR ?? path.resolve(currentDirectory, '../data');
  const accountStore = suppliedStore ?? (env.OPENROUTER_KEY_ENC_KEY ?
    createAccountStore({ dataDir, encryptionKey: env.OPENROUTER_KEY_ENC_KEY }) : null);
  const adminAuth = createAdminSession({ adminCode: env.ADMIN_ACCESS_TOKEN,
    secureCookie: env.COOKIE_SECURE === 'true' });
  const aiService = createAiService({ store: accountStore, fetchImpl: aiFetchImpl });
  const orderStore = suppliedOrders ?? (typeof env.ADMIN_ACCESS_TOKEN === 'string' && env.ADMIN_ACCESS_TOKEN.length >= 32 ?
    createOrderStore({ dataDir }) : null);
  const jobs = createJobStore({ run: createRecognitionWorker(aiService),
    ...(orderStore ? createOrderJobLifecycle(orderStore) : {}) });
  const orderProcessing = createOrderProcessing({ orders: orderStore, jobs, aiService });
  const archiveCapacity = createArchiveCapacity();
  const orderDelivery = createOrderDelivery({ orders: orderStore, jobs, capacity: archiveCapacity });
  app.locals.orderProcessing = orderProcessing;
  app.locals.orderDelivery = orderDelivery;
  app.locals.closeJobs = () => jobs.close();
  app.locals.closeOrders = async () => { await orderDelivery.close(); await orderProcessing.close(); await jobs.close(); await orderStore?.close(); };
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
  const previewLimit = rateLimit({ max: 30, windowMs: 60_000 });
  const convertLimit = rateLimit({ max: 8, windowMs: 60_000 });
  const convertConcurrency = archiveCapacity.middleware;

  app.get('/', (_request, response) => response.sendFile(pagePath));
  app.get('/guide', (_request, response) => response.sendFile(guidePagePath));
  app.get('/automatic', (_request, response) => response.sendFile(automaticPagePath));
  app.get('/automatic.css', (_request, response) => response.sendFile(automaticStylePath));
  app.get('/processing', (_request, response) => response.sendFile(processingPagePath));
  for (const script of ['captcha', 'automatic']) {
    app.get(`/${script}.js`, (_request, response) => response.sendFile(path.resolve(currentDirectory, `../public/${script}.js`)));
  }
  app.get('/api/captcha/config', (_request, response) => {
    response.set('Cache-Control', 'no-store').json(captcha.publicConfig());
  });
  app.use('/api/automatic', createAutomaticRouter({ captcha, store: accountStore }));
  const orderPageHeaders = (_request, response, next) => {
    response.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self'; font-src 'self'; connect-src 'self' https://challenges.cloudflare.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
    next();
  };
  app.get('/order', orderPageHeaders, (_request, response) => response.sendFile(path.resolve(currentDirectory, '../public/order.html')));
  app.get('/order.js', orderPageHeaders, (_request, response) => response.sendFile(path.resolve(currentDirectory, '../public/order.js')));
  app.get('/order-transfer.js', orderPageHeaders, (_request, response) => response.sendFile(path.resolve(currentDirectory, '../public/order-transfer.js')));
  app.get('/order-review.js', orderPageHeaders, (_request, response) => response.sendFile(path.resolve(currentDirectory, '../public/order-review.js')));
  app.use('/api/orders/transfer', createGuestTransferRouter({ orders: orderStore, processing: orderProcessing,
    delivery: orderDelivery, store: accountStore, captcha }));
  app.use('/api/orders', createGuestOrdersRouter({ orders: orderStore,
    processingConfigured: guestProcessingConfigured({ orders: orderStore, store: accountStore, captcha }) }));
  app.get('/theme.css', (_request, response) => response.sendFile(themeStylePath));
  app.get('/theme.js', (_request, response) => response.sendFile(themeScriptPath));
  for (const module of ['mapping', 'review']) {
    app.get(`/transfer/${module}.js`, (_request, response) =>
      response.sendFile(path.resolve(currentDirectory, `transfer/${module}.js`)));
  }
  app.use('/fonts', express.static(fontsPath, { immutable: true, maxAge: '1y' }));
  function adminHeaders(_request, response, next) {
    response.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
    next();
  }
  app.get('/admin/login', adminHeaders, (request, response) => {
    if (adminAuth.isAuthenticated(request)) response.redirect(303, '/admin');
    else response.sendFile(adminLoginPagePath);
  });
  app.get('/admin/login.js', adminHeaders, (_request, response) => response.sendFile(adminLoginScriptPath));
  app.get('/admin', adminHeaders, adminAuth.requirePage, (_request, response) => {
    response.sendFile(adminPagePath);
  });
  app.get('/admin.js', adminHeaders, adminAuth.requirePage, (_request, response) => response.sendFile(adminScriptPath));
  app.get('/admin-jobs.js', adminHeaders, adminAuth.requirePage, (_request, response) =>
    response.sendFile(path.resolve(currentDirectory, '../public/admin-jobs.js')));
  app.get('/admin-orders.js', adminHeaders, adminAuth.requirePage, (_request, response) =>
    response.sendFile(path.resolve(currentDirectory, '../public/admin-orders.js')));
  app.use('/api/admin/session', adminAuth.router);
  app.use('/api/admin/jobs', createAdminJobsRouter({ auth: adminAuth, aiService, jobs, enabled: !!accountStore }));
  app.use('/api/admin/orders', createAdminOrdersRouter({ auth: adminAuth, store: orderStore, adminCode: env.ADMIN_ACCESS_TOKEN }));
  app.use('/api/admin', createAdminRouter({ store: accountStore, auth: adminAuth, aiService }));

  app.get('/api/rates/eur', async (_request, response) => {
    try { response.json(await getEurRate()); }
    catch (error) { response.status(503).json({ error: error.message }); }
  });

  app.post('/api/preview', previewLimit, upload.single('file'), async (request, response) => {
    try {
      if (!request.file) throw new Error('Выберите файл коллекции');
      response.set('Cache-Control', 'no-store');
      const parsed = await parseInput(request.file.originalname, request.file.buffer);
      if (parsed.rows.length > 300) throw new Error('В одном переносе может быть не более 300 моделей. Разделите коллекцию на части.');
      const mapping = suggestMapping(parsed.headers);
      const rows = parsed.rows;
      response.json({ type: parsed.type, headers: parsed.headers, rowCount: parsed.rows.length,
        mapping, priceCurrency: parsed.priceCurrency ?? (mapping.price ? detectPriceCurrency(mapping.price) : 'RUB'),
        rows, warnings: parsed.warnings ?? [] });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post('/api/convert', convertLimit, convertConcurrency, upload.single('file'), async (request, response) => {
    try {
      const result = await response.locals.runArchiveTask(async (signal) => {
        if (!request.file) throw new Error('Выберите файл коллекции');
        await captcha.verify({ token: request.body.captchaToken, action: 'collection_zip',
          hostname: request.hostname, ip: request.ip });
        signal.throwIfAborted();
        const parsed = await parseInput(request.file.originalname, request.file.buffer);
        const mapping = JSON.parse(request.body.mapping ?? '{}');
        const options = JSON.parse(request.body.options ?? '{}');
        const edits = JSON.parse(request.body.edits ?? '[]');
        const eurRate = options.priceCurrency === 'EUR' ? await getEurRate(fetch, { signal }) : null;
        if (eurRate && options.expectedRateDate && options.expectedRateDate !== eurRate.date) {
          throw Object.assign(new Error('Курс ЦБ обновился. Обновите предпросмотр и повторите перенос.'), { statusCode: 409 });
        }
        return buildArchive({ parsed, mapping, options, edits, eurRate, signal });
      });
      if (response.destroyed) return;
      response.set({
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="dom_collection_transfer.zip"',
        'Cache-Control': 'no-store',
        'X-Photo-Failed-Rows': result.failedPhotos.join(','),
      });
      response.send(Buffer.from(result.archive));
    } catch (error) {
      if (response.destroyed) return;
      response.status(error instanceof CaptchaError ? error.statusCode : error.statusCode ?? (error.name === 'TimeoutError' ? 504 : 400))
        .json({ error: error.name === 'TimeoutError' ? 'Сборка превысила две минуты. Повторите позже.' : error.message });
    }
  });

  app.use((error, _request, response, _next) => {
    response.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ?
      'Файл больше 8 МБ' : 'Не удалось загрузить файл' });
  });

  return app;
}

const app = createApp();
export { app };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number.parseInt(process.env.PORT ?? '8080', 10);
  const closeResources = () => {
    void app.locals.closeOrders().catch(() => {
      console.error('Collector transfer service could not close its state'); process.exitCode = 1;
    });
  };
  const server = app.listen(port, '0.0.0.0', (error) => {
    if (error) {
      console.error('Collector transfer service could not start: ' + error.code);
      closeResources(); process.exitCode = 1;
      return;
    }
    console.log('Collector transfer service is listening on port ' + port);
  });
  server.once('close', closeResources);
}
