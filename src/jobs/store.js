import { randomUUID } from 'node:crypto';

export class JobError extends Error {
  constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; }
}

// Source buffers and results are deliberately never passed to filesystem APIs.
export function createJobStore({ run, now = Date.now, maxJobs = 3,
  workTtlMs = 15 * 60_000, resultTtlMs = 10 * 60_000, metadataTtlMs = 2 * 60_000 } = {}) {
  const jobs = new Map();
  let worker = null;
  let closed = false;
  const live = (job) => ['queued', 'running', 'ready'].includes(job.status);
  function summary(job) {
    return { id: job.id, status: job.status, createdAt: job.createdAt, expiresAt: job.expiresAt,
      progress: { ...job.progress }, error: job.error ?? null };
  }
  function clear(job, status) {
    job.controller.abort();
    job.source = null; job.route = null; job.result = null;
    job.status = status; job.expiresAt = now() + metadataTtlMs;
  }
  function sweep() {
    for (const [id, job] of jobs) {
      if (now() < job.expiresAt) continue;
      if (live(job)) clear(job, 'expired');
      else if (worker !== job) jobs.delete(id);
    }
  }
  async function drain() {
    if (worker || closed) return;
    sweep();
    const job = [...jobs.values()].find((item) => item.status === 'queued');
    if (!job) return;
    worker = job; job.status = 'running';
    try {
      const result = await run({ source: job.source, route: job.route, signal: job.controller.signal,
        releaseSource: () => { job.source = null; },
        progress: (value) => { if (job.status === 'running') job.progress = { ...job.progress, ...value }; } });
      job.controller.signal.throwIfAborted();
      if (now() >= job.expiresAt) { clear(job, 'expired'); return; }
      if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) throw new JobError('Результат больше 8 МБ. Разделите источник.');
      job.source = null; job.route = null; job.result = result;
      job.status = 'ready'; job.expiresAt = now() + resultTtlMs;
    } catch (error) {
      if (job.status === 'running') {
        job.error = error instanceof JobError ? error.message.slice(0, 500) : 'Не удалось завершить распознавание. Повторите позже.';
        clear(job, now() >= job.expiresAt ? 'expired' : 'failed');
      }
    } finally {
      // An aborted worker keeps its slot until the operation actually unwinds.
      worker = null;
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
  return {
    create({ owner, requestId, fingerprint, source, route }) {
      if (closed) throw new JobError('Сервис перезапускается. Повторите позже.', 503);
      if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
        throw new JobError('Не указан номер запроса. Обновите страницу.');
      }
      sweep();
      const previous = [...jobs.values()].find((item) => item.owner === owner && item.requestId === requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new JobError('Номер запроса уже использован для другого исходника.', 409);
        return summary(previous);
      }
      const count = [...jobs.values()].filter((item) => live(item) || item === worker).length;
      if (count >= maxJobs) throw new JobError('В памяти уже три задания. Завершите или удалите результат перед новым запуском.', 503);
      if (jobs.size >= 100) {
        const oldest = [...jobs.values()].find((item) => !live(item) && item !== worker);
        if (oldest) jobs.delete(oldest.id);
      }
      const job = { id: randomUUID(), owner, requestId, fingerprint, source, route, controller: new AbortController(),
        status: 'queued', createdAt: now(), expiresAt: now() + workTtlMs,
        progress: { completed: 0, total: 0, sourceCount: 0, modelCount: 0 } };
      jobs.set(job.id, job); queueMicrotask(drain);
      return summary(job);
    },
    list(owner) { sweep(); return [...jobs.values()].filter((job) => job.owner === owner).map(summary).reverse(); },
    get(owner, id) { return summary(find(owner, id)); },
    result(owner, id) {
      const job = find(owner, id);
      if (job.status !== 'ready') throw new JobError('Результат ещё не готов или уже удалён.', 409);
      return job.result;
    },
    cancel(owner, id) { const job = find(owner, id); if (live(job)) clear(job, 'cancelled'); return summary(job); },
    consume(owner, id) {
      const job = find(owner, id);
      if (job.status !== 'ready' && job.status !== 'consumed') throw new JobError('Результат уже удалён или срок истёк.', 409);
      if (job.status === 'ready') clear(job, 'consumed');
      return summary(job);
    },
    sweep,
    close() { closed = true; clearInterval(timer); for (const job of jobs.values()) clear(job, 'cancelled'); jobs.clear(); },
  };
}
