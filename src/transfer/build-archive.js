import { zipSync, strToU8 } from 'fflate';
import { mapRows, detectPriceCurrency } from './mapping.js';
import { downloadHunt64Photo, placeholderPhoto } from './photos.js';

const MAX_MODELS = 300;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parsePrice(value, row) {
  const normalized = value.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!normalized) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error(`Строка ${row}: неверная цена «${value}»`);
  }
  const number = Number(normalized);
  if (!Number.isFinite(number) || number > 1_000_000_000) {
    throw new Error(`Строка ${row}: цена слишком велика`);
  }
  return number;
}

export async function buildArchive({ parsed, mapping, options, eurRate, downloadPhoto = downloadHunt64Photo }) {
  if (parsed.warnings?.length && options.acceptTextWarnings !== true) {
    throw new Error('Проверьте непрочитанные строки текста и подтвердите перенос');
  }
  for (const [field, header] of Object.entries(mapping)) {
    if (header && !parsed.headers.includes(header)) throw new Error(`Неизвестный столбец для поля ${field}`);
  }
  const mapped = mapRows(parsed.rows, mapping);
  if (mapped.length > MAX_MODELS) throw new Error(`За один раз можно перенести не более ${MAX_MODELS} моделей`);
  const exportedAt = new Date().toISOString();
  const defaultCategory = String(options.defaultCategory ?? '').trim() || 'Без категории';
  const transferDate = String(options.transferDate ?? exportedAt.slice(0, 10)).trim();
  const priceCurrency = String(options.priceCurrency ?? detectPriceCurrency(mapping.price));
  if (!['EUR', 'RUB'].includes(priceCurrency)) throw new Error('Выберите валюту цены: RUB или EUR');
  if (priceCurrency === 'EUR' && (!eurRate || !Number.isFinite(eurRate.rubPerEuro))) {
    throw new Error('Для цены в евро требуется актуальный курс ЦБ');
  }
  if (!validDate(transferDate)) throw new Error('Некорректная дата переноса');

  const categories = [];
  const categoryIds = new Map();
  const models = [];
  const files = {};
  const failedPhotos = [];
  const placeholder = await placeholderPhoto();
  let totalPhotos = 0;

  for (let index = 0; index < mapped.length; index += 1) {
    const row = mapped[index];
    if (!row.name || row.name.length > 200) {
      throw new Error(`Строка ${row.sourceRow}: название должно содержать от 1 до 200 символов`);
    }
    const category = (row.category || defaultCategory).slice(0, 100);
    if (!categoryIds.has(category)) {
      const id = categories.length + 1;
      categories.push({ id, name: category, colorHex: null });
      categoryIds.set(category, id);
    }
    const originalPrice = parsePrice(row.price, row.sourceRow);
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
      try { photo = await downloadPhoto(row.photoUrl); }
      catch {
        failedPhotos.push(row.sourceRow);
        notes.push('Личное фото по ссылке не удалось загрузить; добавлена заглушка.');
      }
    } else notes.push('Личное фото отсутствовало в источнике; добавлена заглушка.');
    totalPhotos += photo.length;
    if (totalPhotos > MAX_ARCHIVE_BYTES) throw new Error('Фотографии превышают лимит архива 100 МБ');
    const id = index + 1;
    const photoEntry = `photos/${id}.jpg`;
    files[photoEntry] = new Uint8Array(photo);
    const noteText = notes.filter(Boolean).join('\n').trim();
    if (noteText.length > 20_000) throw new Error(`Строка ${row.sourceRow}: заметки слишком длинные`);
    models.push({
      id, name: row.name, brand: row.brand || null, scale: row.scale || null,
      price, purchaseDate, notes: noteText || null, photoEntry,
      categoryId: categoryIds.get(category), createdAt: exportedAt,
    });
  }

  const document = { formatVersion: 1, exportedAt, categories, models, tags: [], modelTags: [], config: null };
  files['collection.json'] = strToU8(JSON.stringify(document));
  if (files['collection.json'].length > 8 * 1024 * 1024) throw new Error('JSON превышает лимит приложения');
  const archive = zipSync(files, { level: 0 });
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error('ZIP превышает лимит сервиса 100 МБ');
  return { archive, document, failedPhotos };
}
