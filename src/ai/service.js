import { GroqRateLimitError, recognizeCollectionText, recognizeCollectionRecords } from './groq.js';

// One upstream request at a time, shared by short requests and background jobs.
function createGate() {
  let active = false;
  const waiting = [];
  function release() {
    const next = waiting.shift();
    if (next) { next.detach(); next.resolve(release); }
    else active = false;
  }
  return async (signal) => {
    signal?.throwIfAborted();
    if (!active) { active = true; return release; }
    if (waiting.length >= 3) throw new Error('Очередь ИИ занята. Повторите позже.');
    return new Promise((resolve, reject) => {
      const entry = { resolve, detach: () => signal?.removeEventListener('abort', abort) };
      const abort = () => {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        entry.detach(); reject(signal.reason);
      };
      waiting.push(entry);
      signal?.addEventListener('abort', abort, { once: true });
    });
  };
}

export function createAiService({ store, fetchImpl = fetch, now = Date.now }) {
  const usage = new Map();
  const acquire = createGate();
  function state(id) {
    const time = now();
    const current = usage.get(id) ?? { cooldownUntil: 0 };
    if (usage.size > 100) usage.delete(usage.keys().next().value);
    usage.set(id, current);
    return current;
  }
  async function accountsFor({ accountId, consentToAccountSwitch, fallbackAccountIds }) {
    if (typeof accountId !== 'string' || !accountId) throw new Error('Выберите включённый ключ Groq');
    if (!store) throw new Error('Админ-панель не настроена на сервере');
    const accounts = (await store.getEnabledAccounts(accountId)).slice(0, consentToAccountSwitch === true ? 3 : 1);
    if (consentToAccountSwitch === true) {
      const expected = accounts.slice(1).map((account) => account.id);
      if (!expected.length || !Array.isArray(fallbackAccountIds) || fallbackAccountIds.length !== expected.length ||
        expected.some((id, index) => fallbackAccountIds[index] !== id)) {
        throw new Error('Список резервных владельцев изменился. Обновите его и подтвердите отправку текста снова.');
      }
    }
    return accounts;
  }
  const publicRoute = (accounts) => accounts.map(({ id, owner, label }) => ({ id, owner, label }));
  async function approve(options) {
    const accounts = publicRoute(await accountsFor(options));
    return { accountId: options.accountId, consentToAccountSwitch: options.consentToAccountSwitch === true,
      fallbackAccountIds: options.consentToAccountSwitch === true ? [...options.fallbackAccountIds] : [],
      accounts };
  }
  async function run({ route, text, records, sourceFormat, context, signal }) {
    const release = await acquire(signal);
    try {
      signal?.throwIfAborted();
      const accounts = await accountsFor(route);
      if (JSON.stringify(publicRoute(accounts)) !== JSON.stringify(route.accounts)) {
        throw new Error('Участники обработки изменились. Создайте новое задание после повторного согласия.');
      }
      const available = accounts.filter((account) => state(account.id).cooldownUntil <= now());
      // Groq quotas belong to organizations, including requests made outside this service.
      // Local request counts cannot predict those quotas; retry only after an actual 429.
      const order = available;
      for (const account of order) {
        signal?.throwIfAborted();
        const current = state(account.id);
        try {
          const options = { apiKey: account.apiKey, fetchImpl, signal };
          const result = records ? await recognizeCollectionRecords({ ...options, records, sourceFormat, context }) :
            await recognizeCollectionText({ ...options, text });
          return { ...result, keyUsed: { id: account.id, owner: account.owner, label: account.label },
            fallbackUsed: account.id !== route.accountId };
        } catch (error) {
          signal?.throwIfAborted();
          if (!(error instanceof GroqRateLimitError)) throw error;
          current.cooldownUntil = now() + error.retryAfterMs;
          current.rateLimit = { ...error.details };
          if (!route.consentToAccountSwitch) throw error;
        }
      }
      const earliest = accounts.map((account) => state(account.id)).sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0];
      throw new GroqRateLimitError(Math.max(5_000, earliest.cooldownUntil - now()), earliest.rateLimit);
    } finally { release(); }
  }
  return { approve, run };
}
