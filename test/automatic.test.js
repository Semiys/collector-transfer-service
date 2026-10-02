import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAutomaticRouter } from '../src/automatic/routes.js';
import { createApp } from '../src/server.js';
import { createTurnstile } from '../src/http/captcha.js';

test('automatic consent check rejects missing, stale or changed consent before CAPTCHA', async () => {
  let accounts = [{ id: 'one', owner: 'Owner 1', enabled: true, apiKey: 'secret-one' },
    { id: 'two', owner: 'Owner 2', enabled: true, apiKey: 'secret-two' },
    { id: 'duplicate-owner', owner: 'Owner 2', enabled: true },
    { id: 'disabled', owner: 'Owner 3', enabled: false }];
  let verifications = 0;
  const captcha = { verify: async ({ action }) => { verifications += 1; assert.equal(action, 'collection_prepare'); } };
  const app = express();
  app.use('/api/automatic', createAutomaticRouter({ captcha, store: { list: async () => accounts } }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/automatic`;
    const configResponse = await fetch(`${base}/config`);
    const configText = await configResponse.text();
    const config = JSON.parse(configText);
    assert.equal(configResponse.headers.get('cache-control'), 'no-store');
    assert.equal(config.fallbackAvailable, true); assert.equal(config.aiConfigured, true);
    for (const privateValue of ['owners', 'Owner 1', 'Owner 2', 'secret-one', 'duplicate-owner']) assert.ok(!configText.includes(privateValue));
    const valid = { policyVersion: config.policyVersion, routeRevision: config.routeRevision,
      consentToAI: true, acceptProcessing: true, consentToAccountSwitch: false, captchaToken: 'token' };
    const send = (body) => fetch(`${base}/check`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await send({ ...valid, consentToAI: 'true' })).status, 400);
    assert.equal((await send({ ...valid, policyVersion: 'old' })).status, 409);
    assert.equal((await send({ ...valid, text: 'collection must not be accepted here' })).status, 400);
    accounts[1] = { ...accounts[1], enabled: false };
    assert.equal((await send({ ...valid, consentToAccountSwitch: true })).status, 409);
    assert.equal(verifications, 0);
    accounts[1] = { ...accounts[1], enabled: true };
    const accepted = await send(valid);
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { verified: true, processingAvailable: false, paymentAvailable: false,
      message: 'Проверка пройдена. Оплата и автоматическое распознавание ещё не запущены. Файл не отправлен.' });
    assert.equal(verifications, 1);
    assert.equal((await send(valid)).status, 200);
    assert.equal((await send(valid)).status, 429);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('ZIP endpoint requires a fresh valid CAPTCHA and does not trust a forged forwarded IP', async () => {
  let calls = 0;
  const spent = new Set();
  const captcha = createTurnstile({ env: { TURNSTILE_SITE_KEY: 'public', TURNSTILE_SECRET_KEY: 'secret',
    TURNSTILE_HOSTNAMES: '127.0.0.1' }, fetchImpl: async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    assert.equal(body.remoteip, '127.0.0.1');
    const success = body.response === 'valid-token' && !spent.has(body.response);
    spent.add(body.response);
    return Response.json({ success, hostname: '127.0.0.1', action: 'collection_zip' });
  } });
  const server = createApp({ captcha, env: {} }).listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = (token) => {
      const form = new FormData();
      form.append('file', new Blob(['Название\nClassic Bird']), 'collection.csv');
      form.append('mapping', JSON.stringify({ name: 'Название' }));
      form.append('options', JSON.stringify({ priceCurrency: 'RUB' }));
      if (token !== undefined) form.append('captchaToken', token);
      return fetch(`${base}/api/convert`, { method: 'POST', body: form, headers: { 'X-Forwarded-For': '192.0.2.123' } });
    };
    assert.equal((await send()).status, 403);
    assert.equal(calls, 0);
    assert.equal((await send('forged-token')).status, 403);
    assert.equal((await send('valid-token')).status, 200);
    assert.equal((await send('valid-token')).status, 403);
    const config = await (await fetch(`${base}/api/captcha/config`)).json();
    assert.equal(config.siteKey, 'public');
    assert.ok(!JSON.stringify(config).includes('secret'));
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('missing CAPTCHA setup leaves preview available but refuses ZIP and secret use', async () => {
  const server = createApp({ env: {} }).listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [route, expected] of [['preview', 200], ['convert', 503]]) {
      const form = new FormData(); form.append('file', new Blob(['Название\nClassic Bird']), 'collection.csv');
      const response = await fetch(`${base}/api/${route}`, { method: 'POST', body: form });
      assert.equal(response.status, expected);
    }
    assert.equal((await fetch(`${base}/processing`)).status, 200);
    const config = await (await fetch(`${base}/api/automatic/config`)).json();
    assert.equal(config.aiConfigured, false);
    assert.equal(config.processingAvailable, false);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
