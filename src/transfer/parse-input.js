import ExcelJS from 'exceljs';
import { parseCsv } from './parse-csv.js';
import { parseText } from './parse-text.js';

const MAX_ROWS = 10_000;

function rowsFromObjects(objects) {
  if (!Array.isArray(objects) || objects.length === 0) {
    throw new Error('В файле нет записей коллекции');
  }
  if (objects.length > MAX_ROWS) throw new Error('Слишком много записей (не более 10 000)');
  if (objects.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('Ожидается список объектов');
  }
  const headers = [...new Set(objects.flatMap((item) => Object.keys(item)))];
  const rows = objects.map((item) => Object.fromEntries(headers.map((header) => {
    const value = item[header];
    return [header, value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)];
  })));
  return { headers, rows };
}

function parseJson(bytes) {
  let source;
  try {
    source = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('JSON повреждён или не является UTF-8');
  }
  const objects = Array.isArray(source) ? source : source?.models;
  const parsed = rowsFromObjects(objects);
  if (source?.transferSource === 'openrouter-ai-v1' || source?.transferSource === 'manual-ai-v1') {
    const warnings = Array.isArray(source.warnings) ? source.warnings : [];
    if (warnings.length > 200 || warnings.some((item) => typeof item !== 'string' || item.length > 500)) {
      throw new Error('Некорректные замечания к результату ИИ');
    }
    parsed.warnings = [
      { line: 'ИИ', text: 'Проверьте каждую модель: распознавание может ошибиться даже без замечаний.' },
      ...warnings.map((item, index) => ({ line: index + 1, text: item })),
    ];
    parsed.type = 'ai-json';
  }
  if (!Array.isArray(source) && Array.isArray(source?.categories)) {
    const categoryById = new Map(source.categories.map((item) => [item.id, item.name]));
    parsed.headers.push('Категория из JSON');
    parsed.rows.forEach((row, index) => {
      row['Категория из JSON'] = categoryById.get(objects[index].categoryId) ?? '';
    });
  }
  return parsed;
}

function cellText(cell) {
  const value = cell.value;
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return cell.text?.trim() ?? String(value).trim();
}

async function parseExcel(bytes) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(bytes));
  } catch {
    throw new Error('Не удалось прочитать XLSX');
  }
  const sheet = workbook.worksheets.find((item) => item.actualRowCount > 0);
  if (!sheet) throw new Error('В Excel нет заполненного листа');
  if (sheet.rowCount > MAX_ROWS + 1) throw new Error('В Excel слишком много строк или большой разрыв между строками');
  const firstRow = sheet.getRow(1);
  const headers = Array.from({ length: firstRow.cellCount }, (_, index) => cellText(firstRow.getCell(index + 1)));
  if (headers.length > 100) throw new Error('В Excel слишком много столбцов');
  if (headers.length === 0 || headers.some((header) => !header)) {
    throw new Error('Первая строка Excel должна содержать названия столбцов');
  }
  if (new Set(headers).size !== headers.length) throw new Error('Названия столбцов Excel повторяются');
  const rows = [];
  for (let number = 2; number <= sheet.rowCount; number += 1) {
    const row = sheet.getRow(number);
    const values = headers.map((_, index) => cellText(row.getCell(index + 1)));
    if (values.every((value) => !value)) continue;
    rows.push(Object.fromEntries(headers.map((header, index) => [header, values[index]])));
    if (rows.length > MAX_ROWS) throw new Error('Слишком много строк Excel (не более 10 000)');
  }
  if (rows.length === 0) throw new Error('На первом листе Excel нет моделей');
  return { headers, rows };
}

export async function parseInput(filename, bytes) {
  const extension = filename.toLowerCase().split('.').pop();
  if (extension === 'csv') return { type: 'csv', ...parseCsv(bytes) };
  if (extension === 'xlsx') return { type: 'xlsx', ...await parseExcel(bytes) };
  if (extension === 'json') return { type: 'json', ...parseJson(bytes) };
  if (extension === 'txt') return { type: 'txt', ...parseText(bytes) };
  throw new Error('Поддерживаются CSV, XLSX, JSON и TXT');
}
