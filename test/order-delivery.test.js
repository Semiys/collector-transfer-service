import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { createOrderStore, newOrderAccessToken } from '../src/orders/store.js';
import { createOrderJobLifecycle } from '../src/orders/processing.js';
import { createOrderDelivery } from '../src/orders/delivery.js';
import { createJobStore } from '../src/jobs/store.js';
import { buildArchive } from '../src/transfer/build-archive.js';
import { createArchiveCapacity } from '../src/transfer/archive-capacity.js';
import { placeholderPhoto } from '../src/transfer/photos.js';

const photoUrl = 'https://juegmurcnhnfnvsqsqxn.supabase.co/storage/v1/object/public/collection-photos/test.jpg';
const rejects = (promise, status) => assert.rejects(promise, (error) => error.statusCode === status && !error.message.includes('PRIVATE_ERROR'));
async function waitFor(check) {
  for (let i = 0; i < 400; i += 1) { if (await check()) return; await delay(5); }
  assert.fail('Transition did not finish');
}
function recognition(photo = false) {
  return { transferSource: 'openrouter-ai-v1', priceCurrency: 'RUB', warnings: [],
    models: Array.from({ length: 2 }, () => ({ name: 'PRIVATE SAME CAR', brand: 'Hot Wheels', category: 'Автомобили',
      scale: '', price: '10', purchaseDate: '', notes: '', photoUrl: photo ? photoUrl : '', tags: ['Год выпуска: 1969'] })),
    audit: { sourceCount: 2, assignedCount: 2, numbering: 'Строки источника', unassigned: [],
      modelSources: [1, 2].map((n) => ({ model: n, name: 'PRIVATE SAME CAR', sourceIds: [n] })) },
    diagnostics: [{ keyUsed: 'PRIVATE_KEY_DIAGNOSTICS' }] };
}
async function fixture(t, { build, getRate, photo = false, unblock, paid = true, complete } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'collector-order-delivery-'));
  let time = 1000, aiCalls = 0;
  const orders = createOrderStore({ dataDir });
  const proxy = { ...orders, ...(complete ? { completeAttempt: (input) => complete(input, orders) } : {}) };
  const jobs = createJobStore({ run: async () => { aiCalls += 1; return recognition(photo); },
    now: () => time, resultTtlMs: 1000, metadataTtlMs: 100, ...createOrderJobLifecycle(proxy) });
  const capacity = createArchiveCapacity({ maxActive: 1 });
  const delivery = createOrderDelivery({ orders: proxy, jobs, capacity, now: () => time, build, getRate });
  const accessToken = newOrderAccessToken(), order = await orders.create({ accessToken, requestId: randomUUID() });
  if (paid) {
    await orders.bindPayment({ id: order.id, provider: 'test', paymentId: 'fake-payment' });
    await orders.confirmPayment({ id: order.id, provider: 'test', paymentId: 'fake-payment', amountMinor: 14900, currency: 'RUB' });
  }
  let job;
  if (paid) {
    const run = await orders.beginAttempt({ id: order.id, accessToken, requestId: randomUUID() });
    job = jobs.create({ owner: `order:${order.id}`, requestId: randomUUID(), fingerprint: 'fake-source-fingerprint',
      source: { filename: 'PRIVATE_SOURCE.txt', bytes: Buffer.from('PRIVATE SAME CAR\nPRIVATE SAME CAR') },
      binding: { id: order.id, runId: run.runId } });
    await waitFor(() => jobs.get(`order:${order.id}`, job.id).status === 'ready');
  }
  const identity = { id: order.id, accessToken, jobId: job?.id ?? randomUUID() };
  const f = { dataDir, orders, proxy, jobs, delivery, capacity, identity, aiCalls: () => aiCalls,
    advance: (value) => { time += value; jobs.sweep(); }, state: () => orders.get({ id: order.id, accessToken }),
    input: (changes = {}) => ({ ...identity, requestId: randomUUID(), confirmedAudit: true, confirmedModels: true,
      options: { priceCurrency: 'RUB', defaultScale: '1:64', transferDate: '2026-10-02', acceptTextWarnings: true }, edits: [], ...changes }) };
  f.close = async () => { await delivery.close(); await jobs.close(); await orders.close(); };
  t.after(async () => { unblock?.(); await f.close(); await rm(dataDir, { recursive: true, force: true }); });
  return f;
}
const documentOf = (archive) => JSON.parse(strFromU8(unzipSync(archive)['collection.json']));

test('paid preview uses the owned server result, copies audit and omits provider diagnostics', async (t) => {
  const unpaid = await fixture(t, { paid: false });
  await rejects(unpaid.delivery.preview(unpaid.identity), 402);
  const f = await fixture(t);
  await rejects(f.delivery.preview({ ...f.identity, accessToken: newOrderAccessToken() }), 404);
  const preview = await f.delivery.preview(f.identity);
  assert.equal(preview.rows.length, 2); assert.equal(preview.priceCurrency, 'RUB');
  assert.equal(preview.audit.assignedCount, 2); assert.ok(!JSON.stringify(preview).includes('PRIVATE_KEY'));
  preview.rows[1].name = 'Changed by browser'; preview.audit.modelSources[1].sourceIds.push(99);
  const again = await f.delivery.preview(f.identity);
  assert.equal(again.rows[1].name, 'PRIVATE SAME CAR'); assert.deepEqual(again.audit.modelSources[1].sourceIds, [2]);
  const other = await fixture(t);
  await rejects(f.delivery.preview({ ...f.identity, jobId: other.identity.jobId }), 404);
  assert.equal((await f.state()).attempts, 1);
});

test('reviewed corrections reach a real ZIP, completion requires separate explicit save confirmation', async (t) => {
  const f = await fixture(t);
  const input = f.input({ edits: [{ rowIndex: 1, values: { name: 'PRIVATE CORRECTED CAR', price: '7,30',
    purchaseDate: '2024-02-29', tags: '["Premium","Год выпуска: 1969"]' } }] });
  await rejects(f.delivery.confirmSaved({ ...f.identity, receipt: 'none', downloadSaved: true }), 409);
  const built = await f.delivery.build(input), document = documentOf(built.archive);
  assert.equal(document.models.length, 2); assert.equal(document.models[0].name, 'PRIVATE SAME CAR');
  assert.equal(document.models[1].name, 'PRIVATE CORRECTED CAR'); assert.equal(document.models[1].price, 7.3);
  assert.equal(document.models[1].purchaseDate, '2024-02-29'); assert.equal(document.models[0].scale, '1:64');
  assert.equal(document.categories.length, 1); assert.equal(document.modelTags.length, 3);
  for (const model of document.models) assert.ok(unzipSync(built.archive)[model.photoEntry].length);
  assert.equal(built.orderCompleted, false); assert.equal((await f.state()).processingState, 'ready');
  assert.equal((await f.delivery.preview(f.identity)).rows[1].name, 'PRIVATE SAME CAR');
  await rejects(f.delivery.confirmSaved({ ...f.identity, receipt: built.receipt, downloadSaved: false }), 400);
  await rejects(f.delivery.confirmSaved({ ...f.identity, receipt: 'wrong', downloadSaved: true }), 409);
  const confirms = await Promise.all(Array.from({ length: 5 }, () => f.delivery.confirmSaved({ ...f.identity,
    receipt: built.receipt, downloadSaved: true })));
  assert.ok(confirms.every((item) => item.order.processingState === 'completed'));
  assert.equal(f.jobs.get(`order:${f.identity.id}`, f.identity.jobId).status, 'consumed');
  await rejects(f.delivery.build(input), 409); await rejects(f.delivery.preview(f.identity), 409);
  assert.equal((await f.state()).attempts, 1); assert.equal(f.aiCalls(), 1);
  const disk = await readFile(path.join(f.dataDir, 'orders.json'), 'utf8');
  for (const privateValue of ['PRIVATE', built.receipt, f.identity.accessToken, 'photos/', 'Premium']) assert.ok(!disk.includes(privateValue));
  assert.deepEqual(await readdir(f.dataDir), ['orders.json']);
});

test('unconfirmed, forged or invalid changes fail before photo network or completion', async (t) => {
  let builds = 0;
  const f = await fixture(t, { photo: true, build: async () => { builds += 1; throw new Error('PRIVATE_ERROR'); } });
  for (const changes of [{ confirmedAudit: false }, { confirmedModels: false }, { models: [] },
    { edits: [{ rowIndex: 9, values: { name: 'forged' } }] }, { edits: [{ rowIndex: 0, values: { scale: 'vv:1:35' } }] },
    { edits: [{ rowIndex: 0, values: { purchaseDate: '2026-02-30' } }] },
    { options: { priceCurrency: 'UNKNOWN', acceptTextWarnings: true } }]) {
    await rejects(f.delivery.build(f.input(changes)), 400);
  }
  await rejects(f.delivery.build(f.input({ jobId: randomUUID() })), 404);
  assert.equal(builds, 0); assert.equal((await f.state()).processingState, 'ready'); assert.equal(f.aiCalls(), 1);
  assert.throws(() => f.jobs.consume(`order:${f.identity.id}`, f.identity.jobId), (error) => error.statusCode === 409);
});

test('double ZIP clicks share one build; retry rebuilds without AI and changed payload needs a new request', async (t) => {
  let finish, builds = 0;
  const gate = new Promise((resolve) => { finish = resolve; });
  const f = await fixture(t, { unblock: finish, build: async (input) => { builds += 1; await gate; return buildArchive(input); } });
  const input = f.input();
  const pending = Array.from({ length: 8 }, () => f.delivery.build(input));
  await waitFor(() => builds === 1);
  await rejects(f.delivery.build(f.input()), 409);
  finish(); const archives = await Promise.all(pending);
  assert.equal(builds, 1); assert.ok(archives.every((item) => item.archive === archives[0].archive));
  assert.ok(archives.every((item) => item.receipt === archives[0].receipt));
  const repeat = await f.delivery.build(input); assert.equal(builds, 2); assert.equal(repeat.receipt, archives[0].receipt);
  assert.equal(f.aiCalls(), 1); assert.equal((await f.state()).attempts, 1);
  const edits = [{ rowIndex: 0, values: { name: 'New correction' } }];
  await rejects(f.delivery.build({ ...input, edits }), 409);
  const revised = await f.delivery.build(f.input({ edits }));
  assert.notEqual(revised.receipt, repeat.receipt);
  assert.equal(documentOf(revised.archive).models[0].name, 'New correction');
  await rejects(f.delivery.confirmSaved({ ...f.identity, receipt: repeat.receipt, downloadSaved: true }), 409);
});

test('EUR quote is verified before ZIP and changed or unavailable rate never completes an order', async (t) => {
  let rate = { date: '02.10.2026', rubPerEuro: 101 }, builds = 0;
  const f = await fixture(t, { getRate: async () => { if (!rate) throw new Error('PRIVATE_ERROR'); return rate; },
    build: (input) => { builds += 1; return buildArchive(input); } });
  const input = f.input({ options: { priceCurrency: 'EUR', transferDate: '2026-10-02', acceptTextWarnings: true, expectedRateDate: '01.10.2026' } });
  await rejects(f.delivery.build(input), 409); assert.equal(builds, 0);
  rate = null; await rejects(f.delivery.build(input), 503); assert.equal(builds, 0);
  rate = { date: '02.10.2026', rubPerEuro: 101 };
  const built = await f.delivery.build({ ...input, options: { ...input.options, expectedRateDate: rate.date } });
  assert.equal(documentOf(built.archive).models[0].price, 1010);
  assert.match(documentOf(built.archive).models[0].notes, /02\.10\.2026/);
  assert.equal((await f.state()).processingState, 'ready'); assert.equal(f.aiCalls(), 1);
});

test('expiry aborts ZIP photo work and blocks a paid retry until the actual builder stops', async (t) => {
  let finish, photoCalls = 0, signal;
  const gate = new Promise((resolve) => { finish = resolve; });
  const f = await fixture(t, { photo: true, unblock: finish, build: (input) => buildArchive({ ...input,
    downloadPhoto: async (_url, options) => { photoCalls += 1; signal = options.signal; await gate; return placeholderPhoto(); } }) });
  const building = f.delivery.build(f.input());
  const failed = rejects(building, 409);
  await waitFor(() => !!signal); f.advance(1001);
  assert.equal(signal.aborted, true); assert.equal((await f.state()).canRetry, false);
  await rejects(f.orders.beginAttempt({ id: f.identity.id, accessToken: f.identity.accessToken, requestId: randomUUID() }), 409);
  await rejects(f.capacity.run(async () => 'should not run'), 503);
  finish(); await failed;
  await waitFor(async () => (await f.state()).canRetry);
  assert.equal(photoCalls, 1); assert.equal((await f.state()).failureCode, 'result_lost');
  assert.equal(await f.capacity.run(async () => 'slot released'), 'slot released');
});

test('cancellation stops ZIP without replacing an aborted photo with a placeholder', async (t) => {
  let finish, photoCalls = 0;
  const gate = new Promise((resolve) => { finish = resolve; });
  const f = await fixture(t, { photo: true, unblock: finish, build: (input) => buildArchive({ ...input,
    downloadPhoto: async () => { photoCalls += 1; await gate; throw new Error('download failed'); } }) });
  const building = f.delivery.build(f.input()), failed = rejects(building, 409);
  await waitFor(() => photoCalls === 1);
  f.jobs.cancel(`order:${f.identity.id}`, f.identity.jobId);
  assert.equal((await f.state()).canRetry, false); finish(); await failed;
  await waitFor(async () => (await f.state()).canRetry);
  assert.equal((await f.state()).failureCode, 'cancelled'); assert.equal(photoCalls, 1);
});

test('failed completion write retains the result and receipt for a safe confirmation retry', async (t) => {
  let fail = true;
  const f = await fixture(t, { complete: async (input, store) => { if (fail) throw new Error('PRIVATE_ERROR disk path'); return store.completeAttempt(input); } });
  const built = await f.delivery.build(f.input()), ack = { ...f.identity, receipt: built.receipt, downloadSaved: true };
  await rejects(f.delivery.confirmSaved(ack), 503);
  assert.equal((await f.state()).processingState, 'ready'); assert.equal((await f.delivery.preview(f.identity)).rows.length, 2);
  fail = false; assert.equal((await f.delivery.confirmSaved(ack)).order.processingState, 'completed');
});

test('confirmation accepted before expiry cannot race cancellation or another ZIP during its durable write', async (t) => {
  let finish, entered = false;
  const gate = new Promise((resolve) => { finish = resolve; });
  const f = await fixture(t, { unblock: finish, complete: async (input, store) => { entered = true; await gate; return store.completeAttempt(input); } });
  const built = await f.delivery.build(f.input());
  const confirming = f.delivery.confirmSaved({ ...f.identity, receipt: built.receipt, downloadSaved: true });
  await waitFor(() => entered); f.advance(1001);
  assert.throws(() => f.jobs.cancel(`order:${f.identity.id}`, f.identity.jobId), (error) => error.statusCode === 409);
  await rejects(f.delivery.build(f.input()), 409);
  finish(); assert.equal((await confirming).order.processingState, 'completed');
  assert.equal(f.jobs.get(`order:${f.identity.id}`, f.identity.jobId).status, 'consumed');
});

test('shutdown waits for ZIP unwind; restart retains payment but never recovers ZIP or its RAM receipt', async (t) => {
  let finish, entered = false;
  const gate = new Promise((resolve) => { finish = resolve; });
  const f = await fixture(t, { unblock: finish, build: async (input) => { entered = true; await gate; input.signal.throwIfAborted(); return buildArchive(input); } });
  const building = f.delivery.build(f.input()), failed = rejects(building, 503);
  await waitFor(() => entered);
  let closed = false;
  const closing = f.close().then(() => { closed = true; });
  await delay(10); assert.equal(closed, false); finish(); await failed; await closing;
  const orders = createOrderStore({ dataDir: f.dataDir });
  const jobs = createJobStore({ run: async () => { throw new Error('Should not run'); }, ...createOrderJobLifecycle(orders) });
  const delivery = createOrderDelivery({ orders, jobs });
  try {
    const state = await orders.get({ id: f.identity.id, accessToken: f.identity.accessToken });
    assert.equal(state.paymentState, 'paid'); assert.equal(state.canRetry, true);
    await rejects(delivery.preview(f.identity), 409);
    await rejects(delivery.confirmSaved({ ...f.identity, receipt: 'lost', downloadSaved: true }), 409);
    assert.deepEqual(await readdir(f.dataDir), ['orders.json']);
  } finally { await delivery.close(); await jobs.close(); await orders.close(); }
});
