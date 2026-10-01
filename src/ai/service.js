import { OpenRouterRateLimitError, recognizeCollectionText, recognizeCollectionRecords } from './openrouter.js';

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

export function createAiService({ store, fetchImpl = fetch }) {
  const usage = new Map();
  const acquire = createGate();
  function state(id) {
    const time = Date.now();
    const current = usage.get(id) ?? { minuteStart: time, minuteCount: 0, dayStart: time, dayCount: 0, cooldownUntil: 0 };
    if (time - current.minuteStart >= 60_000) { current.minuteStart = time; current.minuteCount = 0; }
    if (time - current.dayStart >= 86_400_000) { current.dayStart = time; current.dayCount = 0; }
    if (usage.size > 100) usage.delete(usage.keys().next().value);
    usage.set(id, current);
    return current;
  }
  async function accountsFor({ accountId, consentToAccountSwitch, fallbackAccountIds }) {
    if (typeof accountId !== 'string' || !accountId) throw new Error('Выберите включённый ключ OpenRouter');
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
  async function run({ route, text, records, context, signal }) {
    const release = await acquire(signal);
    try {
      signal?.throwIfAborted();
      const accounts = await accountsFor(route);
      if (JSON.stringify(publicRoute(accounts)) !== JSON.stringify(route.accounts)) {
        throw new Error('Участники обработки изменились. Создайте новое задание после повторного согласия.');
      }
      const available = accounts.filter((account) => state(account.id).cooldownUntil <= Date.now());
      const near = (account) => { const item = state(account.id); return item.minuteCount >= 18 || item.dayCount >= 45; };
      const order = route.consentToAccountSwitch ?
        [...available.filter((item) => !near(item)), ...available.filter(near)] : available;
      for (const account of order) {
        signal?.throwIfAborted();
        const current = state(account.id);
        current.minuteCount += 1; current.dayCount += 1;
        try {
          const options = { apiKey: account.apiKey, fetchImpl, signal };
          const result = records ? await recognizeCollectionRecords({ ...options, records, context }) :
            await recognizeCollectionText({ ...options, text });
          return { ...result, keyUsed: { id: account.id, owner: account.owner, label: account.label },
            fallbackUsed: account.id !== route.accountId };
        } catch (error) {
          signal?.throwIfAborted();
          if (!(error instanceof OpenRouterRateLimitError)) throw error;
          current.cooldownUntil = Date.now() + error.retryAfterMs;
          if (!route.consentToAccountSwitch) throw error;
        }
      }
      throw new OpenRouterRateLimitError(60_000);
    } finally { release(); }
  }
  return { approve, run };
}
