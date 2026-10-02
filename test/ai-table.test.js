import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { prepareSource, createRecognitionWorker } from '../src/jobs/recognize.js';
import { createAiService } from '../src/ai/service.js';
import { recognizeCollectionRecords } from '../src/ai/groq.js';
import { createJobStore } from '../src/jobs/store.js';
import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';

// Invented records: do not copy collections, photo URLs or API responses into fixtures.
const rows = [
  { Brand: 'Example Maker', 'Model Name': 'Test Car, "A"', 'Price Paid (EUR)': '',
    'Estimated Value (EUR)': '99.00', 'Date Added': '2026-10-01', Notes: 'First line\nSecond line', Extra: '' },
  { Brand: 'Example Maker', 'Model Name': 'Test Car, "A"', 'Price Paid (EUR)': '10.00',
    'Estimated Value (EUR)': '', 'Date Added': '2026-10-01', Notes: '', Extra: 'Unmapped value' },
];
const response = (value) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
  message: { content: JSON.stringify(value) } }] }));
const item = (id, name = 'Test Car') => ({ name, brand: 'Example Maker', scale: '', category: '',
  price: '', purchaseDate: '', notes: '', photoUrl: '', tags: [], sourceIds: [id], currency: 'UNKNOWN' });

async function source(extension) {
  const headers = Object.keys(rows[0]);
  if (extension === 'json') return { filename: 'test.json', bytes: Buffer.from(JSON.stringify(rows)) };
  if (extension === 'csv') {
    const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
    return { filename: 'test.csv', bytes: Buffer.from([headers.map(quote).join(','),
      ...rows.map((row) => headers.map((header) => quote(row[header])).join(','))].join('\r\n')) };
  }
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Models');
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(headers.map((header) => row[header])));
  return { filename: 'test.xlsx', bytes: Buffer.from(await workbook.xlsx.writeBuffer()) };
}

for (const extension of ['csv', 'xlsx', 'json']) {
  test(`${extension} reaches the AI as named cells with stable row IDs and no binary upload`, async () => {
    const account = { id: 'test', owner: 'Tester', label: 'Test', apiKey: 'test-key' };
    let calls = 0;
    const ai = createAiService({ store: { getEnabledAccounts: async () => [account] }, fetchImpl: async (_url, options) => {
      calls += 1;
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'openai/gpt-oss-120b');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.equal(typeof body.messages[1].content, 'string');
      const input = JSON.parse(body.messages[1].content);
      assert.equal(input.sourceFormat, 'table');
      assert.deepEqual(input.records, rows.map((fields, index) => ({ id: index + 1, fields })));
      assert.equal(body.file, undefined);
      assert.equal(body.files, undefined);
      return response({ models: input.records.map(({ id, fields }) => item(id, fields['Model Name'])),
        warnings: [], unassigned: [] });
    } });
    const result = await createRecognitionWorker(ai)({ source: await source(extension),
      route: await ai.approve({ accountId: account.id }), signal: new AbortController().signal, progress() {} });
    assert.equal(calls, 1);
    assert.equal(result.models.length, 2);
    assert.deepEqual(result.audit.modelSources.map((model) => model.sourceIds), [[1], [2]]);
    assert.equal(result.audit.sourceCount, 2);
    assert.equal(result.audit.assignedCount, 2);
  });
}

test('free text remains text, with source IDs and section context', async () => {
  const prepared = await prepareSource({ filename: 'test.txt', bytes: Buffer.from('Example Maker\n\nTest Car') });
  const result = await recognizeCollectionRecords({ records: prepared.records, sourceFormat: prepared.sourceFormat,
    context: 'Previous section', apiKey: 'test-key', fetchImpl: async (_url, options) => {
      const input = JSON.parse(JSON.parse(options.body).messages[1].content);
      assert.equal(input.sourceFormat, 'text');
      assert.equal(input.context, 'Previous section');
      assert.deepEqual(input.records, [{ id: 1, text: 'Example Maker' }, { id: 3, text: 'Test Car' }]);
      return response({ models: [item(3)], unassigned: [{ sourceId: 1, kind: 'section', reason: 'Brand heading' }], warnings: [] });
    } });
  assert.deepEqual(result.models[0].sourceIds, [3]);
});

test('a table row cannot disappear or be assigned twice despite valid field extraction', async () => {
  const prepared = await prepareSource(await source('csv'));
  const run = (models) => recognizeCollectionRecords({ records: prepared.records, sourceFormat: prepared.sourceFormat,
    apiKey: 'test-key', fetchImpl: async () => response({ models, warnings: [], unassigned: [] }) });
  await assert.rejects(run([item(1)]), /пропустил/);
  await assert.rejects(run([item(1), item(1)]), /повторную/);
  await assert.rejects(run([{ ...item(1), sourceIds: [1, 2] }]), /объединил разные строки таблицы/);
});

test('zero models distinguishes AI classification from file loading and clears private content', async (t) => {
  const worker = createRecognitionWorker({ run: async ({ records }) => ({ models: [], warnings: ['PRIVATE_AI_WARNING'],
    unassigned: records.map(({ id }, index) => ({ sourceId: id, kind: index ? 'other' : 'section', reason: 'PRIVATE_AI_REASON' })) }) });
  const jobs = createJobStore({ run: worker });
  t.after(() => jobs.close());
  const job = jobs.create({ owner: 'test', requestId: randomUUID(), fingerprint: 'test', route: {},
    source: { filename: 'test.csv', bytes: Buffer.from('Model Name\nPRIVATE_MODEL_ONE\nPRIVATE_MODEL_TWO') } });
  for (let attempt = 0; attempt < 100 && jobs.get('test', job.id).status !== 'failed'; attempt += 1) await nextTurn();
  const failed = jobs.get('test', job.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Исходник прочитан: 2/);
  assert.match(failed.error, /к заголовкам 1, к неясным записям 1/);
  assert.match(failed.error, /не ошибка загрузки файла/);
  assert.doesNotMatch(JSON.stringify(jobs.list('test')), /PRIVATE_/);
  assert.throws(() => jobs.result('test', job.id), /удалён/);
});

test('merged spreadsheet headings stay in audit and context follows each row across chunks', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Test');
  sheet.addRow(['Number', 'Model Name', 'Year', 'Price']);
  sheet.addRow(['Example Section A']); sheet.mergeCells('A2:D2');
  for (let index = 1; index <= 16; index += 1) sheet.addRow([index, `Invented item ${index}`, '2020', '5']);
  sheet.addRow(['Example Section B']); sheet.mergeCells('A19:D19');
  sheet.addRow([17, 'Invented figure', '', '']);
  const prepared = await prepareSource({ filename: 'example.xlsx', bytes: Buffer.from(await workbook.xlsx.writeBuffer()) });
  assert.equal(prepared.records[0].sectionLabel, 'Example Section A');
  assert.equal(prepared.records[17].sectionLabel, 'Example Section B');
  let calls = 0;
  const worker = createRecognitionWorker({ run: async ({ records, sourceFormat }) => {
    calls += 1;
    return recognizeCollectionRecords({ records, sourceFormat, apiKey: 'test-key', fetchImpl: async (_url, options) => {
      const input = JSON.parse(JSON.parse(options.body).messages[1].content);
      assert.ok(input.records.every(({ id }) => ![1, 18].includes(id)));
      for (const record of input.records) assert.equal(record.sectionContext, record.id < 18 ? 'Example Section A' : 'Example Section B');
      return response({ models: input.records.map(({ id }) => item(id)), warnings: [], unassigned: [] });
    } });
  } });
  const result = await worker({ source: { prepared }, route: {}, signal: new AbortController().signal, progress() {} });
  assert.equal(calls, 2);
  assert.equal(result.models.length, 17);
  assert.equal(result.audit.sourceCount, 19);
  assert.equal(result.audit.assignedCount, 17);
  assert.deepEqual(result.audit.unassigned.map(({ sourceId, kind }) => ({ sourceId, kind })),
    [{ sourceId: 1, kind: 'section' }, { sourceId: 18, kind: 'section' }]);
  assert.ok(!result.warnings.some((warning) => warning.includes('на границах частей')));
});

test('repeated full-width headings are recognized but sparse and partial rows are not discarded', async () => {
  const rows = [{ Number: 'Example group', Name: 'Example group', Price: 'Example group' },
    { Number: '', Name: 'Only named item', Price: '' }, { Number: 'Same', Name: 'Same', Price: '5' }];
  const prepared = await prepareSource({ filename: 'example.json', bytes: Buffer.from(JSON.stringify(rows)) });
  assert.equal(prepared.records[0].sectionLabel, 'Example group');
  assert.ok(prepared.records.slice(1).every((record) => !record.sectionLabel));
  assert.ok(prepared.records.slice(1).every((record) => record.sectionContext === 'Example group'));
});

test('heading-only input retains source coverage without sending an empty request to AI', async () => {
  let calls = 0;
  const worker = createRecognitionWorker({ run() { calls += 1; throw new Error('Must not send'); } });
  await assert.rejects(worker({ source: { filename: 'example.json', bytes: Buffer.from(JSON.stringify([
    { Number: 'Invented heading', Name: 'Invented heading', Price: 'Invented heading' },
  ])) }, route: {}, signal: new AbortController().signal, progress() {} }), /к заголовкам 1/);
  assert.equal(calls, 0);
});

test('inferred manufacturer and category get review notes and numeric brand is rejected', async () => {
  const records = [1, 2, 3].map((id) => ({ id, text: `Invented item ${id}` }));
  const result = await recognizeCollectionRecords({ records, apiKey: 'test-key', fetchImpl: async () => response({
    models: [{ ...item(1), brandBasis: 'inferred', category: 'Фигурки', categoryBasis: 'inferred', tags: ['2020 г.', 'Example series'] },
      { ...item(2), brand: '1990`', brandBasis: 'explicit', categoryBasis: 'unknown' },
      { ...item(3), brandBasis: 'explicit', categoryBasis: 'unknown' }], warnings: [], unassigned: [],
  }) });
  assert.match(result.models[0].notes, /ИИ предположил: производитель/);
  assert.match(result.models[0].notes, /ИИ предположил: категория/);
  assert.deepEqual(result.models[0].tags, ['2020 г.', 'Example series']);
  assert.equal(result.models[1].brand, '');
  assert.match(result.models[1].notes, /1990`/);
  assert.equal(result.models[2].notes, '');
  assert.equal(result.warnings.length, 3);
});

test('invalid inferred dates and prices stay in notes instead of silently becoming source facts', async () => {
  const result = await recognizeCollectionRecords({ records: [{ id: 1, text: 'Invented item' }], apiKey: 'test-key',
    fetchImpl: async () => response({ models: [{ ...item(1), brand: '', brandBasis: 'unknown', categoryBasis: 'unknown',
      purchaseDate: '2025-02-30', price: 'unknown price' }], unassigned: [], warnings: [] }) });
  assert.equal(result.models[0].purchaseDate, ''); assert.equal(result.models[0].price, '');
  assert.match(result.models[0].notes, /2025-02-30/); assert.match(result.models[0].notes, /unknown price/);
  assert.equal(result.warnings.length, 2);
});
