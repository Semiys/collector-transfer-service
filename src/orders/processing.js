import { createHash } from 'node:crypto';
import { JobError } from '../jobs/store.js';
import { prepareSource } from '../jobs/recognize.js';
import { OrderError } from './store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const owner = (id) => `order:${id}`;

// Trusted server integration only: no payment or guest HTTP endpoints expose it.
export function createOrderJobLifecycle(orders) {
  return {
    onReady: ({ binding }) => orders.markReady(binding),
    onStopped: ({ binding, status, hadResult }) => orders.allowRetry({ ...binding,
      failureCode: status === 'failed' ? 'recognition_failed' : status === 'cancelled' ? 'cancelled' :
        hadResult ? 'result_lost' : 'expired' }),
  };
}

export function createOrderProcessing({ orders, jobs, aiService }) {
  const flights = new Map();
  let closed = false;

  async function authorize({ id, accessToken }) {
    if (!orders) throw new OrderError('Учёт заказов не настроен.', 503);
    return orders.get({ id, accessToken });
  }
  function sourceOf(value) {
    if (!value || typeof value.filename !== 'string' || value.filename.length > 200 ||
        !/\.(csv|xlsx|json|txt)$/i.test(value.filename) || !(value.bytes instanceof Uint8Array) ||
        !value.bytes.length || value.bytes.length > 8 * 1024 * 1024) {
      throw new JobError('Нужен CSV, XLSX, JSON или TXT до 8 МБ.');
    }
    return { filename: value.filename, bytes: value.bytes };
  }
  async function launch(input, source, route, fingerprint) {
    const ticket = jobs.reserve();
    let attempt;
    try {
      // Validate once, before consuming a paid attempt; queue only bounded records.
      const prepared = await prepareSource({ filename: source.filename, bytes: Buffer.from(source.bytes) });
      if (closed) throw new JobError('Сервис перезапускается. Повторите позже.', 503);
      attempt = await orders.beginAttempt({ id: input.id, accessToken: input.accessToken, requestId: input.requestId });
      if (!attempt.started) {
        const previous = jobs.findRequest(owner(input.id), input.requestId, fingerprint);
        if (!previous) throw new JobError('Эта попытка уже закончилась или потеряна при перезапуске. Загрузите исходник с новым номером запроса.', 409);
        return { order: attempt.order, job: previous };
      }
      const job = ticket.commit({ owner: owner(input.id), requestId: input.requestId, fingerprint,
        source: { prepared }, route, binding: { id: input.id, runId: attempt.runId } });
      return { order: attempt.order, job };
    } catch (error) {
      if (attempt?.started) {
        // No worker was committed: release the recorded attempt before another try.
        await orders.allowRetry({ id: input.id, runId: attempt.runId, failureCode: 'cancelled' });
      }
      throw error;
    } finally { ticket.release(); }
  }
  return {
    async start(input) {
      if (closed) throw new JobError('Сервис перезапускается. Повторите позже.', 503);
      const order = await authorize(input);
      if (order.paymentState !== 'paid') throw new OrderError('Для переноса нужен подтверждённый платёж.', 402);
      if (input.consentToAI !== true) throw new JobError('Подтвердите отправку коллекции внешнему ИИ.');
      if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw new JobError('Нужен новый номер запроса.');
      const source = sourceOf(input.source);
      const route = await aiService.approve({ accountId: input.accountId,
        consentToAccountSwitch: input.consentToAccountSwitch === true, fallbackAccountIds: input.fallbackAccountIds });
      const fingerprint = createHash('sha256').update(source.filename).update('\0').update(source.bytes)
        .update(JSON.stringify(route)).digest('hex');
      const previous = jobs.findRequest(owner(input.id), input.requestId, fingerprint);
      if (previous) return { order, job: previous };
      const key = `${input.id}:${input.requestId}`, flight = flights.get(key);
      if (flight) {
        if (flight.fingerprint !== fingerprint) throw new JobError('Номер запроса уже используется для другого исходника или согласия.', 409);
        return flight.promise;
      }
      if (flights.size >= 3) throw new JobError('Запуск заданий занят. Повторите позже.', 503);
      const promise = launch(input, source, route, fingerprint);
      flights.set(key, { fingerprint, promise });
      try { return await promise; } finally { flights.delete(key); }
    },
    async get(input) {
      const order = await authorize(input);
      return { order, jobs: jobs.list(owner(input.id)) };
    },
    async result(input) {
      await authorize(input); return jobs.result(owner(input.id), input.jobId);
    },
    async cancel(input) {
      await authorize(input);
      return { job: jobs.cancel(owner(input.id), input.jobId) };
    },
    async close() { closed = true; await Promise.allSettled([...flights.values()].map((flight) => flight.promise)); },
  };
}
