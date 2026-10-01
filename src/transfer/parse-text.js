const HEADERS = ['Название', 'Бренд', 'Категория', 'Теги', 'Заметки'];
const MAX_RECORDS = 10_000;

function isHeading(line) {
  const letters = line.match(/\p{L}/gu) ?? [];
  return letters.length >= 5 && line === line.toLocaleUpperCase();
}

function brandFromSection(section, title) {
  if (/HOT WHEELS/i.test(section)) return 'Hot Wheels';
  if (/MATCHBOX/i.test(section)) return 'Matchbox';
  if (/HOT WHEELS/i.test(title)) return 'Hot Wheels';
  if (/MATCHBOX/i.test(title)) return 'Matchbox';
  return '';
}

function categoryFromSection(section) {
  if (/АКСЕССУАРЫ|ACCESSORIES/iu.test(section)) return 'Аксессуары';
  if (/HOT WHEELS|MATCHBOX/iu.test(section)) return 'Автомобили';
  return section;
}

function tagsFromEntry(title, description, section) {
  const tags = [];
  const years = title.match(/\((\d{4})[–-](\d{4})\)/u);
  const year = title.match(/\((\d{4})\)/u);
  if (years) tags.push(`Период выпуска: ${years[1]}–${years[2]}`);
  else if (year) tags.push(`Год выпуска: ${year[1]}`);
  if (/\[MOC\]/iu.test(title) || (/\[MOC\]/iu.test(section) && !/LOOSE/iu.test(section))) tags.push('MOC');
  if (/\[LOOSE\]/iu.test(title)) tags.push('Loose');
  if (/\bPREMIUM\b/iu.test(title) || /\bPREMIUM\b/iu.test(section)) tags.push('Premium');
  if (/Тестовый образец/iu.test(description)) tags.push('Тестовый образец');
  return tags;
}

function decodeText(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('windows-1251').decode(bytes); }
}

export function parseText(bytes) {
  const text = decodeText(bytes).replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error('Текстовый файл пуст');
  const lines = text.split(/\r?\n/);
  const rows = [];
  const warnings = [];
  let section = 'Без категории';
  let subsection = '';
  let current = null;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim();
    if (!raw) continue;
    const bullet = /^[•●]\s*/u.test(raw);
    const line = raw.replace(/^[•●]\s*/u, '')
      .replace(/^(?:[\u{1F1E6}-\u{1F1FF}]{2}|🗂️)\s*/u, '').trim();
    const code = line.match(/^([A-Z]\d{2})(.*)$/u);
    const separator = line.lastIndexOf(' — ');
    if (separator >= 0 && (code || (bullet && !/^(?:Статус|Техническая расшифровка):/i.test(line)))) {
      const rawTitle = line.slice(0, separator).trim();
      const title = rawTitle;
      const description = line.slice(separator + 3).trim();
      if (!title) {
        warnings.push({ line: index + 1, text: raw.slice(0, 160) });
        continue;
      }
      const notes = [];
      const category = categoryFromSection(section);
      if (category !== section) notes.push(`Раздел источника: ${section}`);
      if (subsection) notes.push(`Подраздел: ${subsection}`);
      if (description) notes.push(description);
      current = { Название: title, Бренд: brandFromSection(section, title), Категория: category,
        Теги: JSON.stringify(tagsFromEntry(title, description, section)),
        Заметки: notes.join('\n'), _sourceLine: index + 1 };
      rows.push(current);
      if (rows.length > MAX_RECORDS) throw new Error('В тексте больше 10 000 моделей');
    } else if (isHeading(line) && !bullet) {
      section = line.replace(/^[^\p{L}\p{N}]+/u, '').trim();
      subsection = '';
      current = null;
    } else if (!bullet && line === 'Серийный выпуск') {
      subsection = line;
      current = null;
    } else if (current && !code) {
      current.Заметки += `\n${line}`;
      if (!bullet && !/^[(\[]/.test(line)) {
        warnings.push({ line: index + 1, text: raw.slice(0, 160) });
      }
    } else {
      warnings.push({ line: index + 1, text: raw.slice(0, 160) });
    }
  }
  if (rows.length === 0) throw new Error('Не удалось найти модели в тексте. Нужны строки вида «A01 Название — описание».');
  return { headers: HEADERS, rows, warnings };
}
