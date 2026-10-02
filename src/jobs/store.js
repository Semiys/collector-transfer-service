import { randomUUID } from 'node:crypto';

export class JobError extends Error {
  constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; }
}

// Source buffers and results are deliberately never passed to filesystem APIs.
export function createJobStore({ run, now = Date.now, maxJobs = 3,
  workTtlMs = 15 * 60_000, resultTtlMs = 10 * 60_000, metadataTtlMs = 2 * 60_000,
  onReady, onStopped } = {}) {
  const jobs = new Map();
  const reservations = new Set();
  let worker = null;
  let closed = false;
  let closing = null;
  const live = (job) => ['queued', 'running', 'ready'].includes(job.status);
  function summary(job) {
    return { id: job.id, status: job.status, createdAt: job.createdAt, expiresAt: job.expiresAt,
      progress: { ...job.progress }, error: job.error ?? null,
      settling: !!job.needsSync || (worker === job && !live(job)) || !!job.completing,
      stateError: job.syncError ?? null };
  }
  function settle(job) {
    if (job.syncing) return job.syncing;
    if (!job.needsSync || worker === job || job.resultUsers.size || job.completing || now() < (job.syncRetryAt ?? 0)) return;
    job.syncing = (async () => {
      try {
        await onStopped({ binding: job.binding, status: job.status, hadResult: !!job.hadResult });
        job.needsSync = false; job.syncError = null; job.syncRetryAt = 0;
        job.expiresAt = now() + metadataTtlMs;
      } catch {
        // Keep only metadata and block another paid attempt until storage recovers.
        job.syncError = 'Не удалось сохранить статус заказа. Повтор временно недоступен.';
        job.syncRetryAt = now() + 5000;
      } finally { job.syncing = null; }
    })();
    return job.syncing;
  }
  function clear(job, status) {
    job.controller.abort();
    job.source = null; job.route = null; job.result = null;
    job.status = status; job.expiresAt = now() + metadataTtlMs;
    if (job.binding && status !== 'consumed') { job.needsSync = true; void settle(job); }
  }
  function sweep() {
    for (const [id, job] of jobs) {
      if (job.needsSync) { void settle(job); continue; }
      if (job.completing || now() < job.expiresAt) continue;
      if (live(job)) clear(job, 'expired');
      else if (worker !== job && !job.syncing && !job.resultUsers.size) jobs.delete(id);
    }
  }
  async function drain() {
    if (worker || closed) return;
    sweep();
    const job = [...jobs.values()].find((item) => item.status === 'queued');
    if (!job) return;
    worker = job; job.status = 'running';
    let stopped;
    job.stopped = new Promise((resolve) => { stopped = resolve; });
    try {
      const result = await run({ source: job.source, route: job.route, signal: job.controller.signal,
        releaseSource: () => { job.source = null; },
        progress: (value) => { if (job.status === 'running') job.progress = { ...job.progress, ...value }; } });
      job.controller.signal.throwIfAborted();
      if (now() >= job.expiresAt) { clear(job, 'expired'); return; }
      if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) throw new JobError('Результат больше 8 МБ. Разделите источник.');
      if (job.binding) await onReady({ binding: job.binding });
      job.controller.signal.throwIfAborted();
      if (now() >= job.expiresAt) { clear(job, 'expired'); return; }
      job.source = null; job.route = null; job.result = result;
      job.status = 'ready'; job.hadResult = true; job.expiresAt = now() + resultTtlMs;
    } catch (error) {
      if (job.status === 'running') {
        job.error = error instanceof JobError ? error.message.slice(0, 500) : 'Не удалось завершить распознавание. Повторите позже.';
        clear(job, now() >= job.expiresAt ? 'expired' : 'failed');
      }
    } finally {
      // An aborted worker keeps its slot until the operation actually unwinds.
      worker = null;
      await settle(job);
      stopped();
      queueMicrotask(drain);
    }
  }
  function find(owner, id) {
    sweep();
    const job = jobs.get(id);
    if (!job || job.owner !== owner) throw new JobError('Задание не найдено или срок хранения истёк. Загрузите исходник снова.', 404);
    return job;
  }
  const timer = setInterval(sweep, 5000);
  timer.unref();
  function findRequest(owner, requestId, fingerprint) {
    sweep();
    const previous = [...jobs.values()].find((item) => item.owner === owner && item.requestId === requestId);
    if (!previous) return null;
    if (previous.fingerprint !== fingerprint) throw new JobError('Номер запроса уже использован для другого исходника или согласия.', 409);
    return summary(previous);
  }
  function checkCapacity() {
    if (closed) throw new JobError('Сервис перезапускается. Повторите позже.', 503);
    sweep();
    const count = reservations.size + [...jobs.values()].filter((item) => live(item) || item === worker || item.needsSync || item.resultUsers.size || item.completing).length;
    if (count >= maxJobs) throw new JobError('Очередь заданий занята. Завершите или удалите результат перед новым запуском.', 503);
  }
  function create({ owner, requestId, fingerprint, source, route, binding }) {
      if (closed) throw new JobError('Сервис перезапускается. Повторите позже.', 503);
      if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
        throw new JobError('Не указан номер запроса. Обновите страницу.');
      }
      const previous = findRequest(owner, requestId, fingerprint);
      if (previous) return previous;
      checkCapacity();
      if (binding && (typeof onReady !== 'function' || typeof onStopped !== 'function')) throw new JobError('Связь заказа с обработкой не настроена.', 503);
      if (jobs.size >= 100) {
        const oldest = [...jobs.values()].find((item) => !live(item) && item !== worker && !item.needsSync && !item.syncing && !item.resultUsers.size && !item.completing);
        if (oldest) jobs.delete(oldest.id);
      }
      const job = { id: randomUUID(), owner, requestId, fingerprint, source, route, controller: new AbortController(),
        binding, resultUsers: new Set(),
        status: 'queued', createdAt: now(), expiresAt: now() + workTtlMs,
        progress: { completed: 0, total: 0, sourceCount: 0, modelCount: 0 } };
      jobs.set(job.id, job); queueMicrotask(drain);
      return summary(job);
  }
  return {
    create,
    findRequest,
    // A short-lived ticket reserves RAM capacity before a paid attempt is recorded.
    // It never starts work or contains source data; the caller must release it.
    reserve() {
      checkCapacity();
      const ticket = Symbol(); reservations.add(ticket);
      return {
        commit(input) {
          if (!reservations.delete(ticket)) throw new JobError('Место в очереди уже освобождено.', 503);
          return create(input);
        },
        release() { reservations.delete(ticket); },
      };
    },
    list(owner) { sweep(); return [...jobs.values()].filter((job) => job.owner === owner).map(summary).reverse(); },
    get(owner, id) { return summary(find(owner, id)); },
    result(owner, id) {
      const job = find(owner, id);
      if (job.status !== 'ready') throw new JobError('Результат ещё не готов или уже удалён.', 409);
      return job.result;
    },
    cancel(owner, id) {
      const job = find(owner, id);
      if (job.completing) throw new JobError('Сохраняется завершение заказа. Повторите позже.', 409);
      if (live(job)) clear(job, 'cancelled'); return summary(job);
    },
    // Hold the slot until a reader/builder really stops. Cancellation and expiry
    // abort its signal immediately but cannot allow a second paid attempt yet.
    async withResult(owner, id, use) {
      const job = find(owner, id);
      const assertReady = () => {
        sweep();
        if (job.status !== 'ready' || job.completing || job.controller.signal.aborted) {
          throw new JobError('Результат уже удалён или срок истёк. Загрузите исходник снова.', 409);
        }
      };
      assertReady();
      let finish;
      const usage = new Promise((resolve) => { finish = resolve; });
      job.resultUsers.add(usage);
      try {
        const value = await use({ result: job.result, binding: { ...job.binding },
          signal: job.controller.signal, expiresAt: job.expiresAt, assertReady });
        assertReady(); return value;
      } finally { job.resultUsers.delete(usage); finish(); await settle(job); }
    },
    // A confirmation accepted before expiry holds metadata until its atomic
    // write finishes. No cancellation/new ZIP can race this short operation.
    async completeResult(owner, id, commit) {
      const job = find(owner, id);
      if (job.status !== 'ready' || job.resultUsers.size || job.completing) {
        throw new JobError('Дождитесь окончания сборки или снова откройте результат.', 409);
      }
      job.completing = true;
      let finish;
      const completion = new Promise((resolve) => { finish = resolve; });
      job.resultUsers.add(completion);
      try {
        const value = await commit({ ...job.binding });
        clear(job, 'consumed'); return value;
      } finally { job.resultUsers.delete(completion); finish(); job.completing = false; sweep(); }
    },
    consume(owner, id) {
      const job = find(owner, id);
      if (job.binding || job.resultUsers.size || job.completing) throw new JobError('Результат заказа завершается только после подтверждения сохранения ZIP.', 409);
      if (job.status !== 'ready' && job.status !== 'consumed') throw new JobError('Результат уже удалён или срок истёк.', 409);
      if (job.status === 'ready') clear(job, 'consumed');
      return summary(job);
    },
    sweep,
    close() {
      if (closing) return closing;
      closed = true; clearInterval(timer); reservations.clear();
      const remaining = [...jobs.values()];
      for (const job of remaining) if (live(job) && !job.completing) clear(job, 'cancelled');
      closing = (async () => {
        await Promise.all(remaining.map((job) => job.stopped));
        await Promise.all(remaining.flatMap((job) => [...job.resultUsers]));
        await Promise.all(remaining.map(settle)); jobs.clear();
      })();
      return closing;
    },
  };
}
