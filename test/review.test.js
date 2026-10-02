import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import { parseInput } from '../src/transfer/parse-input.js';
import { suggestMapping } from '../src/transfer/mapping.js';
import { reviewRows, rowProblems, validDate } from '../src/transfer/review.js';
import { buildArchive } from '../src/transfer/build-archive.js';
import { createApp } from '../src/server.js';
import { CaptchaError } from '../src/http/captcha.js';

const options = { priceCurrency: 'RUB', transferDate: '2026-10-01' };

test('default manufacturer agrees in preview and ZIP, preserving explicit and corrected brands', async () => {
  const parsed = await parseInput('example.json', Buffer.from(JSON.stringify([
    { name: 'Invented car', brand: '' }, { name: 'Invented figure', brand: 'Other Maker' },
    { name: 'Invented third item', brand: '' },
  ])));
  const original = structuredClone(parsed), mapping = suggestMapping(parsed.headers);
  const defaults = { defaultBrand: 'Example Maker' }, edits = [{ rowIndex: 2, values: { brand: '' } }];
  const preview = reviewRows(parsed, mapping, edits, defaults);
  const result = await buildArchive({ parsed, mapping, edits, options: { ...options, ...defaults } });
  assert.deepEqual(preview.map((row) => row.brand), ['Example Maker', 'Other Maker', '']);
  assert.deepEqual(result.document.models.map((row) => row.brand), ['Example Maker', 'Other Maker', null]);
  assert.match(result.document.models[0].notes, /Производитель указан пользователем/);
  assert.match(result.document.models[0].notes, /Дата покупки отсутствовала/);
  assert.deepEqual(parsed, original);
  assert.throws(() => reviewRows(parsed, mapping, [], { defaultBrand: 'x'.repeat(201) }), /200/);
});

test('corrections bind to one of two identical models and preserve ZIP links and the original source', async () => {
  const source = [1, 2].map(() => ({ name: 'Одинаковая модель', brand: 'Hot Wheels', scale: '1:64',
    category: 'Автомобили', tags: ['Год выпуска: 1969'], price: '550', purchaseDate: '', notes: '',
    'Место хранения': 'Полка 2' }));
  const parsed = await parseInput('collection.json', Buffer.from(JSON.stringify(source)));
  const original = structuredClone(parsed);
  const mapping = suggestMapping(parsed.headers);
  const edits = [{ rowIndex: 1, values: { name: 'Исправленная модель', brand: 'Matchbox', scale: '1:43',
    category: 'Корабли', tags: '["Premium", "Красный, белый", "Premium"]', price: '7,30',
    purchaseDate: '2024-02-29', notes: 'Проверено владельцем' } }];
  const result = await buildArchive({ parsed, mapping, options, edits });
  const files = unzipSync(result.archive);
  const document = JSON.parse(new TextDecoder().decode(files['collection.json']));
  assert.equal(document.models.length, 2);
  assert.equal(document.models[0].name, 'Одинаковая модель');
  assert.equal(document.models[0].price, 550);
  assert.match(document.models[0].notes, /Место хранения: Полка 2/);
  const model = document.models[1];
  assert.equal(model.name, 'Исправленная модель');
  assert.equal(model.brand, 'Matchbox');
  assert.equal(model.scale, '1:43');
  assert.equal(model.price, 7.3);
  assert.equal(model.purchaseDate, '2024-02-29');
  assert.equal(document.categories.find((item) => item.id === model.categoryId).name, 'Корабли');
  assert.equal(model.photoEntry, 'photos/2.jpg');
  assert.ok(files[model.photoEntry]);
  assert.deepEqual(document.modelTags.filter((link) => link.modelId === model.id)
    .map((link) => document.tags.find((tag) => tag.id === link.tagId).name), ['Premium', 'Красный, белый']);
  assert.deepEqual(parsed, original);
});

test('correction structure cannot add records, replace IDs, inject fields or exceed the memory budget', async () => {
  const parsed = await parseInput('collection.csv', Buffer.from('Название,Цена\nМодель,550\nМодель,700'));
  const mapping = suggestMapping(parsed.headers);
  const badEdits = [null, {}, [{ rowIndex: -1, values: { name: 'A' } }],
    [{ rowIndex: 2, values: { name: 'A' } }], [{ rowIndex: 0.5, values: {} }],
    [{ rowIndex: 0, values: { name: 'A' } }, { rowIndex: 0, values: { name: 'B' } }],
    [{ rowIndex: 0, id: 9, values: {} }], [{ rowIndex: 0, values: { sourceRow: '9' } }],
    [{ rowIndex: 0, values: { categoryId: '9' } }], [{ rowIndex: 0, values: { price: 550 } }],
    [{ rowIndex: 0, values: [] }], [{ rowIndex: 0, values: { name: 'a'.repeat(201) } }],
    JSON.parse('[{"rowIndex":0,"values":{"__proto__":"polluted"}}]'),
    Array.from({ length: 301 }, () => ({ rowIndex: 0, values: {} })),
    Array.from({ length: 30 }, (_, rowIndex) => ({ rowIndex, values: { notes: 'я'.repeat(19000) } })),
  ];
  for (const edits of badEdits) assert.throws(() => reviewRows(parsed, mapping, edits));
  for (const badMapping of [null, [], { ...mapping, unknown: 'Цена' }, { ...mapping, name: ['Название'] },
    { ...mapping, price: 'Нет столбца' }]) assert.throws(() => reviewRows(parsed, badMapping));
  assert.equal({}.polluted, undefined);
});

test('all records are checked before downloading photos; invalid filled dates never become transfer dates', async () => {
  const source = [{ name: 'Первая модель', photoUrl: 'https://example.test/first.jpg' },
    { name: 'Вторая модель', purchaseDate: '2026-02-30', price: '-5', scale: 'vv:1:35', tags: [123] }];
  const parsed = await parseInput('collection.json', Buffer.from(JSON.stringify(source)));
  const mapping = suggestMapping(parsed.headers);
  let calls = 0;
  await assert.rejects(buildArchive({ parsed, mapping, options, downloadPhoto: async () => { calls += 1; return Buffer.from([]); } }),
    /существующую дату/);
  assert.equal(calls, 0);
  const row = reviewRows(parsed, mapping)[1];
  assert.deepEqual(Object.keys(rowProblems(row)).sort(), ['price', 'purchaseDate', 'scale', 'tags']);
  const result = await buildArchive({ parsed, mapping, options,
    edits: [{ rowIndex: 1, values: { purchaseDate: '', price: '', scale: '', tags: '[]' } }],
    downloadPhoto: async () => { throw new Error('offline'); } });
  assert.equal(result.document.models[1].price, 0);
  assert.equal(result.document.models[1].purchaseDate, '2026-10-01');
  assert.match(result.document.models[1].notes, /Дата покупки отсутствовала/);
  assert.equal(validDate('2024-02-29'), true);
  assert.equal(validDate('2025-02-29'), false);
  assert.equal(validDate('2026-09-31'), false);
});

test('corrections fill missing columns, override defaults and can remove a photo without downloading it', async () => {
  const parsed = await parseInput('collection.csv', Buffer.from('Название,Цена,My Photo URL\nМодель,10,https://example.test/photo.jpg'));
  const mapping = suggestMapping(parsed.headers);
  const edits = [{ rowIndex: 0, values: { category: 'Аксессуары', scale: '1:1', brand: 'Производитель',
    tags: '["Год выпуска: 1970"]', price: '7.30', photoUrl: '' } }];
  let calls = 0;
  const result = await buildArchive({ parsed, mapping, edits,
    options: { ...options, priceCurrency: 'EUR', defaultCategory: 'Автомобили', defaultScale: '1:64' },
    eurRate: { rubPerEuro: 90, date: '01.10.2026' },
    downloadPhoto: async () => { calls += 1; return Buffer.from([]); } });
  assert.equal(calls, 0);
  assert.equal(result.document.models[0].price, 657);
  assert.equal(result.document.models[0].scale, '1:1');
  assert.equal(result.document.categories[0].name, 'Аксессуары');
  assert.match(result.document.models[0].notes, /Личное фото отсутствовало/);
});

test('conversion accepts validated corrections, requires CAPTCHA and rejects edited data without a ZIP', async () => {
  let verifications = 0;
  const app = createApp({ env: {}, captcha: { publicConfig: () => ({ configured: true }),
    verify: async ({ token }) => {
      verifications += 1;
      if (token !== 'test-token') throw new CaptchaError('Пройдите проверку', 403);
    } } });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const name of ['review', 'mapping']) {
      const response = await fetch(`${base}/transfer/${name}.js`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /javascript/);
    }
    const form = new FormData();
    form.append('file', new Blob(['Название,Цена,Дата покупки\nМодель,7.30,2026-02-30']), 'collection.csv');
    form.append('mapping', JSON.stringify({ name: 'Название', price: 'Цена', purchaseDate: 'Дата покупки' }));
    form.append('options', JSON.stringify(options));
    form.append('edits', JSON.stringify([{ rowIndex: 0, values: { name: 'Проверенная модель', purchaseDate: '2026-09-01' } }]));
    const denied = await fetch(`${base}/api/convert`, { method: 'POST', body: form });
    assert.equal(denied.status, 403);
    form.append('captchaToken', 'test-token');
    const valid = await fetch(`${base}/api/convert`, { method: 'POST', body: form });
    assert.equal(valid.status, 200);
    const files = unzipSync(new Uint8Array(await valid.arrayBuffer()));
    const document = JSON.parse(new TextDecoder().decode(files['collection.json']));
    assert.equal(document.models[0].name, 'Проверенная модель');
    assert.equal(document.models[0].purchaseDate, '2026-09-01');
    for (const edits of [[{ rowIndex: 0, values: { purchaseDate: '2026-02-30' } }],
      [{ rowIndex: 0, values: { sourceRow: '9' } }], { rows: [] }]) {
      form.set('edits', JSON.stringify(edits));
      const response = await fetch(`${base}/api/convert`, { method: 'POST', body: form });
      assert.equal(response.status, 400);
      assert.match(response.headers.get('content-type'), /json/);
    }
    assert.equal(verifications, 5);
  } finally {
    app.locals.closeJobs();
    await new Promise((resolve) => server.close(resolve));
  }
});
