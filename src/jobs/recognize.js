import { parseInput } from '../transfer/parse-input.js';
import { JobError } from './store.js';
import { GroqRateLimitError } from '../ai/groq.js';
import { setTimeout as delay } from 'node:timers/promises';

export async function prepareSource({ filename, bytes }) {
  let records;
  let sourceFormat = 'text';
  if (filename.toLowerCase().endsWith('.txt')) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new JobError('Текст должен быть в кодировке UTF-8.'); }
    if (text.length > 200_000) throw new JobError('Текст длиннее 200 000 символов. Разделите источник.');
    records = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((text, index) => ({ id: index + 1, text: text.trim() })).filter((item) => item.text);
  } else {
    let parsed;
    try { parsed = await parseInput(filename, bytes); }
    catch { throw new JobError('Не удалось прочитать таблицу. Поддерживаются CSV, XLSX и JSON со списком объектов.'); }
    records = parsed.rows.map((row, index) => ({ id: index + 1, text: JSON.stringify(row) }));
    sourceFormat = 'table';
  }
  if (!records.length || records.length > 300) throw new JobError('Нужно от 1 до 300 непустых строк. Разделите источник на части.');
  if (records.some((item) => item.text.length > 8000) || records.reduce((sum, item) => sum + item.text.length, 0) > 200_000) {
    throw new JobError('Исходник слишком большой: до 8 000 символов в строке и 200 000 всего.');
  }
  const chunks = [];
  let chunk = [], length = 0;
  for (const record of records) {
    if (chunk.length && (chunk.length >= 15 || length + record.text.length > 9000)) { chunks.push(chunk); chunk = []; length = 0; }
    chunk.push(record); length += record.text.length;
  }
  if (chunk.length) chunks.push(chunk);
  if (chunks.length > 30) throw new JobError('Для исходника нужно больше 30 частей. Разделите его.');
  return { records, chunks, sourceFormat, numbering: filename.toLowerCase().endsWith('.txt') ?
    'Номера строк исходного текста, включая пропущенные пустые строки.' :
    'Номера непустых записей таблицы, начиная с 1, без строки названий столбцов.' };
}

export function createRecognitionWorker(aiService, {
  waitForRetry = (milliseconds, signal) => delay(milliseconds, undefined, { signal }), now = Date.now,
} = {}) {
  return async ({ source, route, signal, progress, releaseSource = () => {} }) => {
    const { records, chunks, numbering, sourceFormat = 'text' } = source.prepared ?? await prepareSource(source);
    source = null;
    releaseSource();
    signal.throwIfAborted();
    const models = [], warnings = [], unassigned = [], diagnostics = [];
    let context = '';
    progress({ total: chunks.length, sourceCount: records.length });
    for (let index = 0; index < chunks.length; index += 1) {
      signal.throwIfAborted();
      let part, retries = 0;
      while (!part) {
        signal.throwIfAborted();
        try { part = await aiService.run({ route, records: chunks[index], sourceFormat, context, signal }); }
        catch (error) {
          signal.throwIfAborted();
          // Retry only an explicit short 429 pause, never malformed results or timeouts.
          if (!(error instanceof GroqRateLimitError) || !error.details.retryAfterProvided ||
            !Number.isFinite(error.retryAfterMs) || error.retryAfterMs < 0 || error.retryAfterMs > 60_000 || retries >= 2) {
            progress({ retryAt: 0, retryPart: 0 });
            throw new JobError(`Часть ${index + 1}: ${error.message}`);
          }
          retries += 1;
          progress({ retryAt: now() + error.retryAfterMs, retryPart: index + 1, retryAttempt: retries });
          await waitForRetry(error.retryAfterMs, signal);
          signal.throwIfAborted();
          progress({ retryAt: 0, retryPart: 0 });
        }
      }
      models.push(...part.models);
      if (models.length > 300) throw new JobError('Распознано больше 300 моделей. Разделите источник.');
      warnings.push(...part.warnings);
      for (const item of part.unassigned) {
        const original = chunks[index].find((record) => record.id === item.sourceId);
        unassigned.push({ ...item, text: original.text });
        if (item.kind === 'section') context = (context + '\n' + original.text).slice(-2000);
      }
      diagnostics.push({ part: index + 1, modelUsed: part.modelUsed, keyUsed: part.keyUsed, fallbackUsed: part.fallbackUsed });
      progress({ completed: index + 1, modelCount: models.length, retryAt: 0, retryPart: 0 });
    }
    if (!models.length) {
      const sections = unassigned.filter((item) => item.kind === 'section').length;
      throw new JobError(`Исходник прочитан: ${records.length} непустых записей. ` +
        `ИИ не выделил ни одной модели: отнёс к заголовкам ${sections}, к неясным записям ${unassigned.length - sections}. ` +
        (sourceFormat === 'table' ? 'Проверьте столбец с названием или артикулом и попробуйте небольшой пример. Это не ошибка загрузки файла.' :
          'Проверьте, что в тексте есть названия предметов, а не только названия разделов.'));
    }
    models.sort((a, b) => a.sourceIds[0] - b.sourceIds[0]);
    const currencies = new Set(models.filter((item) => item.price).map((item) => item.currency));
    let priceCurrency = currencies.size === 1 ? [...currencies][0] : currencies.size === 0 ? 'RUB' : 'UNKNOWN';
    if (currencies.size > 1 || priceCurrency === 'OTHER') {
      for (const item of models) {
        if (!item.price) continue;
        item.notes = `${item.notes}\nИсходная цена: ${item.price}; валюта: ${item.currency}. Требуется ручной перевод в рубли.`.trim();
        item.price = '';
      }
      priceCurrency = 'RUB';
      warnings.push('В исходнике разные или неподдерживаемые валюты. Цены сохранены в заметках; укажите рубли вручную.');
    }
    if (priceCurrency === 'UNKNOWN') warnings.push('Валюта цен не указана. Выберите валюту в предпросмотре; не принимайте эти числа за рубли автоматически.');
    if (chunks.length > 1) warnings.push('Проверьте модели на границах частей: описание в нескольких строках могло разделиться.');
    if (unassigned.length) warnings.push(`Строки без модели: ${unassigned.length}, включая заголовки. Проверьте сверку перед переносом.`);
    const uniqueWarnings = [...new Set(warnings)];
    if (uniqueWarnings.length > 200) uniqueWarnings.splice(199, Infinity, 'Замечаний больше 200. Особенно внимательно проверьте все модели и исходные строки.');
    return { transferSource: 'groq-ai-v1', priceCurrency,
      models: models.map(({ currency, sourceIds, ...item }) => item), warnings: uniqueWarnings,
      audit: { numbering, sourceCount: records.length, assignedCount: records.length - unassigned.length,
        modelSources: models.map((item, index) => ({ model: index + 1, name: item.name, sourceIds: item.sourceIds })), unassigned }, diagnostics };
  };
}
