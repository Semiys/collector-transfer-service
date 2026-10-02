import express from 'express';
import { createHmac } from 'node:crypto';
import { OrderError } from '../orders/store.js';
import { rateLimit } from '../http/limits.js';

// Admin drafts exercise durable metadata only. Payment, refund and AI execution
// have no HTTP endpoints here; provider integration must verify them separately.
export function createAdminOrdersRouter({ auth, store, adminCode }) {
  const router = express.Router();
  router.use(auth.requireApi);
  router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (!store) { response.status(503).json({ error: 'Учёт заказов не настроен.' }); return; }
    next();
  });
  router.use(express.json({ limit: '2kb' }));
  router.get('/', async (request, response, next) => {
    try {
      response.json(await store.list({ offset: request.query.offset === undefined ? 0 : Number(request.query.offset),
        limit: 20 }));
    } catch (error) { next(error); }
  });
  router.post('/', rateLimit({ max: 6, windowMs: 60_000 }), async (request, response, next) => {
    try {
      const input = request.body;
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some((key) => key !== 'requestId')) throw new OrderError('Черновик принимает только номер запроса, без коллекции.');
      if (typeof input.requestId !== 'string') throw new OrderError('Укажите номер запроса.');
      const accessToken = createHmac('sha256', adminCode).update('collector-admin-draft:v1:').update(input.requestId).digest('hex');
      const order = await store.create({ requestId: input.requestId, accessToken });
      response.status(201).json({ order });
    } catch (error) { next(error); }
  });
  router.delete('/:id', async (request, response, next) => {
    try { response.json(await store.discardDraft(request.params.id)); }
    catch (error) { next(error); }
  });
  router.use((_request, response) => response.status(404).json({ error: 'Маршрут заказа не найден.' }));
  router.use((error, _request, response, _next) => {
    response.status(error instanceof OrderError ? error.statusCode : 400).json({ error:
      error instanceof OrderError ? error.message : 'Не удалось выполнить операцию с заказом.' });
  });
  return router;
}
