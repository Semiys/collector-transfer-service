import express from 'express';
import multer from 'multer';
import { automaticDisclosure, PROCESSING_VERSION } from '../automatic/routes.js';
import { CaptchaError } from '../http/captcha.js';
import { concurrencyLimit, rateLimit } from '../http/limits.js';
import { JobError } from '../jobs/store.js';
import { OrderError } from './store.js';
import { DeliveryError } from './delivery.js';
import { parseOrderAccess } from './access.js';
import { publicOrder, publicJob } from './public-state.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const guestProcessingConfigured = ({ orders, store, captcha }) =>
  !!orders && !!store && captcha.publicConfig().configured === true;

// No payment/create/mark-paid route exists here. Payment is read from the store.
// The code is a header so ownership is checked before an upload allocates RAM.
export function createGuestTransferRouter({ orders, processing, delivery, store, captcha }) {
  const router = express.Router();
  router.use((_request, response, next) => {
    response.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    next();
  });
  const stateLimit = rateLimit({ max: 60, windowMs: 60_000 });
  const startLimit = rateLimit({ max: 6, windowMs: 60_000 });
  const controlLimit = rateLimit({ max: 12, windowMs: 60_000 });
  const downloadLimit = rateLimit({ max: 8, windowMs: 60_000 });
  const reads = concurrencyLimit(2), starts = concurrencyLimit(2);
  const json = express.json({ limit: '2kb' });
  const upload = multer({ storage: multer.memoryStorage(), limits: {
    fileSize: 8 * 1024 * 1024, files: 1, fields: 7, fieldSize: 800_000, parts: 8,
  }, fileFilter: (_request, file, callback) => callback(
    /\.(csv|xlsx|json|txt)$/i.test(file.originalname) && file.originalname.length <= 200 ? null :
      new JobError('Нужен CSV, XLSX, JSON или TXT с именем до 200 символов.'), true) });

  async function authenticate(request, response, next) {
    try {
      if (!guestProcessingConfigured({ orders, store, captcha })) {
        throw new OrderError('Обработка заказов пока недоступна.', 503);
      }
      if (Object.keys(request.query).length) throw new OrderError('Передайте код доступа через защищённую форму заказа.');
      const access = parseOrderAccess(request.get('X-Order-Code'));
      const order = await orders.get(access);
      if (order.paymentState !== 'paid') throw new OrderError('Для переноса нужен подтверждённый платёж.', 402);
      response.locals.access = access;
      next();
    } catch (error) { next(error); }
  }
  function body(request, allowed) {
    const value = request.body;
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some((field) => !allowed.includes(field))) throw new JobError('Недопустимые поля запроса заказа.');
    return value;
  }
  function jobInput(request, response) {
    const value = body(request, ['jobId']);
    if (!UUID.test(value.jobId ?? '')) throw new JobError('Проверьте номер задания.');
    return { ...response.locals.access, jobId: value.jobId };
  }
  router.post('/conditions', stateLimit, reads, authenticate, json, async (request, response, next) => {
    try {
      body(request, []);
      const route = await automaticDisclosure(store);
      response.json({ policyVersion: PROCESSING_VERSION, routeRevision: route.revision,
        fallbackAvailable: route.route.length > 1, aiConfigured: route.owners.length > 0 });
    } catch (error) { next(error); }
  });
  router.post('/state', stateLimit, reads, authenticate, json, async (request, response, next) => {
    try {
      body(request, []);
      const result = await processing.get(response.locals.access);
      response.json({ order: publicOrder(result.order), jobs: result.jobs.map(publicJob) });
    } catch (error) { next(error); }
  });
  router.post('/start', startLimit, starts, authenticate, upload.single('file'), async (request, response, next) => {
    try {
      const value = body(request, ['policyVersion', 'routeRevision', 'consentToAI', 'acceptProcessing',
        'consentToAccountSwitch', 'captchaToken', 'text']);
      if (!UUID.test(request.get('Idempotency-Key') ?? '')) throw new JobError('Нужен номер запроса запуска.');
      if (value.policyVersion !== PROCESSING_VERSION) throw new JobError('Условия обновились. Подтвердите их снова.', 409);
      if (value.consentToAI !== 'true' || value.acceptProcessing !== 'true') {
        throw new JobError('Подтвердите отправку данных внешней нейросети и условия обработки.');
      }
      if (!['true', 'false'].includes(value.consentToAccountSwitch)) throw new JobError('Проверьте согласие на повторную отправку.');
      const route = await automaticDisclosure(store);
      if (!route.owners.length) throw new OrderError('Распознавание временно недоступно.', 503);
      if (value.routeRevision !== route.revision) throw new JobError('Участники обработки изменились. Подтвердите условия снова.', 409);
      const switching = value.consentToAccountSwitch === 'true';
      if (switching && route.route.length < 2) throw new JobError('Обновите условия повторной отправки.', 409);
      if (value.text !== undefined && typeof value.text !== 'string') throw new JobError('Проверьте исходный текст.');
      if (request.file && value.text?.trim()) throw new JobError('Выберите файл или текст, не оба сразу.');
      if (!request.file && (!value.text?.trim() || value.text.length > 200_000)) {
        throw new JobError('Нужен файл или непустой текст до 200 000 символов.');
      }
      await captcha.verify({ token: value.captchaToken, action: 'collection_recognize',
        hostname: request.hostname, ip: request.ip });
      if (request.aborted || response.destroyed) return;
      const source = request.file ? { filename: request.file.originalname, bytes: request.file.buffer } :
        { filename: 'collection.txt', bytes: Buffer.from(value.text, 'utf8') };
      const result = await processing.start({ ...response.locals.access, source,
        requestId: request.get('Idempotency-Key'), consentToAI: true, consentToAccountSwitch: switching,
        accountId: route.route[0].id, fallbackAccountIds: switching ? route.route.slice(1).map((item) => item.id) : [] });
      if (!response.destroyed) response.status(202).json({ order: publicOrder(result.order), job: publicJob(result.job) });
    } catch (error) { next(error); }
    finally { request.file = undefined; request.body = undefined; }
  });
  router.post('/cancel', controlLimit, reads, authenticate, json, async (request, response, next) => {
    try { response.json({ job: publicJob((await processing.cancel(jobInput(request, response))).job) }); }
    catch (error) { next(error); }
  });
  router.post('/preview', controlLimit, reads, authenticate, json, async (request, response, next) => {
    try { response.json(await delivery.preview(jobInput(request, response))); }
    catch (error) { next(error); }
  });
  router.post('/build', downloadLimit, starts, authenticate, express.json({ limit: '540kb' }), async (request, response, next) => {
    const controller = new AbortController();
    const disconnect = () => { if (!response.writableFinished) controller.abort(); };
    response.once('close', disconnect);
    try {
      const value = body(request, ['jobId', 'confirmedAudit', 'confirmedModels', 'options', 'edits', 'captchaToken']);
      if (!UUID.test(value.jobId ?? '') || !UUID.test(request.get('Idempotency-Key') ?? '')) throw new JobError('Проверьте номер задания и запроса скачивания.');
      if (value.confirmedAudit !== true || value.confirmedModels !== true || value.options?.acceptTextWarnings !== true) {
        throw new JobError('Подтвердите проверку моделей, исходных строк и замечаний.');
      }
      await captcha.verify({ token: value.captchaToken, action: 'collection_order_zip', hostname: request.hostname, ip: request.ip });
      if (response.destroyed) return;
      const result = await delivery.build({ ...response.locals.access, jobId: value.jobId,
        requestId: request.get('Idempotency-Key'), confirmedAudit: value.confirmedAudit, confirmedModels: value.confirmedModels,
        options: value.options, edits: value.edits }, { signal: controller.signal });
      if (response.destroyed) return;
      response.set({ 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="dom_collection_transfer.zip"',
        'X-Order-Receipt': result.receipt, 'X-Result-Expires-At': String(result.expiresAt),
        'X-Photo-Failed-Rows': result.failedPhotos.join(',') });
      response.send(Buffer.from(result.archive.buffer, result.archive.byteOffset, result.archive.byteLength));
    } catch (error) { next(error); }
    finally { response.removeListener('close', disconnect); request.body = undefined; }
  });
  router.post('/confirm-saved', controlLimit, reads, authenticate, json, async (request, response, next) => {
    try {
      const value = body(request, ['jobId', 'receipt', 'downloadSaved']);
      if (!UUID.test(value.jobId ?? '') || !/^[0-9a-f]{64}$/.test(value.receipt ?? '')) throw new JobError('Проверьте подтверждение скачивания.');
      const result = await delivery.confirmSaved({ ...response.locals.access, ...value });
      response.json({ order: publicOrder(result.order) });
    } catch (error) { next(error); }
  });
  router.use((_request, response) => response.status(404).json({ error: 'Действие заказа не найдено.' }));
  router.use((error, _request, response, _next) => {
    if (response.destroyed) return;
    const known = error instanceof OrderError || error instanceof JobError || error instanceof CaptchaError || error instanceof DeliveryError;
    const parserError = error instanceof multer.MulterError || ['entity.parse.failed', 'entity.too.large',
      'encoding.unsupported', 'charset.unsupported'].includes(error.type);
    const status = known ? error.statusCode : parserError ? 400 : 503;
    response.status(status).json({ error: status === 503 ? 'Обработка временно недоступна. Попробуйте позже.' :
      status === 404 ? 'Заказ или задание не найдены. Проверьте код доступа.' :
        known ? error.message : error.code === 'LIMIT_FILE_SIZE' ? 'Файл больше 8 МБ.' : 'Некорректный запрос или слишком большой исходник.' });
  });
  return router;
}
