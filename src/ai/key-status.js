import { DEFAULT_GROQ_MODEL, readJsonResponse } from './groq.js';

export async function getKeyStatus({ apiKey, fetchImpl = fetch }) {
  const signal = AbortSignal.timeout(8000);
  let upstream;
  try {
    upstream = await fetchImpl('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, redirect: 'error', signal,
    });
  } catch { throw new Error('Не удалось связаться с Groq для проверки ключа'); }
  if (upstream.status === 401 || upstream.status === 403) return { valid: false, reason: 'Groq отклонил ключ' };
  if (!upstream.ok) throw new Error(`Groq временно недоступен: HTTP ${upstream.status}`);
  let data;
  try { data = (await readJsonResponse(upstream, signal, 64 * 1024)).data; }
  catch { throw new Error('Groq вернул некорректный ответ проверки ключа'); }
  if (!Array.isArray(data)) throw new Error('Groq вернул неожиданный ответ');
  return { valid: true, model: DEFAULT_GROQ_MODEL,
    modelAvailable: data.some((item) => item?.id === DEFAULT_GROQ_MODEL && item.active !== false) };
}
