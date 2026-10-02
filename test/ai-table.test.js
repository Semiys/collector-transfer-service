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
