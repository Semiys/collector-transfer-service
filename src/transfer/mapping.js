const ALIASES = {
  name: [/^model name$/i, /^model$/i, /^name$/i, /^название/i, /^модель$/i, /^наименование/i],
  brand: [/^brand$/i, /^бренд$/i, /^производитель$/i],
  scale: [/^scale$/i, /^масштаб$/i],
  category: [/^категория из json$/i, /^категор/i, /^category$/i],
  price: [/^price paid/i, /^purchase price/i, /^price$/i, /^цена покупки/i, /^цена$/i],
  purchaseDate: [/^purchase date/i, /^purchasedate$/i, /^дата покупки/i],
  notes: [/^notes?$/i, /^заметки$/i, /^примечания$/i],
  photoUrl: [/^my photo url$/i, /^photo url$/i, /^photourl$/i, /^ссылка на фото$/i],
};

export const TARGET_FIELDS = Object.keys(ALIASES);

export function suggestMapping(headers) {
  return Object.fromEntries(TARGET_FIELDS.map((field) => [
    field,
    headers.find((header) => ALIASES[field].some((pattern) => pattern.test(header.trim()))) ?? '',
  ]));
}

export function detectPriceCurrency(header) {
  if (!header) return 'UNKNOWN';
  if (/\bEUR\b|€|евро/i.test(header)) return 'EUR';
  if (/\bRUB\b|₽|руб/i.test(header)) return 'RUB';
  return 'UNKNOWN';
}

export function mapRows(rows, mapping) {
  if (!mapping.name) throw new Error('Выберите столбец с названием модели');
  const mappedHeaders = new Set(Object.values(mapping).filter(Boolean));
  return rows.map((source, index) => {
    const get = (field) => mapping[field] ? String(source[mapping[field]] ?? '').trim() : '';
    const extra = Object.entries(source)
      .filter(([header, value]) => header !== '_sourceLine' && !mappedHeaders.has(header) &&
        !/(?:photo|image)\s*url/i.test(header) && String(value ?? '').trim())
      .map(([header, value]) => `${header}: ${value}`);
    return {
      name: get('name'), brand: get('brand'), scale: get('scale'),
      category: get('category'), price: get('price'), purchaseDate: get('purchaseDate'),
      notes: [get('notes'), ...extra].filter(Boolean).join('\n'),
      photoUrl: get('photoUrl'),
      sourceRow: source._sourceLine ?? index + 2,
    };
  });
}
