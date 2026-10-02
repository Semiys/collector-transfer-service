import { createHash, randomBytes } from 'node:crypto';
import { JobError } from '../jobs/store.js';
import { OrderError } from './store.js';
import { parseInput } from '../transfer/parse-input.js';
import { suggestMapping } from '../transfer/mapping.js';
import { reviewRows, rowProblems, validDate } from '../transfer/review.js';
import { buildArchive } from '../transfer/build-archive.js';
import { getEurRate } from '../transfer/cbr-rate.js';
import { createArchiveCapacity, ArchiveBusyError } from '../transfer/archive-capacity.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const owner = (id) => `order:${id}`;
export class DeliveryError extends Error {
  constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; }
}
function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new DeliveryError('Недопустимые поля проверки или скачивания заказа.');
  }
}
function optionsOf(value) {
  fields(value, ['priceCurrency', 'defaultCategory', 'defaultScale', 'transferDate', 'acceptTextWarnings', 'expectedRateDate']);
  if (!['RUB', 'EUR'].includes(value.priceCurrency)) throw new DeliveryError('Выберите валюту цены: RUB или EUR.');
  if (value.acceptTextWarnings !== true) throw new DeliveryError('Подтвердите проверку замечаний распознавания.');
  for (const key of ['defaultCategory', 'defaultScale', 'transferDate', 'expectedRateDate']) {
    if (value[key] != null && (typeof value[key] !== 'string' || value[key].length > 100)) throw new DeliveryError('Проверьте параметры переноса.');
  }
  const options = { ...value, transferDate: value.transferDate?.trim() || new Date().toISOString().slice(0, 10) };
  if (!validDate(options.transferDate)) throw new DeliveryError('Некорректная дата переноса.');
  if (options.defaultScale && !/^[1-9]\d*:[1-9]\d*$/.test(options.defaultScale.trim())) throw new DeliveryError('Масштаб по умолчанию должен быть вида 1:64.');
  if (options.priceCurrency === 'EUR' && !/^\d{2}\.\d{2}\.\d{4}$/.test(options.expectedRateDate ?? '')) {
    throw new DeliveryError('Для цены в евро сначала проверьте курс ЦБ и его дату.');
  }
  return options;
}
async function prepared(result) {
  // Only the server-held recognition is trusted. The browser can correct fields,
  // but cannot replace the model list, source IDs, payment or mapping.
  const { transferSource, priceCurrency, models, warnings } = result;
  const parsed = await parseInput('recognized.json', Buffer.from(JSON.stringify({ transferSource, priceCurrency, models, warnings })));
  return { parsed, mapping: suggestMapping(parsed.headers) };
}

// Internal only until verified payments, guest CAPTCHA and issuance are wired.
// Receipts/fingerprints live in RAM; no ZIP, models, source or corrections are cached.
export function createOrderDelivery({ orders, jobs, capacity = createArchiveCapacity(), now = Date.now,
  build = buildArchive, getRate = ({ signal }) => getEurRate(fetch, { signal }) } = {}) {
  const builds = new Map(), confirmations = new Map(), receipts = new Map();
  const shutdown = new AbortController();
  let closed = false;
  function sweep() {
    for (const [jobId, receipt] of receipts) {
      if (now() >= receipt.expiresAt) { receipts.delete(jobId); continue; }
      if (receipt.confirmed) continue;
      try { if (jobs.get(receipt.owner, jobId).status !== 'ready') receipts.delete(jobId); }
      catch { receipts.delete(jobId); }
    }
  }
  const timer = setInterval(sweep, 5000); timer.unref();
  async function authorize(input, { completed = false } = {}) {
    if (closed) throw new DeliveryError('Сервис перезапускается. Повторите позже.', 503);
    if (!orders) throw new DeliveryError('Учёт заказов не настроен.', 503);
    const order = await orders.get({ id: input.id, accessToken: input.accessToken });
    if (order.paymentState !== 'paid') throw new DeliveryError('Для переноса нужен подтверждённый платёж.', 402);
    if (order.processingState !== 'ready' && !(completed && order.processingState === 'completed')) {
      throw new DeliveryError('Результат ещё не готов или уже удалён. Проверьте статус заказа.', 409);
    }
    sweep(); return order;
  }
  async function assemble(input, options, edits, fingerprint) {
    return jobs.withResult(owner(input.id), input.jobId, async ({ result, signal: resultSignal, expiresAt, assertReady }) => {
      const { parsed, mapping } = await prepared(result);
      try {
        const rows = reviewRows(parsed, mapping, edits);
        for (const row of rows) {
          const errors = Object.values(rowProblems(row));
          if (errors.length) throw new Error(`Модель ${row.sourceRow}: ${errors.join(' ')}`);
        }
      } catch (error) { throw new DeliveryError(error.message); }
      return capacity.run(async (signal) => {
        signal.throwIfAborted();
        let eurRate;
        if (options.priceCurrency === 'EUR') {
          try { eurRate = await getRate({ signal }); }
          catch { signal.throwIfAborted(); throw new DeliveryError('Не удалось проверить курс ЦБ. Повторите позже.', 503); }
          if (!eurRate || !Number.isFinite(eurRate.rubPerEuro) || eurRate.rubPerEuro <= 0) throw new DeliveryError('Курс ЦБ недоступен.', 503);
          if (eurRate.date !== options.expectedRateDate) throw new DeliveryError('Курс ЦБ обновился. Проверьте новую дату и повторите перенос.', 409);
        }
        assertReady();
        let built;
        try { built = await build({ parsed, mapping, edits, options, eurRate, signal }); }
        catch { signal.throwIfAborted(); throw new DeliveryError('Не удалось собрать ZIP. Проверьте размер коллекции и повторите.', 503); }
        signal.throwIfAborted(); assertReady();
        if (!(built?.archive instanceof Uint8Array) || built.archive.length > 100 * 1024 * 1024) {
          throw new DeliveryError('Не удалось подготовить допустимый ZIP.', 503);
        }
        // Recheck durable payment/state before returning any archive bytes.
        await authorize(input); assertReady(); signal.throwIfAborted();
        const previous = receipts.get(input.jobId);
        const receipt = previous?.requestId === input.requestId && previous.fingerprint === fingerprint ?
          previous.receipt : randomBytes(32).toString('hex');
        if (!previous && receipts.size >= 100) throw new DeliveryError('Сервис скачивания занят. Повторите позже.', 503);
        receipts.set(input.jobId, { owner: owner(input.id), requestId: input.requestId, fingerprint, receipt, expiresAt, confirmed: false });
        return { archive: built.archive, failedPhotos: [...(built.failedPhotos ?? [])], receipt, expiresAt,
          orderCompleted: false };
      }, { signal: AbortSignal.any([resultSignal, shutdown.signal]) });
    });
  }
  return {
    async preview(input) {
      fields(input, ['id', 'accessToken', 'jobId']);
      const identity = { ...input };
      await authorize(identity);
      return jobs.withResult(owner(identity.id), identity.jobId, async ({ result, expiresAt, assertReady }) => {
        const { parsed, mapping } = await prepared(result); assertReady();
        return { jobId: identity.jobId, expiresAt, ...parsed, mapping,
          audit: structuredClone(result.audit) };
      });
    },
    async build(input) {
      fields(input, ['id', 'accessToken', 'jobId', 'requestId', 'confirmedAudit', 'confirmedModels', 'options', 'edits']);
      const identity = { id: input.id, accessToken: input.accessToken, jobId: input.jobId, requestId: input.requestId };
      await authorize(identity);
      jobs.get(owner(identity.id), identity.jobId);
      if (!UUID.test(identity.requestId ?? '')) throw new DeliveryError('Нужен номер запроса скачивания.');
      if (input.confirmedAudit !== true || input.confirmedModels !== true) throw new DeliveryError('Подтвердите сверку исходных строк и проверку всех полей моделей.');
      const options = optionsOf(input.options);
      if (!Array.isArray(input.edits ?? [])) throw new DeliveryError('Проверьте исправления моделей.');
      const serialized = JSON.stringify(input.edits ?? []);
      if (Buffer.byteLength(serialized) > 512 * 1024) throw new DeliveryError('Исправления больше 512 КБ.');
      const edits = JSON.parse(serialized);
      const fingerprint = createHash('sha256').update(JSON.stringify({ options, edits })).digest('hex');
      if (confirmations.has(identity.jobId)) throw new DeliveryError('Сохраняется завершение заказа. Повторите позже.', 409);
      const running = builds.get(identity.jobId), previous = receipts.get(identity.jobId);
      if (running) {
        if (running.owner !== owner(identity.id) || running.requestId !== identity.requestId || running.fingerprint !== fingerprint) {
          throw new DeliveryError('Уже собирается другой вариант архива. Дождитесь окончания.', 409);
        }
        return running.promise;
      }
      if (previous?.requestId === identity.requestId && previous.fingerprint !== fingerprint) {
        throw new DeliveryError('Номер запроса использован для другого варианта. Подтвердите правки с новым номером.', 409);
      }
      const promise = assemble(identity, options, edits, fingerprint).catch((error) => {
        if (error instanceof DeliveryError || error instanceof JobError || error instanceof OrderError || error instanceof ArchiveBusyError) throw error;
        if (closed) throw new DeliveryError('Сервис перезапускается. Повторите позже.', 503);
        if (error?.name === 'TimeoutError') throw new DeliveryError('Сборка превысила две минуты. Повторите скачивание без нового распознавания.', 504);
        throw new DeliveryError('Сборка остановлена или срок результата истёк. Проверьте заказ и повторите.', 409);
      });
      builds.set(identity.jobId, { owner: owner(identity.id), requestId: identity.requestId, fingerprint, promise });
      try { return await promise; }
      finally { builds.delete(identity.jobId); }
    },
    async confirmSaved(input) {
      fields(input, ['id', 'accessToken', 'jobId', 'receipt', 'downloadSaved']);
      const identity = { ...input };
      await authorize(identity, { completed: true });
      if (identity.downloadSaved !== true) throw new DeliveryError('Подтвердите, что ZIP сохранён на вашем устройстве.');
      const receipt = receipts.get(identity.jobId);
      if (!receipt || receipt.owner !== owner(identity.id) || typeof identity.receipt !== 'string' || receipt.receipt !== identity.receipt) {
        throw new DeliveryError('Подтверждение скачивания не найдено или срок истёк.', 409);
      }
      if (builds.has(identity.jobId)) throw new DeliveryError('Дождитесь окончания сборки ZIP.', 409);
      if (receipt.confirmed) return { order: await orders.get({ id: identity.id, accessToken: identity.accessToken }) };
      const previous = confirmations.get(identity.jobId);
      if (previous) return previous;
      const promise = jobs.completeResult(owner(identity.id), identity.jobId, async (binding) => {
        const order = await orders.completeAttempt(binding);
        receipt.confirmed = true; return { order };
      }).catch((error) => {
        if (error instanceof OrderError || error instanceof JobError || error instanceof DeliveryError) throw error;
        throw new DeliveryError('Не удалось сохранить завершение заказа. Повторите подтверждение позже.', 503);
      });
      confirmations.set(identity.jobId, promise);
      try { return await promise; } finally { confirmations.delete(identity.jobId); }
    },
    async close() {
      closed = true; clearInterval(timer); shutdown.abort();
      await Promise.allSettled([...builds.values()].map((item) => item.promise).concat([...confirmations.values()]));
      receipts.clear();
    },
  };
}
