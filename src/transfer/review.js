import { mapRows, TARGET_FIELDS } from './mapping.js';

export const FIELD_LIMITS = {
  name: 200, brand: 200, scale: 100, category: 100, tags: 5000,
  price: 100, purchaseDate: 100, notes: 20000, photoUrl: 2048,
};

export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parsePrice(value) {
  const normalized = value.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!normalized) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error('Введите цену от 0, не больше двух знаков после запятой.');
  const number = Number(normalized);
  if (!Number.isFinite(number) || number > 1_000_000_000) throw new Error('Цена не должна превышать 1 000 000 000.');
  return number;
}

export function parseTags(value) {
  if (!value) return [];
  let entries;
  if (value.startsWith('[')) {
    try { entries = JSON.parse(value); }
    catch { throw new Error('Теги должны быть списком строк.'); }
    if (!Array.isArray(entries)) throw new Error('Теги должны быть списком строк.');
  } else entries = value.split(/[,;\n]/u);
  if (entries.some((entry) => typeof entry !== 'string')) throw new Error('Каждый тег должен быть текстом.');
  const tags = [...new Set(entries.map((entry) => entry.trim()).filter(Boolean))];
  if (tags.length > 16 || tags.some((tag) => tag.length > 100)) throw new Error('Не больше 16 тегов, каждый до 100 символов.');
  return tags;
}

// The index binds corrections to an input record, including identical models.
// Neither exported IDs nor source-line numbers can be changed by a correction.
export function reviewRows(parsed, mapping, edits = []) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) ||
      Object.entries(mapping).some(([field, header]) => !TARGET_FIELDS.includes(field) ||
        typeof header !== 'string' || (header && !parsed.headers.includes(header)))) {
    throw new Error('Проверьте соответствие столбцов полям модели.');
  }
  if (!Array.isArray(edits) || edits.length > 300 ||
      new TextEncoder().encode(JSON.stringify(edits)).length > 512 * 1024) {
    throw new Error('Слишком много исправлений: не больше 300 моделей и 512 КБ текста.');
  }
  const rows = mapRows(parsed.rows, mapping);
  const seen = new Set();
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit) ||
        Object.keys(edit).some((key) => !['rowIndex', 'values'].includes(key)) ||
        !Number.isInteger(edit.rowIndex) || edit.rowIndex < 0 || edit.rowIndex >= rows.length ||
        seen.has(edit.rowIndex) || !edit.values || typeof edit.values !== 'object' || Array.isArray(edit.values)) {
      throw new Error('Исправления должны относиться к существующим моделям без повторных номеров.');
    }
    seen.add(edit.rowIndex);
    for (const [field, value] of Object.entries(edit.values)) {
      if (!Object.hasOwn(FIELD_LIMITS, field) || typeof value !== 'string' || value.length > FIELD_LIMITS[field]) {
        throw new Error(`Модель ${edit.rowIndex + 1}: недопустимое поле или слишком длинное исправление.`);
      }
      rows[edit.rowIndex][field] = value.trim();
    }
  }
  return rows;
}

export function rowProblems(row) {
  const errors = {};
  for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
    if (row[field].length > limit) errors[field] = `Не больше ${limit} символов.`;
  }
  if (!row.name) errors.name = 'Введите название модели.';
  if (row.scale && !/^[1-9]\d*:[1-9]\d*$/u.test(row.scale)) errors.scale = 'Введите масштаб вида 1:64 или оставьте пустым.';
  if (row.purchaseDate && !validDate(row.purchaseDate)) errors.purchaseDate = 'Введите существующую дату в формате ГГГГ-ММ-ДД или оставьте пустым.';
  try { parsePrice(row.price); } catch (error) { errors.price = error.message; }
  try { parseTags(row.tags); } catch (error) { errors.tags = error.message; }
  return errors;
}
