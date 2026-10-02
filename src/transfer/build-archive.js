import { zipSync, strToU8 } from 'fflate';
import { detectPriceCurrency } from './mapping.js';
import { reviewRows, rowProblems, validDate, parsePrice, parseTags } from './review.js';
import { downloadHunt64Photo, placeholderPhoto } from './photos.js';

const MAX_MODELS = 300;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

function isCarCategory(value) {
  return /^(автомобили|машинки|automotive|cars)$/iu.test(value);
}

export async function buildArchive({ parsed, mapping, options, edits = [], eurRate, signal,
  downloadPhoto = (url, { signal } = {}) => downloadHunt64Photo(url, fetch, { signal }) }) {
  signal?.throwIfAborted();
  if (parsed.warnings?.length && options.acceptTextWarnings !== true) {
    throw new Error('Проверьте непрочитанные строки текста и подтвердите перенос');
  }
  const mapped = reviewRows(parsed, mapping, edits);
  if (mapped.length > MAX_MODELS) throw new Error(`За один раз можно перенести не более ${MAX_MODELS} моделей`);
  for (const row of mapped) {
    const errors = Object.values(rowProblems(row));
    if (errors.length) throw new Error(`Строка ${row.sourceRow}: ${errors.join(' ')}`);
  }
  const exportedAt = new Date().toISOString();
  const defaultCategory = String(options.defaultCategory ?? '').trim() || 'Без категории';
  const defaultScale = String(options.defaultScale ?? '').trim();
  if (defaultScale && !/^[1-9]\d*:[1-9]\d*$/u.test(defaultScale)) {
    throw new Error('Масштаб по умолчанию должен быть вида 1:64');
  }
  const transferDate = String(options.transferDate ?? exportedAt.slice(0, 10)).trim();
  const priceCurrency = String(options.priceCurrency ?? detectPriceCurrency(mapping.price));
  if (!['EUR', 'RUB'].includes(priceCurrency)) throw new Error('Выберите валюту цены: RUB или EUR');
  if (priceCurrency === 'EUR' && (!eurRate || !Number.isFinite(eurRate.rubPerEuro))) {
    throw new Error('Для цены в евро требуется актуальный курс ЦБ');
  }
  if (!validDate(transferDate)) throw new Error('Некорректная дата переноса');

  const categories = [];
  const categoryIds = new Map();
  const tags = [];
  const tagIds = new Map();
  const modelTags = [];
  const models = [];
  const files = {};
  const failedPhotos = [];
  const placeholder = await placeholderPhoto();
  signal?.throwIfAborted();
  let totalPhotos = 0;

  for (let index = 0; index < mapped.length; index += 1) {
    signal?.throwIfAborted();
    const row = mapped[index];
    if (!row.name || row.name.length > 200) {
      throw new Error(`Строка ${row.sourceRow}: название должно содержать от 1 до 200 символов`);
    }
    const category = (row.category || defaultCategory).slice(0, 100);
    const scale = row.scale || (isCarCategory(category) ? defaultScale : '');
    if (scale && !/^[1-9]\d*:[1-9]\d*$/u.test(scale)) {
      throw new Error(`Строка ${row.sourceRow}: масштаб должен быть вида 1:64`);
    }
    if (!categoryIds.has(category)) {
      const id = categories.length + 1;
      categories.push({ id, name: category, colorHex: null });
      categoryIds.set(category, id);
    }
    const originalPrice = parsePrice(row.price);
    const price = originalPrice == null ? 0 :
      Math.round(originalPrice * (priceCurrency === 'EUR' ? eurRate.rubPerEuro : 1) * 100) / 100;
    const notes = [row.notes];
    if (originalPrice == null) notes.push('Цена покупки не указана в источнике; в приложении установлено 0 ₽.');
    else if (priceCurrency === 'EUR') {
      notes.push(`Исходная цена: ${originalPrice.toFixed(2)} EUR. Курс ЦБ на ${eurRate.date}: 1 EUR = ${eurRate.rubPerEuro} RUB.`);
    }
    const purchaseDate = validDate(row.purchaseDate) ? row.purchaseDate : transferDate;
    if (!validDate(row.purchaseDate)) notes.push(`Дата покупки отсутствовала в источнике; указана дата переноса ${transferDate}.`);

    let photo = placeholder;
    if (row.photoUrl) {
      try { photo = await downloadPhoto(row.photoUrl, { signal }); }
      catch {
        signal?.throwIfAborted();
        failedPhotos.push(row.sourceRow);
        notes.push('Личное фото по ссылке не удалось загрузить; добавлена заглушка.');
      }
    } else notes.push('Личное фото отсутствовало в источнике; добавлена заглушка.');
    signal?.throwIfAborted();
    totalPhotos += photo.length;
    if (totalPhotos > MAX_ARCHIVE_BYTES) throw new Error('Фотографии превышают лимит архива 100 МБ');
    const id = index + 1;
    for (const tag of parseTags(row.tags)) {
      if (!tagIds.has(tag)) {
        const tagId = tags.length + 1;
        tags.push({ id: tagId, name: tag });
        tagIds.set(tag, tagId);
      }
      modelTags.push({ modelId: id, tagId: tagIds.get(tag) });
    }
    const photoEntry = `photos/${id}.jpg`;
    files[photoEntry] = new Uint8Array(photo);
    const noteText = notes.filter(Boolean).join('\n').trim();
    if (noteText.length > 20_000) throw new Error(`Строка ${row.sourceRow}: заметки слишком длинные`);
    models.push({
      id, name: row.name, brand: row.brand || null, scale: scale || null,
      price, purchaseDate, notes: noteText || null, photoEntry,
      categoryId: categoryIds.get(category), createdAt: exportedAt,
    });
  }

  const document = { formatVersion: 1, exportedAt, categories, models, tags, modelTags, config: null };
  files['collection.json'] = strToU8(JSON.stringify(document));
  if (files['collection.json'].length > 8 * 1024 * 1024) throw new Error('JSON превышает лимит приложения');
  signal?.throwIfAborted();
  const archive = zipSync(files, { level: 0 });
  signal?.throwIfAborted();
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error('ZIP превышает лимит сервиса 100 МБ');
  return { archive, document, failedPhotos };
}
