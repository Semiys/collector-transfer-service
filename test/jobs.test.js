import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createJobStore, JobError } from '../src/jobs/store.js';
import { prepareSource, createRecognitionWorker } from '../src/jobs/recognize.js';
import { recognizeCollectionRecords } from '../src/ai/openrouter.js';
import { createAiService } from '../src/ai/service.js';
import { parseInput } from '../src/transfer/parse-input.js';
import { buildArchive } from '../src/transfer/build-archive.js';
import { suggestMapping } from '../src/transfer/mapping.js';
import { unzipSync } from 'fflate';

const source = (text) => ({ filename: 'collection.txt', bytes: Buffer.from(text) });
const model = (id = 1, name = 'Corvette') => ({ name, brand: 'Hot Wheels', scale: '', category: 'Автомобили',
  price: '10', purchaseDate: '', notes: '', photoUrl: '', tags: [], sourceIds: [id], currency: 'EUR' });
const upstream = (value) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { status: 200 });
const create = (jobs, values = {}) => jobs.create({ owner: 'a', requestId: randomUUID(), fingerprint: 'one', source: source('private original'), route: {}, ...values });
async function status(jobs, id, expected) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (jobs.get('a', id).status === expected) return;
    await nextTurn();
  }
  assert.equal(jobs.get('a', id).status, expected);
}

test('jobs deduplicate retries, scope owners and consume private results', async (t) => {
  let calls = 0;
  const jobs = createJobStore({ run: async () => { calls += 1; return { private: 'result content' }; } });
  t.after(() => jobs.close());
  const requestId = randomUUID();
  const first = create(jobs, { requestId });
  assert.equal(create(jobs, { requestId }).id, first.id);
  assert.throws(() => create(jobs, { requestId, fingerprint: 'different' }), (error) => error.statusCode === 409);
  assert.throws(() => jobs.get('b', first.id), (error) => error.statusCode === 404);
  assert.deepEqual(jobs.list('b'), []);
  await status(jobs, first.id, 'ready');
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(jobs.list('a')).includes('private'), false);
  assert.deepEqual(jobs.result('a', first.id), { private: 'result content' });
  jobs.consume('a', first.id);
  assert.throws(() => jobs.result('a', first.id), /удалён/);
  assert.equal(create(jobs, { requestId }).status, 'consumed');
  assert.equal(calls, 1);
});

test('cancelled worker keeps its slot until unwind; queued cancellation never calls AI', async (t) => {
  let finish, calls = 0, signal;
  const jobs = createJobStore({ maxJobs: 2, run: async (options) => {
    calls += 1; signal = options.signal;
    await new Promise((resolve) => { finish = resolve; }); return {};
  } });
  t.after(() => jobs.close());
  const first = create(jobs); await nextTurn();
  const second = create(jobs);
  jobs.cancel('a', second.id); jobs.cancel('a', first.id);
  assert.equal(signal.aborted, true);
  const third = create(jobs);
  assert.throws(() => create(jobs), (error) => error.statusCode === 503);
  await nextTurn(); assert.equal(calls, 1);
  finish(); await nextTurn();
  assert.equal(calls, 2);
  jobs.cancel('a', third.id); finish(); await nextTurn();
  assert.equal(jobs.get('a', first.id).status, 'cancelled');
  assert.throws(() => jobs.result('a', first.id), /удалён/);
});

test('expiry clears results, aborts overdue work and eventually removes metadata', async (t) => {
  let time = 100, finish, signal;
  const jobs = createJobStore({ now: () => time, workTtlMs: 100, resultTtlMs: 50, metadataTtlMs: 10,
    run: async ({ signal: current }) => { signal = current; await new Promise((resolve) => { finish = resolve; }); return { private: true }; } });
  t.after(() => jobs.close());
  const first = create(jobs); await nextTurn();
  time = 201; jobs.sweep();
  assert.equal(signal.aborted, true); assert.equal(jobs.get('a', first.id).status, 'expired');
  finish(); await nextTurn(); time = 212; jobs.sweep();
  assert.throws(() => jobs.get('a', first.id), (error) => error.statusCode === 404);
  const second = create(jobs); await nextTurn(); finish(); await status(jobs, second.id, 'ready');
  time += 51; assert.throws(() => jobs.result('a', second.id), /удалён/);
  assert.equal(jobs.get('a', second.id).status, 'expired');
});

test('failure clears partial results and never exposes unexpected error content', async (t) => {
  const jobs = createJobStore({ run: async () => { throw new Error('private source or provider stack'); } });
  t.after(() => jobs.close());
  const first = create(jobs); await status(jobs, first.id, 'failed');
  assert.equal(JSON.stringify(jobs.list('a')).includes('private'), false);
  assert.throws(() => jobs.result('a', first.id), /удалён/);
  assert.throws(() => jobs.consume('a', first.id), (error) => error.statusCode === 409);
});

test('source splits table rows and text lines with stable IDs and rejects excess before AI', async () => {
  const prepared = await prepareSource(source('Заголовок\n\n' + Array.from({ length: 16 }, (_, index) => `Модель ${index}`).join('\n')));
  assert.equal(prepared.chunks.length, 2);
  assert.equal(prepared.records[1].id, 3);
  const table = await prepareSource({ filename: 'models.csv', bytes: Buffer.from('Name,Brand\nCorvette,Hot Wheels\n') });
  assert.deepEqual(JSON.parse(table.records[0].text), { Name: 'Corvette', Brand: 'Hot Wheels' });
  await assert.rejects(prepareSource(source(Array.from({ length: 301 }, () => 'Модель').join('\n'))), /300/);
  await assert.rejects(prepareSource(source('A'.repeat(8001))), /8 000/);
});

test('AI coverage rejects missing, repeated and invented source IDs', async () => {
  const records = [{ id: 1, text: 'Hot Wheels' }, { id: 2, text: 'Corvette 10 EUR' }];
  const valid = { models: [model(2)], warnings: [], unassigned: [{ sourceId: 1, kind: 'section', reason: 'Бренд' }] };
  const parse = (value) => recognizeCollectionRecords({ records, apiKey: 'test-key', fetchImpl: async () => upstream(value) });
  const result = await parse(valid);
  assert.equal(result.models[0].sourceIds[0], 2);
  await assert.rejects(parse({ ...valid, unassigned: [] }), /пропустил/);
  await assert.rejects(parse({ ...valid, models: [model(1)] }), /повторную/);
  await assert.rejects(parse({ ...valid, models: [model(9)] }), /неизвестную/);
});

test('chunked recognition preserves duplicates, section context, coverage and EUR to ZIP path', async () => {
  const primary = { id: 'one', owner: 'Owner', label: 'Primary', apiKey: 'key' };
  const calls = [];
  const ai = createAiService({ store: { getEnabledAccounts: async () => [primary] }, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body), input = JSON.parse(body.messages[1].content); calls.push(input);
    return upstream({ models: input.records.filter((item) => item.id !== 1).map((item) => model(item.id, 'Same car')),
      warnings: [], unassigned: input.records.filter((item) => item.id === 1).map((item) => ({ sourceId: item.id, kind: 'section', reason: 'Бренд' })) });
  } });
  const route = await ai.approve({ accountId: primary.id });
  const progress = [];
  const result = await createRecognitionWorker(ai)({ source: source('Hot Wheels\n' + Array.from({ length: 16 }, () => 'Same car 10 EUR').join('\n')),
    route, signal: new AbortController().signal, progress: (value) => progress.push(value) });
  assert.equal(calls.length, 2); assert.match(calls[1].context, /Hot Wheels/);
  assert.equal(result.models.length, 16); assert.equal(result.priceCurrency, 'EUR');
  assert.equal(result.audit.assignedCount + result.audit.unassigned.length, 17);
  assert.equal(result.audit.modelSources[15].sourceIds[0], 17);
  assert.equal(progress.at(-1).completed, 2);
  const parsed = await parseInput('ai.json', Buffer.from(JSON.stringify(result)));
  assert.equal(parsed.priceCurrency, 'EUR');
  const output = await buildArchive({ parsed, mapping: suggestMapping(parsed.headers), eurRate: { rubPerEuro: 100, date: '2026-10-01' },
    options: { priceCurrency: 'EUR', transferDate: '2026-10-01', acceptTextWarnings: true } });
  const document = JSON.parse(Buffer.from(unzipSync(output.archive)['collection.json']).toString('utf8'));
  assert.equal(document.models.length, 16); assert.equal(document.models[0].price, 1000);
});

test('mixed currencies never become rubles silently and unknown currency remains selectable', async () => {
  const run = async (currencies) => createRecognitionWorker({ run: async ({ records }) => ({
    models: records.map((record, index) => ({ ...model(record.id), currency: currencies[index] })), warnings: [], unassigned: [],
    modelUsed: 'stub', keyUsed: { label: 'key', owner: 'owner' } }) })({ source: source('Car one\nCar two'), route: {},
    signal: new AbortController().signal, progress() {} });
  const mixed = await run(['RUB', 'EUR']);
  assert.equal(mixed.models[0].price, ''); assert.match(mixed.models[1].notes, /10; валюта: EUR/);
  const unknown = await run(['UNKNOWN', 'UNKNOWN']);
  assert.equal(unknown.priceCurrency, 'UNKNOWN'); assert.equal(unknown.models[0].price, '10');
});

test('AI service serializes requests, cancels waits and revalidates approved owners', async () => {
  let active = 0, maximum = 0, owner = 'Owner', finish;
  const ai = createAiService({ store: { getEnabledAccounts: async () => [{ id: 'one', owner, label: 'key', apiKey: 'key' }] },
    fetchImpl: async () => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise((resolve) => { finish = resolve; }); active -= 1;
      return upstream({ models: [model()], warnings: [] });
    } });
  const route = await ai.approve({ accountId: 'one' });
  const first = ai.run({ route, text: 'Corvette Hot Wheels' }); await nextTurn();
  const controller = new AbortController();
  const second = ai.run({ route, text: 'Corvette Hot Wheels', signal: controller.signal });
  controller.abort(); await assert.rejects(second, (error) => error.name === 'AbortError');
  owner = 'Changed owner'; finish(); await first;
  await assert.rejects(ai.run({ route, text: 'Corvette Hot Wheels' }), /Участники/);
  assert.equal(maximum, 1);
});
