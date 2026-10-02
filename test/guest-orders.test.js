import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { createOrderStore, newOrderAccessToken } from '../src/orders/store.js';
import { formatOrderAccess, parseOrderAccess } from '../src/orders/access.js';

async function serve(t, orderStore, env = {}) {
  const app = createApp({ env, orderStore, aiFetchImpl() { throw new Error('Guest lookup must not call AI'); },
    captcha: { publicConfig: () => ({ configured: false }), verify() { throw new Error('Lookup must not call CAPTCHA'); } } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise((resolve) => server.close(resolve));
    await app.locals.closeOrders();
  };
  t.after(close);
  return { base: `http://127.0.0.1:${server.address().port}`, close };
}
const post = (base, payload) => fetch(`${base}/api/orders/status`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'collector-guest-orders-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = createOrderStore({ dataDir });
  const accessToken = newOrderAccessToken();
  const order = await store.create({ requestId: randomUUID(), accessToken });
  return { store, dataDir, order, accessToken, code: formatOrderAccess({ id: order.id, accessToken }) };
}

test('guest access code is versioned, strict and accepts a wrapped full code', () => {
  const id = randomUUID(), accessToken = newOrderAccessToken();
  const code = formatOrderAccess({ id, accessToken });
  assert.equal(code.length, 105);
  assert.deepEqual(parseOrderAccess(`\n ${code.toUpperCase().slice(0, 50)}\n${code.toUpperCase().slice(50)} `), { id, accessToken });
  for (const invalid of [null, {}, [], '', accessToken, id, code.replace('CT1', 'CT2'),
    code.slice(0, -1), code + '.extra', 'x'.repeat(513), code.replace(id, 'not-a-uuid')]) {
    assert.throws(() => parseOrderAccess(invalid), (error) => error.statusCode === 400 && !error.message.includes(accessToken));
  }
});

test('guest status requires its order secret, preserves payment after restart and never grants admin access', async (t) => {
  const f = await fixture(t), first = await serve(t, f.store, { ADMIN_ACCESS_TOKEN: 'guest-test-admin-code-'.repeat(3) });
  const payment = { id: f.order.id, provider: 'test', paymentId: 'fake-payment', amountMinor: 14900, currency: 'RUB' };
  await f.store.bindPayment({ id: payment.id, provider: payment.provider, paymentId: payment.paymentId });
  await f.store.confirmPayment(payment);
  await f.store.beginAttempt({ id: f.order.id, accessToken: f.accessToken, requestId: randomUUID() });
  const before = await readFile(path.join(f.dataDir, 'orders.json'), 'utf8');
  const response = await post(first.base, { code: f.code });
  assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null);
  const data = await response.json();
  assert.equal(data.order.paymentState, 'paid'); assert.equal(data.order.processingState, 'running');
  assert.equal(data.order.attempts, 1); assert.equal(data.order.amountMinor, 14900);
  assert.equal(await readFile(path.join(f.dataDir, 'orders.json'), 'utf8'), before);
  assert.ok(!before.includes(f.accessToken));
  const wrongToken = await post(first.base, { code: formatOrderAccess({ id: f.order.id, accessToken: newOrderAccessToken() }) });
  const unknownId = await post(first.base, { code: formatOrderAccess({ id: randomUUID(), accessToken: f.accessToken }) });
  assert.equal(wrongToken.status, 404); assert.equal(unknownId.status, 404);
  assert.deepEqual(await wrongToken.json(), await unknownId.json());
  assert.equal((await fetch(`${first.base}/api/admin/orders`, { headers: { Authorization: `Bearer ${f.code}` } })).status, 401);
  await first.close();
  const reopened = createOrderStore({ dataDir: f.dataDir }), second = await serve(t, reopened);
  const recovered = await (await post(second.base, { code: f.code })).json();
  assert.equal(recovered.order.id, f.order.id); assert.equal(recovered.order.paymentState, 'paid');
  assert.equal(recovered.order.processingState, 'interrupted'); assert.equal(recovered.order.canRetry, true);
  assert.equal(recovered.order.attemptsRemaining, 2);
  assert.equal(recovered.paymentAvailable, false); assert.equal(recovered.processingAvailable, false);
});

test('guest response projects only status fields even if internal store adds private fields', async (t) => {
  const id = randomUUID(), accessToken = newOrderAccessToken();
  const order = { id, amountMinor: 14900, currency: 'RUB', paymentState: 'pending', processingState: 'idle',
    attempts: 0, attemptsRemaining: 3, canRetry: false, createdAt: 1, updatedAt: 1,
    accessHash: 'PRIVATE_HASH', paymentId: 'PRIVATE_PAYMENT', source: 'PRIVATE_COLLECTION', aiResponse: 'PRIVATE_AI' };
  const server = await serve(t, { async get() { return order; }, async close() {} });
  const response = await post(server.base, { code: formatOrderAccess({ id, accessToken }) });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(Object.keys(data.order).sort(), ['id', 'amountMinor', 'currency', 'paymentState', 'processingState',
    'attempts', 'attemptsRemaining', 'canRetry', 'createdAt', 'updatedAt'].sort());
  assert.ok(!JSON.stringify(data).includes('PRIVATE')); assert.ok(!JSON.stringify(data).includes(accessToken));
});

test('lookup rejects collections, malformed bodies and all public create or payment actions without writes', async (t) => {
  const f = await fixture(t), server = await serve(t, f.store);
  const original = await readFile(path.join(f.dataDir, 'orders.json'), 'utf8');
  for (const body of [{ code: f.code, source: 'PRIVATE.xlsx' }, { code: f.code, amountMinor: 1 },
    { code: f.code, paymentState: 'paid' }, [], {}, { code: null }]) assert.equal((await post(server.base, body)).status, 400);
  for (const body of ['{broken', JSON.stringify({ code: 'x'.repeat(3000) })]) {
    const response = await fetch(`${server.base}/api/orders/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(response.status, 400); assert.ok(!(await response.text()).includes('broken'));
  }
  for (const suffix of ['', '/create', '/pay', '/confirm', '/start', `/${f.order.id}/refund`]) {
    assert.equal((await fetch(`${server.base}/api/orders${suffix}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: f.code }) })).status, 404);
  }
  assert.equal((await fetch(`${server.base}/api/orders/status?code=${encodeURIComponent(f.code)}`)).status, 404);
  assert.equal(await readFile(path.join(f.dataDir, 'orders.json'), 'utf8'), original);
});

test('guest page disables checkout, prevents caching and hides unexpected or corrupt storage errors', async (t) => {
  const empty = await serve(t);
  const config = await (await fetch(`${empty.base}/api/orders/config`)).json();
  assert.deepEqual(config, { lookupAvailable: false, creationAvailable: false, paymentAvailable: false, processingAvailable: false });
  const validCode = formatOrderAccess({ id: randomUUID(), accessToken: newOrderAccessToken() });
  assert.equal((await post(empty.base, { code: validCode })).status, 503);
  for (const suffix of ['/order', '/order.js', '/api/orders/config']) {
    const response = await fetch(empty.base + suffix);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    if (suffix !== '/api/orders/config') assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  }
  const unexpected = await serve(t, { get() { throw new Error('PRIVATE_PATH_AND_TOKEN'); }, async close() {} });
  const safeError = await post(unexpected.base, { code: validCode });
  assert.equal(safeError.status, 503); assert.ok(!(await safeError.text()).includes('PRIVATE'));
  const f = await fixture(t), server = await serve(t, f.store);
  const broken = '{PRIVATE_CORRUPTED_METADATA';
  await writeFile(path.join(f.dataDir, 'orders.json'), broken);
  const response = await post(server.base, { code: f.code });
  assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('PRIVATE'));
  assert.equal(await readFile(path.join(f.dataDir, 'orders.json'), 'utf8'), broken);
});

test('guest status limits attempts before parsing or reading orders', async (t) => {
  let calls = 0;
  const server = await serve(t, { get() { calls += 1; throw new Error('Should not reach store'); }, async close() {} });
  for (let n = 0; n < 20; n += 1) assert.equal((await post(server.base, { code: 'invalid' })).status, 400);
  const response = await post(server.base, { code: 'invalid' });
  assert.equal(response.status, 429); assert.ok(Number(response.headers.get('retry-after')) > 0);
  assert.equal(calls, 0);
});

test('guest status bounds concurrent requests and releases slots after a store failure', async (t) => {
  const gates = [], waiters = [];
  const store = { get() {
    return new Promise((resolve, reject) => { gates.push({ resolve, reject }); waiters.splice(0).forEach((wake) => wake()); });
  }, async close() {} };
  const server = await serve(t, store);
  const code = formatOrderAccess({ id: randomUUID(), accessToken: newOrderAccessToken() });
  const waitFor = async (count) => {
    while (gates.length < count) await new Promise((resolve) => waiters.push(resolve));
  };
  const first = post(server.base, { code }), second = post(server.base, { code });
  await waitFor(2);
  const blocked = await post(server.base, { code });
  assert.equal(blocked.status, 503); assert.equal(blocked.headers.get('retry-after'), '5'); assert.equal(gates.length, 2);
  gates[0].reject(new Error('PRIVATE')); gates[1].reject(new Error('PRIVATE'));
  assert.equal((await first).status, 503); assert.equal((await second).status, 503);
  const released = post(server.base, { code }); await waitFor(3);
  gates[2].resolve({ id: parseOrderAccess(code).id, amountMinor: 14900, currency: 'RUB',
    paymentState: 'pending', processingState: 'idle', attempts: 0, attemptsRemaining: 3, canRetry: false, createdAt: 1, updatedAt: 1 });
  assert.equal((await released).status, 200);
});
