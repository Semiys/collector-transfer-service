import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { recognizeCollectionText } from '../ai/openrouter.js';

function matchesToken(actual, expected) {
  const left = Buffer.from(actual ?? '');
  const right = Buffer.from(expected ?? '');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createAdminRouter({ store, token, fetchImpl = fetch, aiFetchImpl = fetch }) {
  const router = express.Router();
  router.use((request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (!store || !token || token.length < 32) {
      response.status(503).json({ error: 'Админ-панель не настроена на сервере' });
      return;
    }
    if (!matchesToken(request.get('X-Admin-Token'), token)) {
      response.status(401).json({ error: 'Неверный админ-токен' });
      return;
    }
    next();
  });
  router.use(express.json({ limit: '64kb' }));

  router.post('/ai/parse', async (request, response) => {
    try {
      const accountId = request.body?.accountId;
      if (typeof accountId !== 'string' || !accountId) throw new Error('Выберите включённый ключ OpenRouter');
      const apiKey = await store.getEnabledKey(accountId);
      const result = await recognizeCollectionText({
        text: request.body?.text, apiKey, model: 'openrouter/free', fetchImpl: aiFetchImpl,
      });
      response.json(result);
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  router.get('/accounts', async (_request, response) => {
    try { response.json({ accounts: await store.list() }); }
    catch (error) { response.status(500).json({ error: error.message }); }
  });
  router.post('/accounts', async (request, response) => {
    try { response.status(201).json(await store.add(request.body ?? {})); }
    catch (error) { response.status(400).json({ error: error.message }); }
  });
  router.get('/accounts/:id/check', async (request, response) => {
    try {
      const key = await store.getKey(request.params.id);
      const upstream = await fetchImpl('https://openrouter.ai/api/v1/key', {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(8_000),
      });
      if (upstream.status === 401 || upstream.status === 403) {
        response.json({ valid: false, reason: 'OpenRouter отклонил ключ' });
        return;
      }
      if (!upstream.ok) throw new Error(`OpenRouter временно недоступен: HTTP ${upstream.status}`);
      const data = (await upstream.json()).data;
      if (!data || typeof data !== 'object') throw new Error('OpenRouter вернул неожиданный ответ');
      response.json({ valid: true, freeTier: data.is_free_tier === true, expiresAt: data.expires_at ?? null });
    } catch (error) {
      response.status(error.message === 'Ключ не найден' ? 404 : 503).json({ error: error.message });
    }
  });
  router.patch('/accounts/:id', async (request, response) => {
    try { response.json(await store.setEnabled(request.params.id, request.body?.enabled)); }
    catch (error) { response.status(400).json({ error: error.message }); }
  });
  router.delete('/accounts/:id', async (request, response) => {
    try { response.json(await store.remove(request.params.id)); }
    catch (error) { response.status(400).json({ error: error.message }); }
  });
  router.use((error, _request, response, _next) => {
    response.status(400).json({ error: error.type === 'entity.too.large' ?
      'Запрос слишком большой' : 'Некорректный JSON' });
  });
  return router;
}
