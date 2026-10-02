import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export const ORDER_AMOUNT_MINOR = 14900;
export const ORDER_CURRENCY = 'RUB';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/;
const FAILURE_CODES = ['recognition_failed', 'cancelled', 'expired', 'result_lost', 'server_restart'];
const PAYMENT_STATES = ['pending', 'paid', 'cancelled', 'refund_pending', 'refunded'];
const ATTEMPT_STATES = ['running', 'ready', 'completed', 'failed', 'interrupted'];
const ACTIVE_STATES = ['running', 'ready'];

export class OrderError extends Error {
  constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; }
}

function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))) throw new OrderError('Недопустимые поля заказа.');
}

function requireId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new OrderError('Некорректный номер заказа или запроса.');
}

function tokenHash(value) {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new OrderError('Некорректный ключ доступа к заказу.');
  return createHash('sha256').update(value).digest('hex');
}

function paymentIdentity(provider, paymentId) {
  if (typeof provider !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(provider) ||
      typeof paymentId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(paymentId)) {
    throw new OrderError('Некорректный идентификатор платёжного сервиса.');
  }
}

function summary(order) {
  const latest = order.attempts.at(-1);
  return { id: order.id, amountMinor: order.amountMinor, currency: order.currency,
    paymentState: order.payment.state, paymentLinked: !!order.payment.id,
    processingState: latest?.state ?? 'idle', attempts: order.attempts.length,
    attemptsRemaining: order.maxAttempts - order.attempts.length,
    canRetry: order.payment.state === 'paid' && order.attempts.length < order.maxAttempts &&
      (!latest || ['failed', 'interrupted'].includes(latest.state)),
    failureCode: latest?.failureCode ?? null, createdAt: order.createdAt, updatedAt: order.updatedAt };
}

// One service process owns this file. It contains only IDs, access-token hashes
// and statuses, never source filenames, collection contents or AI output.
export function createOrderStore({ dataDir, now = Date.now, maxOrders = 10000, maxAttempts = 3 } = {}) {
  if (!dataDir || !Number.isInteger(maxOrders) || maxOrders < 1 || maxOrders > 10000 ||
      !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error('Некорректные настройки хранилища заказов.');
  const filePath = path.join(dataDir, 'orders.json');
  const bootId = randomUUID();
  let queue = Promise.resolve();
  let closed = false;

  function validate(state) {
    try {
      fields(state, ['version', 'orders']);
      if (state.version !== 1 || !Array.isArray(state.orders) || state.orders.length > 10000) throw new Error();
      const ids = new Set(); const requests = new Set(); const payments = new Set(); const refunds = new Set();
      for (const order of state.orders) {
        fields(order, ['id', 'requestId', 'accessHash', 'amountMinor', 'currency', 'maxAttempts', 'payment', 'attempts', 'createdAt', 'updatedAt']);
        requireId(order.id); requireId(order.requestId);
        const request = `${order.accessHash}:${order.requestId}`;
        if (ids.has(order.id) || requests.has(request) || !TOKEN.test(order.accessHash ?? '') ||
            !Number.isSafeInteger(order.amountMinor) || order.amountMinor <= 0 || order.currency !== ORDER_CURRENCY ||
            !Number.isInteger(order.maxAttempts) || order.maxAttempts < 1 || order.maxAttempts > 10 ||
            !Number.isSafeInteger(order.createdAt) || !Number.isSafeInteger(order.updatedAt)) throw new Error();
        ids.add(order.id); requests.add(request);
        fields(order.payment, ['provider', 'id', 'state', 'refundId']);
        if (!PAYMENT_STATES.includes(order.payment.state) ||
            (order.payment.id === null) !== (order.payment.provider === null) ||
            (!order.payment.id && order.payment.state !== 'pending') ||
            (!order.payment.refundId && ['refund_pending', 'refunded'].includes(order.payment.state)) ||
            (order.payment.refundId !== null && !['refund_pending', 'refunded'].includes(order.payment.state))) throw new Error();
        if (order.payment.id !== null) {
          paymentIdentity(order.payment.provider, order.payment.id);
          const payment = `${order.payment.provider}:${order.payment.id}`;
          if (payments.has(payment)) throw new Error(); payments.add(payment);
        }
        if (order.payment.refundId !== null) {
          paymentIdentity(order.payment.provider, order.payment.refundId);
          const refund = `${order.payment.provider}:${order.payment.refundId}`;
          if (refunds.has(refund)) throw new Error(); refunds.add(refund);
        }
        if (!Array.isArray(order.attempts) || order.attempts.length > order.maxAttempts) throw new Error();
        const attempts = new Set(); const attemptRequests = new Set();
        for (const [index, attempt] of order.attempts.entries()) {
          fields(attempt, ['id', 'requestId', 'state', 'bootId', 'failureCode', 'createdAt', 'updatedAt']);
          requireId(attempt.id); requireId(attempt.requestId);
          if (attempts.has(attempt.id) || attemptRequests.has(attempt.requestId) || !ATTEMPT_STATES.includes(attempt.state) ||
              !Number.isSafeInteger(attempt.createdAt) || !Number.isSafeInteger(attempt.updatedAt) ||
              (ACTIVE_STATES.includes(attempt.state) && (index !== order.attempts.length - 1 || !UUID.test(attempt.bootId ?? ''))) ||
              (!ACTIVE_STATES.includes(attempt.state) && attempt.bootId !== null) ||
              (attempt.state === 'completed' && index !== order.attempts.length - 1) ||
              (['failed', 'interrupted'].includes(attempt.state) ? !FAILURE_CODES.includes(attempt.failureCode) : attempt.failureCode !== null)) throw new Error();
          attempts.add(attempt.id); attemptRequests.add(attempt.requestId);
        }
        if (order.attempts.length && ['pending', 'cancelled'].includes(order.payment.state)) throw new Error();
        if (order.payment.state !== 'paid' && ACTIVE_STATES.includes(order.attempts.at(-1)?.state)) throw new Error();
      }
    } catch { throw new OrderError('Хранилище заказов повреждено. Операция остановлена; данные не перезаписаны.', 503); }
  }

  async function readState() {
    try {
      const text = await readFile(filePath, 'utf8');
      if (Buffer.byteLength(text) > 20 * 1024 * 1024) throw new Error();
      const state = JSON.parse(text); validate(state); return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, orders: [] };
      if (error instanceof OrderError) throw error;
      throw new OrderError('Не удалось прочитать учёт заказов. Операция остановлена.', 503);
    }
  }

  async function writeState(state) {
    validate(state);
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      const file = await open(temporaryPath, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(state), 'utf8'); await file.sync(); }
      finally { await file.close(); }
      await rename(temporaryPath, filePath);
    } catch {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw new OrderError('Не удалось сохранить заказ. Повторите запрос с тем же номером.', 503);
    }
  }

  function transact(operation) {
    if (closed) return Promise.reject(new OrderError('Сервис перезапускается. Повторите позже.', 503));
    const result = queue.then(async () => {
      const state = await readState();
      const before = JSON.stringify(state);
      // Source and result from another boot cannot be recovered from metadata.
      for (const order of state.orders) {
        const attempt = order.attempts.at(-1);
        if (attempt && ACTIVE_STATES.includes(attempt.state) && attempt.bootId !== bootId) {
          attempt.state = 'interrupted'; attempt.bootId = null; attempt.failureCode = 'server_restart';
          attempt.updatedAt = now(); order.updatedAt = now();
        }
      }
      // Persist recovery even when the requested operation is rejected.
      if (JSON.stringify(state) !== before) await writeState(state);
      const recovered = JSON.stringify(state);
      const value = operation(state.orders);
      if (JSON.stringify(state) !== recovered) await writeState(state);
      return value;
    });
    queue = result.catch(() => {});
    return result;
  }

  function find(orders, id, accessToken) {
    requireId(id);
    const order = orders.find((item) => item.id === id);
    if (accessToken !== undefined) {
      const hash = tokenHash(accessToken);
      if (!order || !timingSafeEqual(Buffer.from(hash), Buffer.from(order.accessHash))) {
        throw new OrderError('Заказ не найден или ключ доступа неверен.', 404);
      }
    }
    if (!order) throw new OrderError('Заказ не найден.', 404);
    return order;
  }

  function confirmedPayment(order, input) {
    paymentIdentity(input.provider, input.paymentId);
    if (input.provider !== order.payment.provider || input.paymentId !== order.payment.id ||
        input.amountMinor !== order.amountMinor || input.currency !== order.currency) {
      throw new OrderError('Платёж не соответствует заказу.', 409);
    }
  }

  function latestAttempt(order, runId) {
    requireId(runId);
    const attempt = order.attempts.at(-1);
    if (!attempt || attempt.id !== runId) throw new OrderError('Попытка уже заменена или не найдена.', 409);
    return attempt;
  }

  return {
    create(input) {
      return transact((orders) => {
        fields(input, ['requestId', 'accessToken']); requireId(input.requestId);
        const accessHash = tokenHash(input.accessToken);
        const previous = orders.find((item) => item.requestId === input.requestId && item.accessHash === accessHash);
        if (previous) return summary(previous);
        if (orders.length >= maxOrders) throw new OrderError('Лимит учёта заказов достигнут. Обратитесь к администратору.', 503);
        const order = { id: randomUUID(), requestId: input.requestId, accessHash,
          amountMinor: ORDER_AMOUNT_MINOR, currency: ORDER_CURRENCY, maxAttempts,
          payment: { provider: null, id: null, state: 'pending', refundId: null },
          attempts: [], createdAt: now(), updatedAt: now() };
        orders.push(order); return summary(order);
      });
    },
    list({ offset = 0, limit = 50 } = {}) {
      return transact((orders) => {
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new OrderError('Некорректная страница списка заказов.');
        return { total: orders.length, orders: orders.slice().reverse().slice(offset, offset + limit).map(summary) };
      });
    },
    get(input) {
      return transact((orders) => {
        fields(input, ['id', 'accessToken']); tokenHash(input.accessToken);
        return summary(find(orders, input.id, input.accessToken));
      });
    },
    discardDraft(id) {
      return transact((orders) => {
        const order = find(orders, id);
        if (order.payment.state !== 'pending' || order.payment.id !== null || order.attempts.length) {
          throw new OrderError('Можно удалить только черновик без связанного платежа.', 409);
        }
        orders.splice(orders.indexOf(order), 1); return { removed: true };
      });
    },
    // Only trusted payment adapters may call the next methods after verifying
    // provider status. No browser/admin "mark paid" endpoint exposes them.
    bindPayment(input) {
      return transact((orders) => {
        fields(input, ['id', 'provider', 'paymentId']); paymentIdentity(input.provider, input.paymentId);
        const order = find(orders, input.id);
        if (orders.some((item) => item.id !== order.id && item.payment.provider === input.provider && item.payment.id === input.paymentId)) throw new OrderError('Платёж уже связан с другим заказом.', 409);
        if (order.payment.id && (order.payment.provider !== input.provider || order.payment.id !== input.paymentId)) throw new OrderError('Заказ уже связан с другим платежом.', 409);
        if (order.payment.id) return summary(order);
        if (order.payment.state !== 'pending') throw new OrderError('Заказ не ожидает оплаты.', 409);
        order.payment.provider = input.provider; order.payment.id = input.paymentId; order.updatedAt = now();
        return summary(order);
      });
    },
    confirmPayment(input) {
      return transact((orders) => {
        fields(input, ['id', 'provider', 'paymentId', 'amountMinor', 'currency']);
        const order = find(orders, input.id); confirmedPayment(order, input);
        if (['paid', 'refund_pending', 'refunded'].includes(order.payment.state)) return summary(order);
        if (order.payment.state !== 'pending') throw new OrderError('Заказ уже отменён.', 409);
        order.payment.state = 'paid'; order.updatedAt = now(); return summary(order);
      });
    },
    cancelPayment(input) {
      return transact((orders) => {
        fields(input, ['id', 'provider', 'paymentId']);
        const order = find(orders, input.id);
        confirmedPayment(order, { ...input, amountMinor: order.amountMinor, currency: order.currency });
        if (order.payment.state === 'cancelled') return summary(order);
        if (order.payment.state !== 'pending') throw new OrderError('Подтверждённый платёж нельзя отменить этим событием.', 409);
        order.payment.state = 'cancelled'; order.updatedAt = now(); return summary(order);
      });
    },
    beginAttempt(input) {
      return transact((orders) => {
        fields(input, ['id', 'accessToken', 'requestId']); requireId(input.requestId); tokenHash(input.accessToken);
        const order = find(orders, input.id, input.accessToken);
        if (order.payment.state !== 'paid') throw new OrderError('Для переноса нужен подтверждённый платёж.', 402);
        const previous = order.attempts.find((item) => item.requestId === input.requestId);
        if (previous) return { order: summary(order), runId: previous.id, started: false };
        const latest = order.attempts.at(-1);
        if (latest && ['running', 'ready', 'completed'].includes(latest.state)) throw new OrderError('У заказа уже есть обработка или готовый результат.', 409);
        if (order.attempts.length >= order.maxAttempts) throw new OrderError('Лимит повторов исчерпан. Требуется решение о возврате.', 409);
        const attempt = { id: randomUUID(), requestId: input.requestId, state: 'running', bootId,
          failureCode: null, createdAt: now(), updatedAt: now() };
        order.attempts.push(attempt); order.updatedAt = now();
        return { order: summary(order), runId: attempt.id, started: true };
      });
    },
    markReady(input) {
      return transact((orders) => {
        fields(input, ['id', 'runId']); const order = find(orders, input.id); const attempt = latestAttempt(order, input.runId);
        if (attempt.state === 'ready' || attempt.state === 'completed') return summary(order);
        if (order.payment.state !== 'paid' || attempt.state !== 'running' || attempt.bootId !== bootId) throw new OrderError('Попытка уже остановлена.', 409);
        attempt.state = 'ready'; attempt.updatedAt = now(); order.updatedAt = now(); return summary(order);
      });
    },
    allowRetry(input) {
      return transact((orders) => {
        fields(input, ['id', 'runId', 'failureCode']);
        if (!FAILURE_CODES.includes(input.failureCode) || input.failureCode === 'server_restart') throw new OrderError('Недопустимая причина повтора.');
        const order = find(orders, input.id); const attempt = latestAttempt(order, input.runId);
        if (['failed', 'interrupted'].includes(attempt.state)) return summary(order);
        if (order.payment.state !== 'paid' || !ACTIVE_STATES.includes(attempt.state)) throw new OrderError('Результат уже завершён или платёж закрыт.', 409);
        attempt.state = 'failed'; attempt.bootId = null; attempt.failureCode = input.failureCode;
        attempt.updatedAt = now(); order.updatedAt = now(); return summary(order);
      });
    },
    completeAttempt(input) {
      return transact((orders) => {
        fields(input, ['id', 'runId']); const order = find(orders, input.id); const attempt = latestAttempt(order, input.runId);
        if (attempt.state === 'completed') return summary(order);
        if (order.payment.state !== 'paid' || attempt.state !== 'ready' || attempt.bootId !== bootId) throw new OrderError('Нет готового результата для завершения.', 409);
        attempt.state = 'completed'; attempt.bootId = null; attempt.updatedAt = now(); order.updatedAt = now();
        return summary(order);
      });
    },
    requestRefund(input) {
      return transact((orders) => {
        fields(input, ['id', 'refundId']); const order = find(orders, input.id);
        paymentIdentity(order.payment.provider, input.refundId);
        if (order.payment.refundId === input.refundId) return summary(order);
        if (order.payment.state !== 'paid' || ACTIVE_STATES.includes(order.attempts.at(-1)?.state)) throw new OrderError('Возврат недоступен, пока обработка активна или платёж закрыт.', 409);
        if (orders.some((item) => item.payment.provider === order.payment.provider && item.payment.refundId === input.refundId)) throw new OrderError('Возврат уже относится к другому заказу.', 409);
        order.payment.state = 'refund_pending'; order.payment.refundId = input.refundId; order.updatedAt = now(); return summary(order);
      });
    },
    confirmRefund(input) {
      return transact((orders) => {
        fields(input, ['id', 'provider', 'paymentId', 'refundId', 'amountMinor', 'currency']);
        const order = find(orders, input.id); confirmedPayment(order, input);
        if (input.refundId !== order.payment.refundId || !order.payment.refundId) throw new OrderError('Возврат не соответствует заказу.', 409);
        if (order.payment.state === 'refunded') return summary(order);
        if (order.payment.state !== 'refund_pending') throw new OrderError('Заказ не ожидает возврата.', 409);
        order.payment.state = 'refunded'; order.updatedAt = now(); return summary(order);
      });
    },
    async close() { closed = true; await queue; },
  };
}

export function newOrderAccessToken() { return randomBytes(32).toString('hex'); }
