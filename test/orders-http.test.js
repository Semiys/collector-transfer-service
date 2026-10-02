import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';

const code = 'orders-test-code-'.repeat(4);
async function serve(dataDir) {
  const app = createApp({ env: { ADMIN_ACCESS_TOKEN: code, DATA_DIR: dataDir },
    aiFetchImpl: () => { throw new Error('Orders must never call AI'); } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, async close() {
    await new Promise((resolve) => server.close(resolve));
    app.locals.closeJobs(); await app.locals.closeOrders();
  } };
}
async function login(base) {
  const login = await fetch(`${base}/api/admin/session`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  assert.equal(login.status, 200);
  const Cookie = login.headers.get('set-cookie').split(';')[0];
  const session = await (await fetch(`${base}/api/admin/session`, { headers: { Cookie } })).json();
  return { Cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' };
}
async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'collector-orders-http-'));
  const server = await serve(dataDir);
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { ...server, dataDir, headers: await login(server.base) };
}

test('orders API requires admin session and CSRF; guest payment remains disabled', async (t) => {
  const f = await fixture(t), endpoint = `${f.base}/api/admin/orders`;
  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal((await fetch(endpoint, { method: 'POST' })).status, 401);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Cookie: f.headers.Cookie },
    body: JSON.stringify({ requestId: randomUUID() }) })).status, 403);
  assert.equal((await fetch(`${f.base}/admin-orders.js`, { redirect: 'manual' })).status, 303);
  assert.equal((await fetch(`${f.base}/admin-orders.js`, { headers: f.headers })).status, 200);
  const config = await (await fetch(`${f.base}/api/automatic/config`)).json();
  assert.equal(config.paymentAvailable, false); assert.equal(config.processingAvailable, false);
  await fetch(`${f.base}/api/admin/session`, { method: 'DELETE', headers: f.headers });
  assert.equal((await fetch(endpoint, { headers: f.headers })).status, 401);
});

test('HTTP draft creation deduplicates concurrent retries and survives a service restart', async (t) => {
  const f = await fixture(t), requestId = randomUUID();
  const results = await Promise.all(Array.from({ length: 2 }, async () => {
    const response = await fetch(`${f.base}/api/admin/orders`, { method: 'POST', headers: f.headers,
      body: JSON.stringify({ requestId }) });
    assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
  }));
  assert.equal(results[0].order.id, results[1].order.id);
  const safe = JSON.stringify(results);
  for (const privateField of ['accessHash', 'accessToken', 'requestId', 'paymentId', 'bootId']) assert.ok(!safe.includes(privateField));
  await f.close();
  const restarted = await serve(f.dataDir); t.after(() => restarted.close());
  const headers = await login(restarted.base);
  const repeated = await (await fetch(`${restarted.base}/api/admin/orders`, { method: 'POST', headers,
    body: JSON.stringify({ requestId }) })).json();
  assert.equal(repeated.order.id, results[0].order.id);
  const list = await (await fetch(`${restarted.base}/api/admin/orders`, { headers })).json();
  assert.equal(list.total, 1); assert.equal(list.orders[0].paymentState, 'pending');
  assert.equal(list.orders[0].amountMinor, 14900); assert.equal(list.orders[0].attempts, 0);
});

test('HTTP clients cannot set prices, attach collection data or confirm a payment', async (t) => {
  const f = await fixture(t), endpoint = `${f.base}/api/admin/orders`;
  const response = await fetch(endpoint, { method: 'POST', headers: f.headers,
    body: JSON.stringify({ requestId: randomUUID() }) });
  const { order } = await response.json();
  const persisted = await readFile(path.join(f.dataDir, 'orders.json'), 'utf8');
  for (const payload of [{ amountMinor: 1 }, { paymentState: 'paid' }, { source: 'PRIVATE.xlsx' }]) {
    assert.equal((await fetch(endpoint, { method: 'POST', headers: f.headers,
      body: JSON.stringify({ requestId: randomUUID(), ...payload }) })).status, 400);
  }
  for (const suffix of ['/confirm', `/${order.id}/pay`, `/${order.id}/refund`]) {
    assert.equal((await fetch(endpoint + suffix, { method: 'POST', headers: f.headers,
      body: '{}' })).status, 404);
  }
  assert.equal(await readFile(path.join(f.dataDir, 'orders.json'), 'utf8'), persisted);
  assert.equal((await fetch(endpoint + '?offset=-1', { headers: f.headers })).status, 400);
  assert.equal((await fetch(endpoint + '/' + order.id, { method: 'DELETE', headers: { Cookie: f.headers.Cookie } })).status, 403);
  assert.equal((await fetch(endpoint + '/' + order.id, { method: 'DELETE', headers: f.headers })).status, 200);
  assert.equal((await (await fetch(endpoint, { headers: f.headers })).json()).total, 0);
});
