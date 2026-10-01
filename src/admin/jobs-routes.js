import express from 'express';
import multer from 'multer';
import { createHash } from 'node:crypto';
import { concurrencyLimit, rateLimit } from '../http/limits.js';
import { JobError } from '../jobs/store.js';

// All sessions here represent the same configured administrator. Guest jobs will
// need a separate owner identity tied to an order; they are not mounted publicly.
const OWNER = 'administrator';

export function createAdminJobsRouter({ auth, aiService, jobs, enabled }) {
  const router = express.Router();
  router.use(auth.requireApi);
  router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (!enabled) { response.status(503).json({ error: 'Админ-панель не настроена на сервере' }); return; }
    next();
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024,
    files: 1, fields: 6, fieldSize: 800_000, parts: 7 },
  fileFilter: (_request, file, callback) => callback(/\.(csv|xlsx|json|txt)$/i.test(file.originalname) ? null :
    new JobError('Поддерживаются CSV, XLSX, JSON и TXT.'), true) });
  router.post('/', rateLimit({ max: 6, windowMs: 60_000 }), concurrencyLimit(2), upload.single('file'), async (request, response) => {
    try {
      const body = request.body ?? {};
      if (body.consentToAI !== 'true') throw new JobError('Подтвердите передачу данных внешнему ИИ для всех частей этого задания.');
      if (request.file && body.text?.trim()) throw new JobError('Выберите файл или вставьте текст, не оба сразу.');
      if (!request.file && (typeof body.text !== 'string' || !body.text.trim())) throw new JobError('Выберите файл или вставьте текст коллекции.');
      if (!request.file && body.text.length > 200_000) throw new JobError('Текст длиннее 200 000 символов. Разделите источник.');
      let fallbackAccountIds;
      try { fallbackAccountIds = JSON.parse(body.fallbackAccountIds ?? '[]'); }
      catch { throw new JobError('Обновите список участников обработки.'); }
      const route = await aiService.approve({ accountId: body.accountId,
        consentToAccountSwitch: body.consentToAccountSwitch === 'true', fallbackAccountIds });
      const source = request.file ? { filename: request.file.originalname.slice(-200), bytes: request.file.buffer } :
        { filename: 'collection.txt', bytes: Buffer.from(body.text, 'utf8') };
      const fingerprint = createHash('sha256').update(source.filename).update('\0').update(source.bytes)
        .update(JSON.stringify(route)).digest('hex');
      const job = jobs.create({ owner: OWNER, requestId: request.get('Idempotency-Key'), fingerprint, source, route });
      response.status(202).json({ job });
    } catch (error) { response.status(error.statusCode ?? 400).json({ error: error.message }); }
  });
  router.get('/', (_request, response) => response.json({ jobs: jobs.list(OWNER) }));
  router.get('/:id', (request, response, next) => {
    try { response.json({ job: jobs.get(OWNER, request.params.id) }); } catch (error) { next(error); }
  });
  router.get('/:id/result', (request, response, next) => {
    try { response.json(jobs.result(OWNER, request.params.id)); } catch (error) { next(error); }
  });
  router.post('/:id/cancel', (request, response, next) => {
    try { response.json({ job: jobs.cancel(OWNER, request.params.id) }); } catch (error) { next(error); }
  });
  router.post('/:id/consume', (request, response, next) => {
    try { response.json({ job: jobs.consume(OWNER, request.params.id) }); } catch (error) { next(error); }
  });
  router.use((error, _request, response, _next) => {
    response.status(error.statusCode ?? 400).json({ error: error instanceof JobError ? error.message :
      error.code === 'LIMIT_FILE_SIZE' ? 'Файл больше 8 МБ.' : 'Не удалось загрузить исходник. Проверьте его размер и повторите.' });
  });
  return router;
}
