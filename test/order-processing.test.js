import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createOrderStore, newOrderAccessToken } from '../src/orders/store.js';
import { createOrderProcessing, createOrderJobLifecycle } from '../src/orders/processing.js';
import { createJobStore } from '../src/jobs/store.js';
import { createRecognitionWorker } from '../src/jobs/recognize.js';
import { createAiService } from '../src/ai/service.js';

const recordsSource = (text = 'PRIVATE MODEL\nPRIVATE MODEL') => ({ filename: 'collection.txt', bytes: Buffer.from(text) });
const rejects = (promise, code) => assert.rejects(promise, (error) => error.statusCode === code);
async function waitFor(check) {
  for (let i = 0; i < 400; i += 1) { if (await check()) return; await delay(5); }
  assert.fail('State transition did not finish');
}
async function fixture(t, { fetchImpl, jobOptions, hooks, unblock, dataDir: suppliedDir } = {}) {
  const dataDir = suppliedDir ?? await mkdtemp(path.join(tmpdir(), 'collector-order-processing-'));
  const orders = createOrderStore({ dataDir });
  let calls = 0;
  const upstream = async (_url, options) => {
    calls += 1;
    if (fetchImpl) return fetchImpl(_url, options);
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    const models = input.records.map((record) => ({ name: record.text, brand: 'Hot Wheels', category: 'Автомобили',
      scale: '', price: '', purchaseDate: '', notes: '', photoUrl: '', tags: [], currency: 'RUB', sourceIds: [record.id] }));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ models, warnings: [], unassigned: [] }) } }] }));
  };
  const accounts = [{ id: 'primary', owner: 'Owner', label: 'Test key', apiKey: 'fake-not-sent-to-provider' }];
  const aiService = createAiService({ store: { getEnabledAccounts: async () => accounts }, fetchImpl: upstream });
  const jobs = createJobStore({ run: createRecognitionWorker(aiService), ...createOrderJobLifecycle(orders), ...hooks, ...jobOptions });
  const processing = createOrderProcessing({ orders, jobs, aiService });
  const accessToken = newOrderAccessToken(), order = await orders.create({ requestId: randomUUID(), accessToken });
  const f = { dataDir, orders, jobs, processing, id: order.id, accessToken, calls: () => calls };
  f.payment = { id: f.id, provider: 'test', paymentId: randomUUID(), amountMinor: 14900, currency: 'RUB' };
  f.pay = async () => {
    await orders.bindPayment({ id: f.id, provider: 'test', paymentId: f.payment.paymentId });
    await orders.confirmPayment(f.payment);
  };
  f.input = (changes = {}) => ({ id: f.id, accessToken, requestId: randomUUID(), consentToAI: true,
    accountId: 'primary', source: recordsSource(), ...changes });
  f.state = () => orders.get({ id: f.id, accessToken });
  f.close = async () => { await processing.close(); await jobs.close(); await orders.close(); };
  t.after(async () => { unblock?.(); await f.close(); if (!suppliedDir) await rm(dataDir, { recursive: true, force: true }); });
  return f;
}

test('unpaid, missing consent and invalid source never consume attempts or call AI', async (t) => {
  const f = await fixture(t);
  await rejects(f.processing.start(f.input()), 402); await f.pay();
  await rejects(f.processing.start(f.input({ consentToAI: false })), 400);
  await rejects(f.processing.start(f.input({ source: { filename: 'bad.zip', bytes: Buffer.from('data') } })), 400);
  await rejects(f.processing.start(f.input({ source: recordsSource('X'.repeat(8001)) })), 400);
  await rejects(f.processing.start(f.input({ source: recordsSource(Array.from({ length: 301 }, () => 'Car').join('\n')) })), 400);
  assert.equal((await f.state()).attempts, 0); assert.equal(f.calls(), 0);
});

test('concurrent paid retries create one job, retain duplicates and enforce order ownership', async (t) => {
  const f = await fixture(t); await f.pay();
  const input = f.input();
  const runs = await Promise.all(Array.from({ length: 8 }, () => f.processing.start(input)));
  assert.equal(new Set(runs.map((run) => run.job.id)).size, 1);
  const jobId = runs[0].job.id;
  await waitFor(() => f.jobs.get(`order:${f.id}`, jobId).status === 'ready');
  assert.equal(f.calls(), 1); assert.equal((await f.state()).attempts, 1);
  assert.equal((await f.state()).processingState, 'ready');
  const result = await f.processing.result({ id: f.id, accessToken: f.accessToken, jobId });
  assert.equal(result.models.length, 2); assert.equal(result.models[0].name, result.models[1].name);
  await rejects(f.processing.result({ id: f.id, accessToken: newOrderAccessToken(), jobId }), 404);
  const otherToken = newOrderAccessToken(), other = await f.orders.create({ requestId: randomUUID(), accessToken: otherToken });
  await rejects(f.processing.result({ id: other.id, accessToken: otherToken, jobId }), 404);
  assert.deepEqual((await f.processing.get({ id: other.id, accessToken: otherToken })).jobs, []);
  await rejects(f.processing.start({ ...input, source: recordsSource('Changed source') }), 409);
  const disk = await readFile(path.join(f.dataDir, 'orders.json'), 'utf8');
  assert.ok(!disk.includes('PRIVATE')); assert.ok(!disk.includes('collection.txt')); assert.ok(!disk.includes(f.accessToken));
  assert.ok(!JSON.stringify((await f.processing.get({ id: f.id, accessToken: f.accessToken })).jobs).includes('PRIVATE'));
});

test('full shared queue rejects a paid launch before recording an attempt', async (t) => {
  const f = await fixture(t, { jobOptions: { maxJobs: 1 } }); await f.pay();
  const first = await f.processing.start(f.input());
  await waitFor(() => f.jobs.get(`order:${f.id}`, first.job.id).status === 'ready');
  const token = newOrderAccessToken(), other = await f.orders.create({ requestId: randomUUID(), accessToken: token });
  await f.orders.bindPayment({ id: other.id, provider: 'test', paymentId: 'second-order' });
  await f.orders.confirmPayment({ id: other.id, provider: 'test', paymentId: 'second-order', amountMinor: 14900, currency: 'RUB' });
  await rejects(f.processing.start(f.input({ id: other.id, accessToken: token })), 503);
  assert.equal((await f.orders.get({ id: other.id, accessToken: token })).attempts, 0);
  await f.processing.cancel({ id: f.id, accessToken: f.accessToken, jobId: first.job.id });
  await waitFor(async () => (await f.state()).canRetry);
  const next = await f.processing.start(f.input({ id: other.id, accessToken: token }));
  assert.equal(next.order.attempts, 1);
});

test('running cancellation permits retry only after upstream has actually stopped', async (t) => {
  let finish, requestSignal;
  const f = await fixture(t, { unblock: () => finish?.(), fetchImpl: async (_url, options) => {
    requestSignal = options.signal;
    await new Promise((resolve) => { finish = resolve; });
    return new Response('{}');
  } }); await f.pay();
  const first = await f.processing.start(f.input());
  await waitFor(() => !!finish);
  await f.processing.cancel({ id: f.id, accessToken: f.accessToken, jobId: first.job.id });
  assert.equal(requestSignal.aborted, true);
  assert.equal((await f.state()).canRetry, false);
  await rejects(f.processing.start(f.input()), 409);
  assert.equal(f.calls(), 1); finish();
  await waitFor(async () => (await f.state()).canRetry);
  const second = await f.processing.start(f.input());
  assert.equal(second.order.attempts, 2);
  await waitFor(() => f.calls() === 2); finish();
  await waitFor(async () => (await f.state()).processingState === 'failed');
});

test('failed recognition permits a new request on the same paid order but not replay of an old request', async (t) => {
  const f = await fixture(t, { fetchImpl: async () => new Response('{}') }); await f.pay();
  const input = f.input(), first = await f.processing.start(input);
  await waitFor(async () => (await f.state()).processingState === 'failed');
  const repeated = await f.processing.start(input);
  assert.equal(repeated.job.id, first.job.id); assert.equal(f.calls(), 1);
  const second = await f.processing.start(f.input());
  assert.notEqual(second.job.id, first.job.id); assert.equal(second.order.paymentState, 'paid');
  await waitFor(async () => (await f.state()).processingState === 'failed');
  assert.equal(f.calls(), 2); assert.equal((await f.state()).attempts, 2);
});

test('expired result releases content and permits a new attempt without declaring the order completed', async (t) => {
  let time = 100;
  const f = await fixture(t, { jobOptions: { now: () => time, resultTtlMs: 50, metadataTtlMs: 10 } }); await f.pay();
  const first = await f.processing.start(f.input());
  await waitFor(() => f.jobs.get(`order:${f.id}`, first.job.id).status === 'ready');
  assert.equal((await f.state()).processingState, 'ready');
  time = 151; f.jobs.sweep();
  await rejects(f.processing.result({ id: f.id, accessToken: f.accessToken, jobId: first.job.id }), 409);
  await waitFor(async () => (await f.state()).canRetry);
  assert.equal((await f.state()).failureCode, 'result_lost');
  time += 11; f.jobs.sweep();
  await rejects(f.processing.result({ id: f.id, accessToken: f.accessToken, jobId: first.job.id }), 404);
  assert.equal((await f.processing.start(f.input())).order.attempts, 2);
});

test('storage failure keeps retry closed; lifecycle reconciles only metadata after storage repair', async (t) => {
  let time = 100, finish;
  const f = await fixture(t, { unblock: () => finish?.(), jobOptions: { now: () => time }, fetchImpl: async () => {
    await new Promise((resolve) => { finish = resolve; }); return new Response('{}');
  } }); await f.pay();
  const first = await f.processing.start(f.input()); await waitFor(() => !!finish);
  const file = path.join(f.dataDir, 'orders.json'), original = await readFile(file, 'utf8');
  await writeFile(file, '{broken'); finish();
  await waitFor(() => !!f.jobs.get(`order:${f.id}`, first.job.id).stateError);
  assert.equal(f.jobs.get(`order:${f.id}`, first.job.id).settling, true);
  await rejects(f.processing.start(f.input()), 503);
  assert.equal(await readFile(file, 'utf8'), '{broken');
  await writeFile(file, original);
  assert.equal((await f.state()).canRetry, false);
  time += 5001; f.jobs.sweep();
  await waitFor(async () => (await f.state()).canRetry);
  assert.equal(f.jobs.get(`order:${f.id}`, first.job.id).stateError, null);
  assert.equal(f.calls(), 1);
});

test('result is never exposed before ready status has been durably recorded', async (t) => {
  let readyGate, reached = false;
  const f = await fixture(t, { unblock: () => readyGate?.(), hooks: { onReady: async () => {
    reached = true; await new Promise((resolve) => { readyGate = resolve; });
    throw new Error('PRIVATE storage detail');
  } } }); await f.pay();
  const first = await f.processing.start(f.input()); await waitFor(() => reached);
  await rejects(f.processing.result({ id: f.id, accessToken: f.accessToken, jobId: first.job.id }), 409);
  assert.equal((await f.state()).processingState, 'running'); readyGate();
  await waitFor(async () => (await f.state()).canRetry);
  const listing = await f.processing.get({ id: f.id, accessToken: f.accessToken });
  assert.ok(!JSON.stringify(listing).includes('PRIVATE'));
  assert.equal(listing.jobs[0].status, 'failed');
});

test('cancelling a queued paid job never sends it to AI or waits for another order to finish', async (t) => {
  let finish;
  const f = await fixture(t, { unblock: () => finish?.(), fetchImpl: async () => {
    await new Promise((resolve) => { finish = resolve; }); return new Response('{}');
  } }); await f.pay();
  await f.processing.start(f.input()); await waitFor(() => !!finish);
  const token = newOrderAccessToken(), second = await f.orders.create({ requestId: randomUUID(), accessToken: token });
  const payment = { id: second.id, provider: 'test', paymentId: 'queued-payment', amountMinor: 14900, currency: 'RUB' };
  await f.orders.bindPayment({ id: second.id, provider: 'test', paymentId: payment.paymentId });
  await f.orders.confirmPayment(payment);
  const queued = await f.processing.start(f.input({ id: second.id, accessToken: token }));
  assert.equal(queued.job.status, 'queued');
  await f.processing.cancel({ id: second.id, accessToken: token, jobId: queued.job.id });
  await waitFor(async () => (await f.orders.get({ id: second.id, accessToken: token })).canRetry);
  assert.equal(f.calls(), 1); assert.equal((await f.state()).processingState, 'running');
  finish(); await waitFor(async () => (await f.state()).canRetry);
});

test('restart retains payment but never resurrects a lost source or an old request', async (t) => {
  const f = await fixture(t); await f.pay();
  const input = f.input(), first = await f.processing.start(input);
  await waitFor(() => f.jobs.get(`order:${f.id}`, first.job.id).status === 'ready');
  await f.close();
  const orders = createOrderStore({ dataDir: f.dataDir });
  const aiService = { approve: async () => ({ accountId: 'primary' }), run: async () => { throw new Error('stub'); } };
  const jobs = createJobStore({ run: createRecognitionWorker(aiService), ...createOrderJobLifecycle(orders) });
  const processing = createOrderProcessing({ orders, jobs, aiService });
  try {
    const state = await processing.get({ id: f.id, accessToken: f.accessToken });
    assert.equal(state.order.paymentState, 'paid'); assert.equal(state.order.canRetry, true); assert.deepEqual(state.jobs, []);
    await rejects(processing.result({ id: f.id, accessToken: f.accessToken, jobId: first.job.id }), 404);
    await rejects(processing.start(input), 409);
    assert.equal((await orders.get({ id: f.id, accessToken: f.accessToken })).attempts, 1);
    const next = await processing.start({ ...input, requestId: randomUUID() });
    assert.equal(next.order.paymentState, 'paid'); assert.equal(next.order.attempts, 2);
  } finally { await processing.close(); await jobs.close(); await orders.close(); }
});
