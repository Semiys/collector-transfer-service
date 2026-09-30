import { parse } from 'csv-parse/sync';

const MAX_RECORDS = 10_000;

function decodeCsv(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1251').decode(bytes);
  }
}

function countDelimiters(line, delimiter) {
  let quoted = false;
  let count = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"') {
      if (quoted && line[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && line[index] === delimiter) {
      count += 1;
    }
  }
  return count;
}

function detectDelimiter(text) {
  const header = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  const choices = [',', ';', '\t'];
  return choices.reduce((best, candidate) =>
    countDelimiters(header, candidate) > countDelimiters(header, best) ? candidate : best
  );
}

export function parseCsv(bytes) {
  const text = decodeCsv(bytes);
  const delimiter = detectDelimiter(text);
  const rows = parse(text, {
    bom: true,
    columns: (headers) => {
      if (headers.some((header) => !header.trim()) || new Set(headers).size !== headers.length) {
        throw new Error('Заголовки CSV пустые или повторяются');
      }
      return headers;
    },
    delimiter,
    skip_empty_lines: true,
    trim: true,
    max_record_size: 1_000_000,
    relax_quotes: false,
  });
  if (rows.length > MAX_RECORDS) throw new Error('CSV содержит больше 10 000 строк');
  if (rows.length === 0) throw new Error('CSV не содержит моделей');
  const headers = Object.keys(rows[0]);
  if (headers.length < 1 || headers.some((header) => !header.trim())) {
    throw new Error('У CSV нет корректной строки заголовков');
  }
  return { headers, rows, delimiter };
}
