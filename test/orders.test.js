import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOrderStore, newOrderAccessToken } from '../src/orders/store.js';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'collector-orders-'));
  const store = createOrderStore({ dataDir, ...options });
  t.after(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const accessToken = newOrderAccessToken(), requestId = randomUUID();
  const order = await store.create({ accessToken, requestId });
  return { store, dataDir, accessToken, requestId, id: order.id, order };
}
async function pay(f, paymentId = 'payment-1') {
  await f.store.bindPayment({ id: f.id, provider: 'test', paymentId });
  const payment = { id: f.id, provider: 'test', paymentId, amountMinor: 14900, currency: 'RUB' };
  await f.store.confirmPayment(payment); return payment;
}
const rejects = (promise, statusCode) => assert.rejects(promise, (error) => error.statusCode === statusCode);
const start = (f, requestId = randomUUID()) => f.store.beginAttempt({ id: f.id, accessToken: f.accessToken, requestId });

test('concurrent duplicate creation survives restart and exposes no access secret', async (t) => {
  const f = await fixture(t);
  const copies = await Promise.all(Array.from({ length: 8 }, () =>
    f.store.create({ requestId: f.requestId, accessToken: f.accessToken })));
  assert.ok(copies.every((order) => order.id === f.id));
  assert.equal((await f.store.list()).total, 1);
  assert.equal(f.order.amountMinor, 14900); assert.equal(f.order.currency, 'RUB');
  assert.equal(f.order.paymentState, 'pending');
  await rejects(f.store.get({ id: f.id, accessToken: newOrderAccessToken() }), 404);
  await rejects(f.store.get({ id: randomUUID(), accessToken: f.accessToken }), 404);
  const disk = await readFile(path.join(f.dataDir, 'orders.json'), 'utf8');
  assert.ok(!disk.includes(f.accessToken));
  for (const key of ['accessHash', 'accessToken', 'requestId', 'provider', 'refundId', 'bootId']) {
    assert.ok(!Object.hasOwn(copies[0], key));
  }
  await rejects(f.store.create({ accessToken: f.accessToken, requestId: randomUUID(), filename: 'PRIVATE.xlsx' }), 400);
  assert.equal(await readFile(path.join(f.dataDir, 'orders.json'), 'utf8'), disk);
  await f.store.close();
  const reopened = createOrderStore({ dataDir: f.dataDir }); t.after(() => reopened.close());
  assert.equal((await reopened.create({ accessToken: f.accessToken, requestId: f.requestId })).id, f.id);
  assert.equal((await reopened.get({ id: f.id, accessToken: f.accessToken })).paymentState, 'pending');
});

test('payment binding is immutable, unique and cannot be spoofed by another payment', async (t) => {
  const f = await fixture(t);
  await rejects(start(f), 402);
  const payment = { id: f.id, provider: 'test', paymentId: 'payment-1', amountMinor: 14900, currency: 'RUB' };
  await rejects(f.store.confirmPayment(payment), 409);
  await f.store.bindPayment({ id: f.id, provider: 'test', paymentId: 'payment-1' });
  for (const patch of [{ amountMinor: 1 }, { amountMinor: '14900' }, { currency: 'EUR' },
    { provider: 'other' }, { paymentId: 'unrelated' }]) await rejects(f.store.confirmPayment({ ...payment, ...patch }), 409);
  const other = await f.store.create({ requestId: randomUUID(), accessToken: f.accessToken });
  await rejects(f.store.bindPayment({ id: other.id, provider: 'test', paymentId: 'payment-1' }), 409);
  await rejects(f.store.bindPayment({ id: f.id, provider: 'test', paymentId: 'payment-2' }), 409);
  await Promise.all(Array.from({ length: 5 }, () => f.store.confirmPayment(payment)));
  assert.equal((await f.store.get({ id: f.id, accessToken: f.accessToken })).paymentState, 'paid');
  await rejects(f.store.cancelPayment({ id: f.id, provider: 'test', paymentId: 'payment-1' }), 409);
});

test('one paid order starts one worker per request and blocks parallel attempts', async (t) => {
  const f = await fixture(t); await pay(f);
  const requestId = randomUUID();
  const runs = await Promise.all(Array.from({ length: 8 }, () => start(f, requestId)));
  assert.equal(runs.filter((run) => run.started).length, 1);
  assert.equal(new Set(runs.map((run) => run.runId)).size, 1);
  const runId = runs[0].runId;
  await rejects(start(f), 409);
  await rejects(f.store.completeAttempt({ id: f.id, runId }), 409);
  await f.store.markReady({ id: f.id, runId });
  await rejects(start(f), 409);
  await f.store.completeAttempt({ id: f.id, runId });
  await f.store.completeAttempt({ id: f.id, runId });
  await rejects(start(f), 409);
  assert.equal((await start(f, requestId)).started, false);
  const state = await f.store.get({ id: f.id, accessToken: f.accessToken });
  assert.equal(state.attempts, 1); assert.equal(state.processingState, 'completed');
});

test('failed attempts can retry without payment, stale requests never consume another try', async (t) => {
  const f = await fixture(t); await pay(f);
  const originalRequest = randomUUID(), first = await start(f, originalRequest);
  await f.store.allowRetry({ id: f.id, runId: first.runId, failureCode: 'recognition_failed' });
  assert.equal((await start(f, originalRequest)).started, false);
  const second = await start(f);
  await rejects(f.store.markReady({ id: f.id, runId: first.runId }), 409);
  await f.store.allowRetry({ id: f.id, runId: second.runId, failureCode: 'cancelled' });
  const third = await start(f);
  await f.store.allowRetry({ id: f.id, runId: third.runId, failureCode: 'expired' });
  await rejects(start(f), 409);
  const state = await f.store.get({ id: f.id, accessToken: f.accessToken });
  assert.equal(state.paymentState, 'paid'); assert.equal(state.attemptsRemaining, 0); assert.equal(state.canRetry, false);
});

test('restart interrupts running and ready results while retaining the confirmed payment', async (t) => {
  for (const ready of [false, true]) {
    const f = await fixture(t); await pay(f);
    const run = await start(f);
    if (ready) await f.store.markReady({ id: f.id, runId: run.runId });
    await f.store.close();
    const reopened = createOrderStore({ dataDir: f.dataDir }); t.after(() => reopened.close());
    // Recovery must persist even when the first request tries to finish the old worker.
    await rejects(reopened.markReady({ id: f.id, runId: run.runId }), 409);
    const state = await reopened.get({ id: f.id, accessToken: f.accessToken });
    assert.equal(state.paymentState, 'paid'); assert.equal(state.processingState, 'interrupted');
    assert.equal(state.failureCode, 'server_restart'); assert.equal(state.canRetry, true);
    const persisted = JSON.parse(await readFile(path.join(f.dataDir, 'orders.json'), 'utf8'));
    assert.equal(persisted.orders[0].attempts[0].state, 'interrupted');
    const next = await reopened.beginAttempt({ id: f.id, accessToken: f.accessToken, requestId: randomUUID() });
    assert.equal(next.started, true); assert.equal(next.order.attempts, 2);
  }
});

test('refund states reject active processing, mismatches and late payment downgrades', async (t) => {
  const f = await fixture(t), payment = await pay(f), run = await start(f);
  await rejects(f.store.requestRefund({ id: f.id, refundId: 'refund-1' }), 409);
  await f.store.allowRetry({ id: f.id, runId: run.runId, failureCode: 'result_lost' });
  await f.store.requestRefund({ id: f.id, refundId: 'refund-1' });
  await f.store.requestRefund({ id: f.id, refundId: 'refund-1' });
  assert.equal((await f.store.confirmPayment(payment)).paymentState, 'refund_pending');
  await rejects(start(f), 402);
  await rejects(f.store.confirmRefund({ ...payment, refundId: 'wrong' }), 409);
  await rejects(f.store.confirmRefund({ ...payment, refundId: 'refund-1', amountMinor: 14899 }), 409);
  const refunded = await f.store.confirmRefund({ ...payment, refundId: 'refund-1' });
  assert.equal(refunded.paymentState, 'refunded');
  await f.store.confirmRefund({ ...payment, refundId: 'refund-1' });
  assert.equal((await f.store.confirmPayment(payment)).paymentState, 'refunded');
  await rejects(f.store.discardDraft(f.id), 409);
});

test('unpaid draft deletion never deletes a linked or cancelled payment', async (t) => {
  const f = await fixture(t);
  await f.store.discardDraft(f.id);
  assert.equal((await f.store.list()).total, 0);
  const order = await f.store.create({ requestId: randomUUID(), accessToken: f.accessToken });
  await f.store.bindPayment({ id: order.id, provider: 'test', paymentId: 'cancelled-1' });
  await rejects(f.store.discardDraft(order.id), 409);
  await f.store.cancelPayment({ id: order.id, provider: 'test', paymentId: 'cancelled-1' });
  await f.store.cancelPayment({ id: order.id, provider: 'test', paymentId: 'cancelled-1' });
  await rejects(f.store.confirmPayment({ id: order.id, provider: 'test', paymentId: 'cancelled-1', amountMinor: 14900, currency: 'RUB' }), 409);
  await rejects(f.store.discardDraft(order.id), 409);
});

test('corrupt metadata fails closed and is never silently replaced', async (t) => {
  const f = await fixture(t), file = path.join(f.dataDir, 'orders.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  for (const invalid of ['{truncated', JSON.stringify({ ...state, source: 'PRIVATE CONTENT' }),
    JSON.stringify({ ...state, orders: [...state.orders, state.orders[0]] })]) {
    await writeFile(file, invalid);
    await rejects(f.store.list(), 503);
    await rejects(f.store.create({ requestId: randomUUID(), accessToken: f.accessToken }), 503);
    assert.equal(await readFile(file, 'utf8'), invalid);
  }
  // A failed operation does not poison the next operation after storage repair.
  await writeFile(file, JSON.stringify(state));
  assert.equal((await f.store.list()).total, 1);
  assert.deepEqual(await readdir(f.dataDir), ['orders.json']);
});

test('capacity, pagination, unavailable storage and closure have explicit failures', async (t) => {
  const f = await fixture(t, { maxOrders: 2 });
  const second = await f.store.create({ requestId: randomUUID(), accessToken: f.accessToken });
  await rejects(f.store.create({ requestId: randomUUID(), accessToken: f.accessToken }), 503);
  assert.equal((await f.store.list({ offset: 0, limit: 1 })).orders[0].id, second.id);
  assert.equal((await f.store.list({ offset: 1, limit: 1 })).orders[0].id, f.id);
  await rejects(f.store.list({ offset: -1 }), 400);
  await f.store.close(); await rejects(f.store.list(), 503);
  const notDirectory = path.join(f.dataDir, 'blocked'); await writeFile(notDirectory, 'file');
  const blocked = createOrderStore({ dataDir: notDirectory }); t.after(() => blocked.close());
  await rejects(blocked.create({ requestId: randomUUID(), accessToken: f.accessToken }), 503);
  assert.equal(await readFile(notDirectory, 'utf8'), 'file');
});
