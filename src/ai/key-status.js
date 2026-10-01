import { readJsonResponse } from './openrouter.js';

export async function getKeyStatus({ apiKey, fetchImpl = fetch }) {
  const signal = AbortSignal.timeout(8000);
  let upstream;
  try {
    upstream = await fetchImpl('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, redirect: 'error', signal,
    });
  } catch { throw new Error('Не удалось связаться с OpenRouter для проверки ключа'); }
  if (upstream.status === 401 || upstream.status === 403) return { valid: false, reason: 'OpenRouter отклонил ключ' };
  if (!upstream.ok) throw new Error(`OpenRouter временно недоступен: HTTP ${upstream.status}`);
  let data;
  try { data = (await readJsonResponse(upstream, signal, 64 * 1024)).data; }
  catch { throw new Error('OpenRouter вернул некорректный ответ проверки ключа'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('OpenRouter вернул неожиданный ответ');
  const quota = data.free_model_daily_requests;
  const hasQuota = quota && ['used', 'limit', 'remaining'].every((field) => Number.isSafeInteger(quota[field]) && quota[field] >= 0);
  const expiresAt = typeof data.expires_at === 'string' && Number.isFinite(Date.parse(data.expires_at)) ?
    new Date(data.expires_at).toISOString() : null;
  return { valid: true, freeTier: data.is_free_tier === true, expiresAt,
    ...(hasQuota ? { freeRequestsToday: { used: quota.used, limit: quota.limit, remaining: quota.remaining } } : {}) };
}
