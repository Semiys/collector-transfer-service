import express from 'express';
import { createHash } from 'node:crypto';
import { CaptchaError } from '../http/captcha.js';
import { concurrencyLimit, rateLimit } from '../http/limits.js';

export const PROCESSING_VERSION = '2026-10-01';

export async function automaticDisclosure(store) {
  const accounts = store ? await store.list() : [];
  const owners = new Set();
  const route = accounts.filter((account) => {
    const owner = account.owner.trim().toLocaleLowerCase('ru');
    if (!account.enabled || owners.has(owner)) return false;
    owners.add(owner);
    return true;
  }).slice(0, 3).map(({ id, owner }) => ({ id, owner }));
  return {
    route,
    owners: route.map(({ owner }) => owner),
    revision: createHash('sha256').update(JSON.stringify(route)).digest('hex'),
  };
}

export function createAutomaticRouter({ captcha, store }) {
  const router = express.Router();
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
  router.get('/config', async (_request, response) => {
    try {
      const route = await automaticDisclosure(store);
      response.json({ policyVersion: PROCESSING_VERSION, owners: route.owners,
        routeRevision: route.revision, aiConfigured: route.owners.length > 0,
        processingAvailable: false, paymentAvailable: false });
    } catch {
      response.status(503).json({ error: 'Не удалось получить условия ИИ-переноса. Попробуйте позже.' });
    }
  });

  router.post('/check', rateLimit({ max: 6, windowMs: 60_000 }), concurrencyLimit(2),
    express.json({ limit: '8kb' }), async (request, response) => {
      try {
        const body = request.body;
        const fields = new Set(['policyVersion', 'consentToAI', 'acceptProcessing',
          'consentToAccountSwitch', 'routeRevision', 'captchaToken']);
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).some((field) => !fields.has(field))) {
          throw new CaptchaError('Этот этап принимает только подтверждения, без содержимого файла.', 400);
        }
        if (body.policyVersion !== PROCESSING_VERSION) {
          throw new CaptchaError('Условия обновились. Обновите страницу и подтвердите их снова.', 409);
        }
        if (body.consentToAI !== true || body.acceptProcessing !== true) {
          throw new CaptchaError('Подтвердите условия обработки и отправку данных внешнему ИИ.', 400);
        }
        const route = await automaticDisclosure(store);
        if (!route.owners.length) throw new CaptchaError('Ключи ИИ ещё не настроены администратором.', 503);
        if (body.routeRevision !== route.revision) {
          throw new CaptchaError('Список владельцев ключей изменился. Обновите страницу и подтвердите условия снова.', 409);
        }
        if (typeof body.consentToAccountSwitch !== 'boolean' ||
          (body.consentToAccountSwitch && route.owners.length < 2)) {
          throw new CaptchaError('Проверьте согласие на использование резервных ключей.', 400);
        }
        await captcha.verify({ token: body.captchaToken, action: 'collection_prepare',
          hostname: request.hostname, ip: request.ip });
        response.json({ verified: true, processingAvailable: false, paymentAvailable: false,
          message: 'Проверка пройдена. Оплата и автоматическое распознавание ещё не запущены. Файл не отправлен.' });
      } catch (error) {
        response.status(error instanceof CaptchaError ? error.statusCode : 503).json({
          error: error instanceof CaptchaError ? error.message : 'Проверка временно недоступна. Попробуйте позже.',
        });
      }
    });
  router.use((error, _request, response, _next) => {
    response.status(400).json({ error: error.type === 'entity.too.large' ? 'Запрос слишком большой' : 'Некорректный запрос' });
  });
  return router;
}
