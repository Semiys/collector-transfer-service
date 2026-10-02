import express from 'express';
import { OrderError } from './store.js';
import { parseOrderAccess } from './access.js';
import { concurrencyLimit, rateLimit } from '../http/limits.js';
import { publicOrder } from './public-state.js';

export function createGuestOrdersRouter({ orders, processingConfigured = false }) {
  const router = express.Router();
  router.use((_request, response, next) => {
    response.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    next();
  });
  router.get('/config', (_request, response) => response.json({ lookupAvailable: !!orders,
    creationAvailable: false, processingAvailable: processingConfigured, paymentAvailable: false }));
  router.post('/status', rateLimit({ max: 20, windowMs: 60_000 }),
    concurrencyLimit(2, { message: 'Проверка заказов сейчас занята. Повторите через несколько секунд.' }),
    express.json({ limit: '2kb' }), async (request, response, next) => {
      try {
        if (!orders) throw new OrderError('Проверка заказов ещё не настроена. Попробуйте позже.', 503);
        const body = request.body;
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            Object.keys(body).length !== 1 || !Object.hasOwn(body, 'code')) {
          throw new OrderError('Проверка принимает только код доступа, без файлов и содержимого коллекции.');
        }
        const order = await orders.get(parseOrderAccess(body.code));
        // Explicit public projection: no access hash, payment IDs, source or AI diagnostics.
        response.json({ order: publicOrder(order),
          processingAvailable: processingConfigured && order.paymentState === 'paid', paymentAvailable: false });
      } catch (error) { next(error); }
    });
  // No public create/pay/start/confirm routes: they need verified payment and consent first.
  router.use((_request, response) => response.status(404).json({ error: 'Страница заказа не найдена.' }));
  router.use((error, _request, response, _next) => {
    const invalidBody = ['entity.parse.failed', 'entity.too.large', 'encoding.unsupported', 'charset.unsupported'].includes(error.type);
    const status = error instanceof OrderError ? error.statusCode : invalidBody ? 400 : 503;
    response.status(status).json({ error: status === 503 ? 'Не удалось проверить заказ. Повторите позже.' :
      status === 404 ? 'Заказ не найден или код доступа неверен.' :
        error instanceof OrderError ? error.message : 'Некорректный запрос проверки заказа.' });
  });
  return router;
}
