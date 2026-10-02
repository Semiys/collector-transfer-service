import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server.js';
import { createOrderStore, newOrderAccessToken } from '../src/orders/store.js';
import { formatOrderAccess } from '../src/orders/access.js';
import { unzipSync, strFromU8 } from 'fflate';

async function fixture(t, { configured = true, upstream, unblock } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'collector-guest-transfer-'));
  const orders = createOrderStore({ dataDir });
  const accounts = [{ id: 'PRIVATE_PRIMARY', owner: 'Owner', label: 'PRIVATE_LABEL', apiKey: 'PRIVATE_KEY', enabled: true },
    { id: 'PRIVATE_FALLBACK', owner: 'Friend', label: 'PRIVATE_LABEL_2', apiKey: 'PRIVATE_KEY_2', enabled: true }];
  let calls = 0, verifications = 0, rejectCaptcha = false;
  const store = { list: async () => accounts, getEnabledAccounts: async (id) => {
    const primary = accounts.find((item) => item.id === id && item.enabled);
    if (!primary) throw new Error('PRIVATE_ACCOUNT_PATH');
    return [primary, ...accounts.filter((item) => item.enabled && item.id !== id)];
  } };
  const app = createApp({ env: {}, accountStore: store, orderStore: orders,
    captcha: { publicConfig: () => ({ configured }), verify: async ({ token, action }) => {
      verifications += 1; assert.ok(['collection_recognize', 'collection_order_zip'].includes(action));
      if (rejectCaptcha || token !== 'fake-test-captcha') {
        const { CaptchaError } = await import('../src/http/captcha.js'); throw new CaptchaError('Пройдите проверку человека.');
      }
    } }, aiFetchImpl: async (_url, options) => {
      calls += 1;
      if (upstream) return upstream(options);
      const { records } = JSON.parse(JSON.parse(options.body).messages[1].content);
      const models = records.map((record) => ({ name: 'PRIVATE MODEL', brand: 'Hot Wheels', scale: '1:64',
        category: 'Автомобили', price: '149', currency: 'RUB', purchaseDate: '', notes: '', photoUrl: '', tags: ['2026'], sourceIds: [record.id] }));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ models, warnings: ['Проверьте дату'], unassigned: [] }) } }] }));
    } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const accessToken = newOrderAccessToken(), order = await orders.create({ requestId: randomUUID(), accessToken });
  const code = formatOrderAccess({ id: order.id, accessToken });
  const base = `http://127.0.0.1:${server.address().port}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true; unblock?.();
    await app.locals.closeOrders(); await new Promise((resolve) => server.close(resolve));
  };
  t.after(async () => { await close(); await rm(dataDir, { recursive: true, force: true }); });
  const post = (action, payload = {}, otherCode = code) => fetch(`${base}/api/orders/transfer/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Order-Code': otherCode }, body: JSON.stringify(payload),
  });
  const build = (payload, { code: otherCode = code, requestId = randomUUID() } = {}) => fetch(`${base}/api/orders/transfer/build`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Order-Code': otherCode, 'Idempotency-Key': requestId },
    body: JSON.stringify(payload),
  });
  const f = { app, base, orders, accounts, dataDir, code, id: order.id, accessToken, post, build, close,
    calls: () => calls, verifications: () => verifications, rejectCaptcha: () => { rejectCaptcha = true; },
    state: () => orders.get({ id: order.id, accessToken }) };
  f.pay = async (id = order.id) => {
    const paymentId = randomUUID();
    await orders.bindPayment({ id, provider: 'test', paymentId });
    await orders.confirmPayment({ id, provider: 'test', paymentId, amountMinor: 14900, currency: 'RUB' });
  };
  f.conditions = async () => (await (await post('conditions')).json());
  f.start = (conditions, { text = 'PRIVATE MODEL\nPRIVATE MODEL', file, requestId = randomUUID(), changes = {}, code: otherCode = code } = {}) => {
    const form = new FormData();
    if (file) form.append('file', new Blob([file.bytes]), file.name);
    else form.append('text', text);
    for (const [key, value] of Object.entries({ policyVersion: conditions.policyVersion, routeRevision: conditions.routeRevision,
      consentToAI: 'true', acceptProcessing: 'true', consentToAccountSwitch: 'false', captchaToken: 'fake-test-captcha', ...changes })) form.append(key, value);
    return fetch(`${base}/api/orders/transfer/start`, { method: 'POST', headers: { 'X-Order-Code': otherCode, 'Idempotency-Key': requestId }, body: form });
  };
  return f;
}
async function waitState(f, status) {
  for (let n = 0; n < 100; n += 1) {
    const response = await f.post('state'), data = await response.json();
    if (data.jobs?.[0]?.status === status && !data.jobs[0].settling) return data;
    await delay(10);
  }
  assert.fail('Guest job transition did not finish');
}

async function ready(t) {
  const f = await fixture(t); await f.pay(); await f.start(await f.conditions());
  const state = await waitState(f, 'ready');
  f.download = { jobId: state.jobs[0].id, confirmedAudit: true, confirmedModels: true,
    options: { priceCurrency: 'RUB', transferDate: '2026-10-02', acceptTextWarnings: true },
    edits: [], captchaToken: 'fake-test-captcha' };
  return f;
}

test('guest ZIP contains owned corrections and completion needs explicit acknowledgement of the latest download', async (t) => {
  const f = await ready(t), requestId = randomUUID();
  const payload = { ...f.download, edits: [{ rowIndex: 1, values: { name: 'PRIVATE CORRECTION', price: '7,30' } }] };
  const response = await f.build(payload, { requestId }); assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-disposition'), /dom_collection_transfer\.zip/);
  const receipt = response.headers.get('x-order-receipt'); assert.match(receipt, /^[0-9a-f]{64}$/);
  const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const document = JSON.parse(strFromU8(archive['collection.json']));
  assert.equal(document.models[0].name, 'PRIVATE MODEL'); assert.equal(document.models[1].name, 'PRIVATE CORRECTION');
  assert.equal(document.models[1].price, 7.3);
  for (const model of document.models) assert.ok(archive[model.photoEntry]?.length > 0);
  assert.equal((await f.state()).processingState, 'ready');
  const repeat = await f.build(payload, { requestId }); assert.equal(repeat.status, 200);
  assert.equal(repeat.headers.get('x-order-receipt'), receipt); await repeat.arrayBuffer();
  const ack = { jobId: payload.jobId, receipt, downloadSaved: false };
  assert.equal((await f.post('confirm-saved', ack)).status, 400);
  const updated = await f.build({ ...payload, edits: [{ rowIndex: 1, values: { name: 'PRIVATE LATEST' } }] });
  assert.equal(updated.status, 200); const latestReceipt = updated.headers.get('x-order-receipt'); await updated.arrayBuffer();
  assert.equal((await f.post('confirm-saved', { ...ack, downloadSaved: true })).status, 409);
  const confirms = await Promise.all([1, 2].map(() => f.post('confirm-saved', { ...ack, receipt: latestReceipt, downloadSaved: true })));
  for (const result of confirms) { assert.equal(result.status, 200); assert.equal((await result.json()).order.processingState, 'completed'); }
  assert.equal((await f.post('preview', { jobId: payload.jobId })).status, 409);
  assert.equal((await f.build(payload)).status, 409);
  assert.equal(f.calls(), 1); assert.equal((await f.state()).attempts, 1);
  const disk = await readFile(path.join(f.dataDir, 'orders.json'), 'utf8');
  for (const privateValue of ['PRIVATE', receipt, latestReceipt, f.code, f.accessToken, 'collection.txt']) assert.ok(!disk.includes(privateValue));
  assert.deepEqual(await readdir(f.dataDir), ['orders.json']);
});

test('guest download requires each review confirmation, a human check and a bounded correction body', async (t) => {
  const f = await ready(t), initial = f.verifications();
  for (const payload of [{ ...f.download, confirmedAudit: false }, { ...f.download, confirmedModels: false },
    { ...f.download, options: { ...f.download.options, acceptTextWarnings: false } }, { ...f.download, models: [] }]) {
    assert.equal((await f.build(payload)).status, 400);
  }
  assert.equal(f.verifications(), initial);
  assert.equal((await f.build({ ...f.download, captchaToken: 'wrong' })).status, 403);
  assert.equal((await f.build({ ...f.download, edits: [{ rowIndex: 0, values: { notes: 'X'.repeat(550 * 1024) } }] })).status, 400);
  assert.equal((await f.build({ ...f.download, edits: [{ rowIndex: 99, values: { name: 'Injected' } }] })).status, 400);
  assert.equal((await f.state()).processingState, 'ready'); assert.equal(f.calls(), 1);
});

test('foreign and unpaid orders cannot obtain ZIP bytes or acknowledge another order', async (t) => {
  const f = await ready(t), token = newOrderAccessToken();
  const other = await f.orders.create({ requestId: randomUUID(), accessToken: token });
  const otherCode = formatOrderAccess({ id: other.id, accessToken: token });
  assert.equal((await f.build(f.download, { code: otherCode })).status, 402);
  await f.pay(other.id);
  assert.equal((await f.build(f.download, { code: otherCode })).status, 409);
  assert.equal((await f.build(f.download, { code: 'invalid' })).status, 400);
  const response = await f.build(f.download); assert.equal(response.status, 200);
  const receipt = response.headers.get('x-order-receipt'); await response.arrayBuffer();
  assert.equal((await f.post('confirm-saved', { jobId: f.download.jobId, receipt, downloadSaved: true }, otherCode)).status, 409);
  assert.equal((await f.state()).processingState, 'ready'); assert.equal(f.calls(), 1);
});

test('guest transfer authenticates and checks payment before reading multipart data', async (t) => {
  const f = await fixture(t);
  const malformed = (code) => fetch(`${f.base}/api/orders/transfer/start`, { method: 'POST',
    headers: { 'X-Order-Code': code, 'Content-Type': 'multipart/form-data; boundary=missing' }, body: 'PRIVATE_SOURCE' });
  assert.equal((await malformed('invalid')).status, 400);
  const wrong = formatOrderAccess({ id: f.id, accessToken: newOrderAccessToken() });
  assert.equal((await malformed(wrong)).status, 404);
  assert.equal((await malformed(f.code)).status, 402);
  assert.equal(f.verifications(), 0); assert.equal(f.calls(), 0); assert.equal((await f.state()).attempts, 0);
  await f.pay();
  assert.equal((await f.post('state', {}, wrong)).status, 404);
  assert.equal((await f.post(`state?code=${encodeURIComponent(f.code)}`)).status, 400);
});

test('availability is fail closed and payment creation remains disabled', async (t) => {
  const f = await fixture(t, { configured: false }); await f.pay();
  const config = await (await fetch(`${f.base}/api/orders/config`)).json();
  assert.equal(config.lookupAvailable, true); assert.equal(config.processingAvailable, false);
  assert.equal(config.paymentAvailable, false); assert.equal(config.creationAvailable, false);
  assert.equal((await f.post('state')).status, 503); assert.equal((await f.post('conditions')).status, 503);
  assert.equal(f.calls(), 0);
  for (const action of ['pay', 'confirm', 'create']) {
    assert.equal((await fetch(`${f.base}/api/orders/${action}`, { method: 'POST' })).status, 404);
  }
});

test('guest conditions expose owners and revision but never keys, account IDs or labels', async (t) => {
  const f = await fixture(t); await f.pay();
  const response = await f.post('conditions'); assert.equal(response.status, 200);
  const conditions = await response.json(); assert.deepEqual(conditions.owners, ['Owner', 'Friend']);
  assert.match(conditions.routeRevision, /^[0-9a-f]{64}$/); assert.ok(!JSON.stringify(conditions).includes('PRIVATE'));
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('access-control-allow-origin'), null);
  const status = await (await fetch(`${f.base}/api/orders/status`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: f.code }) })).json();
  assert.equal(status.processingAvailable, true); assert.equal(status.paymentAvailable, false);
  for (const body of [{ source: 'PRIVATE_SOURCE' }, { paymentState: 'paid' }, []]) assert.equal((await f.post('state', body)).status, 400);
});

test('all consents and their revision are required before CAPTCHA or an attempt', async (t) => {
  const f = await fixture(t); await f.pay(); const conditions = await f.conditions();
  for (const [changes, status] of [ [{ consentToAI: 'false' }, 400], [{ acceptProcessing: 'false' }, 400],
    [{ consentToAccountSwitch: 'yes' }, 400], [{ policyVersion: 'old' }, 409], [{ routeRevision: 'old' }, 409] ]) {
    assert.equal((await f.start(conditions, { changes })).status, status);
  }
  f.accounts[1].enabled = false;
  assert.equal((await f.start(conditions, { changes: { consentToAccountSwitch: 'true' } })).status, 409);
  assert.equal(f.calls(), 0); assert.equal(f.verifications(), 0); assert.equal((await f.state()).attempts, 0);
  assert.equal((await f.start(conditions)).status, 429);
});

test('CAPTCHA rejects launch without consuming an attempt or making AI calls', async (t) => {
  const f = await fixture(t); await f.pay(); const conditions = await f.conditions(); f.rejectCaptcha();
  assert.equal((await f.start(conditions)).status, 403);
  assert.equal(f.verifications(), 1); assert.equal(f.calls(), 0); assert.equal((await f.state()).attempts, 0);
});

test('duplicate launches share one attempt and guest result omits private diagnostics', async (t) => {
  const f = await fixture(t); await f.pay(); const conditions = await f.conditions(), requestId = randomUUID();
  const responses = await Promise.all(Array.from({ length: 2 }, () => f.start(conditions, { requestId,
    changes: { consentToAccountSwitch: 'true' } })));
  for (const response of responses) assert.equal(response.status, 202);
  const launches = await Promise.all(responses.map((response) => response.json()));
  const retry = await f.start(conditions, { requestId, changes: { consentToAccountSwitch: 'true' } });
  assert.equal(retry.status, 202); assert.equal((await retry.json()).job.id, launches[0].job.id);
  assert.equal(new Set(launches.map((result) => result.job.id)).size, 1);
  assert.equal((await f.state()).attempts, 1);
  assert.equal((await f.start(conditions, { requestId, text: 'Changed', changes: { consentToAccountSwitch: 'true' } })).status, 409);
  const state = await waitState(f, 'ready'); assert.equal(f.calls(), 1);
  assert.ok(!JSON.stringify(state).includes('PRIVATE'));
  const preview = await f.post('preview', { jobId: state.jobs[0].id }); assert.equal(preview.status, 200);
  const result = await preview.json(); assert.equal(result.rows.length, 2); assert.equal(result.audit.modelSources.length, 2);
  assert.equal(result.audit.sourceCount, 2); assert.equal(result.audit.assignedCount, 2);
  assert.ok(!Object.hasOwn(result, 'diagnostics')); assert.ok(!JSON.stringify(result).includes('PRIVATE_KEY'));
  const stored = await readFile(path.join(f.dataDir, 'orders.json'), 'utf8');
  for (const value of ['PRIVATE MODEL', 'PRIVATE_KEY', f.accessToken, 'collection.txt']) assert.ok(!stored.includes(value));
  assert.deepEqual(await readdir(f.dataDir), ['orders.json']);
});

test('invalid and oversized sources do not consume attempts and never leak filenames', async (t) => {
  const f = await fixture(t); await f.pay(); const conditions = await f.conditions();
  const original = await readFile(path.join(f.dataDir, 'orders.json'), 'utf8');
  for (const input of [ { file: { name: 'PRIVATE.zip', bytes: 'not supported' } },
    { file: { name: 'PRIVATE.csv', bytes: new Uint8Array(8 * 1024 * 1024 + 1) } },
    { text: Array.from({ length: 301 }, () => 'Car').join('\n') },
    { text: 'X'.repeat(8001) }, { text: ' ', changes: { source: 'PRIVATE' } } ]) {
    const response = await f.start(conditions, input); assert.equal(response.status, 400); assert.ok(!(await response.text()).includes('PRIVATE'));
  }
  assert.equal(f.calls(), 0); assert.equal((await f.state()).attempts, 0);
  assert.equal(await readFile(path.join(f.dataDir, 'orders.json'), 'utf8'), original);
});

test('multipart CSV upload reaches the shared worker and only its owner can read all models', async (t) => {
  const f = await fixture(t); await f.pay(); const conditions = await f.conditions();
  const response = await f.start(conditions, { file: { name: 'PRIVATE.csv', bytes: 'Name,Brand\nCorvette,Hot Wheels\nPorsche,Matchbox\n' } });
  assert.equal(response.status, 202);
  const state = await waitState(f, 'ready'); assert.equal(state.jobs[0].progress.sourceCount, 2);
  const preview = await (await f.post('preview', { jobId: state.jobs[0].id })).json();
  assert.equal(preview.rows.length, 2); assert.equal(preview.audit.modelSources.length, 2);
  assert.equal((await f.post('preview', { jobId: state.jobs[0].id, models: [] })).status, 400);
  const stored = await readFile(path.join(f.dataDir, 'orders.json'), 'utf8'); assert.ok(!stored.includes('PRIVATE.csv'));
});

test('another paid order cannot cancel or preview a job, and retries wait for the worker to stop', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { upstream: async () => { await gate; return new Response('{}'); }, unblock: () => release() });
  await f.pay(); const conditions = await f.conditions();
  const response = await f.start(conditions); const { job } = await response.json();
  await waitState(f, 'running');
  const token = newOrderAccessToken(), other = await f.orders.create({ requestId: randomUUID(), accessToken: token });
  await f.pay(other.id); const otherCode = formatOrderAccess({ id: other.id, accessToken: token });
  assert.equal((await f.post('cancel', { jobId: job.id }, otherCode)).status, 404);
  assert.equal((await f.post('preview', { jobId: job.id }, otherCode)).status, 409);
  assert.equal((await f.post('cancel', { jobId: job.id })).status, 200);
  const stopping = await (await f.post('state')).json(); assert.equal(stopping.jobs[0].settling, true);
  assert.equal((await f.start(conditions)).status, 409);
  assert.equal(f.calls(), 1); release(); await waitState(f, 'cancelled');
  assert.equal((await f.state()).canRetry, true); assert.equal((await f.state()).attempts, 1);
});

test('failed worker errors are safe for guests and a restart does not restore collection contents', async (t) => {
  const f = await fixture(t, { upstream: async () => new Response(JSON.stringify({ error: { message: 'PRIVATE_MODEL_AND_KEY' } }), { status: 500 }) });
  await f.pay(); const conditions = await f.conditions();
  assert.equal((await f.start(conditions)).status, 202);
  const state = await waitState(f, 'failed'); assert.ok(!JSON.stringify(state).includes('PRIVATE'));
  assert.match(state.jobs[0].error, /Не удалось распознать/);
  await f.close();
  const reopened = createOrderStore({ dataDir: f.dataDir });
  const app = createApp({ env: {}, orderStore: reopened, accountStore: { list: async () => [] },
    captcha: { publicConfig: () => ({ configured: true }), verify() { throw new Error('Unexpected CAPTCHA'); } },
    aiFetchImpl() { throw new Error('Unexpected AI request'); } });
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/orders/transfer/state`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Order-Code': f.code }, body: '{}' });
    const data = await response.json(); assert.equal(data.order.paymentState, 'paid'); assert.deepEqual(data.jobs, []);
  } finally { await app.locals.closeOrders(); await new Promise((resolve) => server.close(resolve)); }
});
