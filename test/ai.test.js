import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { unzipSync } from 'fflate';
import { OpenRouterRateLimitError, recognizeCollectionText } from '../src/ai/openrouter.js';
import { createAccountStore } from '../src/admin/account-store.js';
import { createAdminRouter } from '../src/admin/routes.js';
import { createAdminSession } from '../src/admin/session.js';
import { parseInput } from '../src/transfer/parse-input.js';
import { suggestMapping } from '../src/transfer/mapping.js';
import { buildArchive } from '../src/transfer/build-archive.js';

const apiKey = `sk-or-v1-${'b'.repeat(64)}`;
const aiResult = {
  models: [{ name: 'A01 Classic Bird', brand: 'Hot Wheels', scale: '1:64', category: 'Автомобили',
    price: '7.30', purchaseDate: '', notes: 'Синий', photoUrl: '', tags: ['Год выпуска: 1969'] }],
  warnings: ['Цена 7.30 указана без валюты — проверьте её перед экспортом.'],
};

test('AI result reaches the existing reviewed JSON to ZIP path', async () => {
  let sent;
  const result = await recognizeCollectionText({ text: 'A01 Classic Bird Hot Wheels, синий, цена 7,30', apiKey,
    fetchImpl: async (url, options) => {
      sent = { url, options };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(aiResult) } }] }), { status: 200 });
    } });
  assert.equal(sent.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(sent.options.headers.Authorization, `Bearer ${apiKey}`);
  const body = JSON.parse(sent.options.body);
  assert.equal(body.model, 'nvidia/nemotron-3-super-120b-a12b:free');
  assert.deepEqual(body.plugins, [{ id: 'response-healing' }]);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.provider.require_parameters, true);
  assert.equal(result.transferSource, 'openrouter-ai-v1');
  assert.equal(result.modelUsed, 'nvidia/nemotron-3-super-120b-a12b:free');
  const parsed = await parseInput('recognized.json', Buffer.from(JSON.stringify(result)));
  assert.equal(parsed.type, 'ai-json');
  assert.equal(parsed.warnings.length, 2);
  const mapping = suggestMapping(parsed.headers);
  await assert.rejects(buildArchive({ parsed, mapping, options: { priceCurrency: 'RUB', transferDate: '2026-09-30' } }),
    /Проверьте непрочитанные строки/);
  const zip = await buildArchive({ parsed, mapping,
    options: { priceCurrency: 'RUB', transferDate: '2026-09-30', acceptTextWarnings: true } });
  const files = unzipSync(zip.archive);
  const document = JSON.parse(Buffer.from(files['collection.json']).toString('utf8'));
  assert.equal(document.models[0].name, 'A01 Classic Bird');
  assert.equal(document.models[0].price, 7.3);
  assert.equal(document.models[0].purchaseDate, '2026-09-30');
  assert.deepEqual(document.tags.map((tag) => tag.name), ['Год выпуска: 1969']);
  assert.deepEqual(document.modelTags, [{ modelId: 1, tagId: 1 }]);
  assert.ok(files['photos/1.jpg']);
});

test('AI rejects a rate limit and malformed model data', async () => {
  await assert.rejects(recognizeCollectionText({ text: 'A01 Classic Bird Hot Wheels', apiKey,
    fetchImpl: async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }) }),
  (error) => error instanceof OpenRouterRateLimitError && error.retryAfterMs === 120_000);
  await assert.rejects(recognizeCollectionText({ text: 'A01 Classic Bird Hot Wheels', apiKey,
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      models: [{ name: '', price: '7', tags: [] }], warnings: [],
    }) } }] }), { status: 200 }) }), /название модели/);
});

test('AI explains a truncated response instead of a generic JSON error', async () => {
  await assert.rejects(recognizeCollectionText({ text: 'Список моделей коллекционера из нескольких сообщений', apiKey,
    fetchImpl: async () => new Response(JSON.stringify({ model: 'nvidia/nemotron-3-super-120b-a12b:free',
      choices: [{ finish_reason: 'length', message: { content: '{"models":[' } }] }), { status: 200 }) }),
  /Ответ ИИ оборвался/);
});

test('AI API uses only the explicitly selected enabled account', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'collector-ai-api-'));
  const store = createAccountStore({ dataDir, encryptionKey: '4'.repeat(64) });
  const account = await store.add({ owner: 'Владелец', label: 'Основной', apiKey, consent: true });
  let calls = 0;
  let rateLimited = false;
  const app = express();
  const token = 'x'.repeat(40);
  const auth = createAdminSession({ adminCode: token });
  app.use('/api/admin/session', auth.router);
  app.use('/api/admin', createAdminRouter({ store, auth, aiFetchImpl: async () => {
    calls += 1;
    if (rateLimited) return new Response('', { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(aiResult) } }] }), { status: 200 });
  } }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/admin/ai/parse`;
    const body = JSON.stringify({ accountId: account.id, text: 'A01 Classic Bird Hot Wheels' });
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 401);
    const login = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: token }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const session = await (await fetch(`http://127.0.0.1:${server.address().port}/api/admin/session`,
      { headers: { Cookie: cookie } })).json();
    const headers = { Cookie: cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' };
    const accepted = await fetch(url, { method: 'POST', headers, body });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).models[0].name, 'A01 Classic Bird');
    assert.equal(calls, 1);
    rateLimited = true;
    const limited = await fetch(url, { method: 'POST', headers, body });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '300');
    assert.match((await limited.json()).error, /ограничил частоту/);
    assert.equal(calls, 2);
    await store.setEnabled(account.id, false);
    const rejected = await fetch(url, { method: 'POST', headers, body });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /выключен/);
    assert.equal(calls, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('AI switches to an approved owner only after rate limit and remembers cooldown', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'collector-ai-fallback-'));
  const store = createAccountStore({ dataDir, encryptionKey: '5'.repeat(64) });
  const primary = await store.add({ owner: 'Анна', label: 'Первый', apiKey, consent: true });
  const reserveKey = `sk-or-v1-${'c'.repeat(64)}`;
  const reserve = await store.add({ owner: 'Борис', label: 'Резерв', apiKey: reserveKey, consent: true });
  const calls = [];
  const app = express();
  const token = 'y'.repeat(40);
  const auth = createAdminSession({ adminCode: token });
  app.use('/api/admin/session', auth.router);
  app.use('/api/admin', createAdminRouter({ store, auth, aiFetchImpl: async (_url, options) => {
    calls.push(options.headers.Authorization);
    if (options.headers.Authorization === `Bearer ${apiKey}`) {
      return new Response('', { status: 429, headers: { 'Retry-After': '120' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(aiResult) } }] }), { status: 200 });
  } }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/admin/ai/parse`;
    const login = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: token }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const session = await (await fetch(`http://127.0.0.1:${server.address().port}/api/admin/session`,
      { headers: { Cookie: cookie } })).json();
    const headers = { Cookie: cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' };
    const body = { accountId: primary.id, text: 'A01 Classic Bird Hot Wheels' };
    const request = (values) => fetch(url, { method: 'POST', headers,
      body: JSON.stringify({ ...body, ...values }) });

    const unapproved = await request({});
    assert.equal(unapproved.status, 429);
    assert.deepEqual(calls, [`Bearer ${apiKey}`]);

    const staleConsent = await request({ consentToAccountSwitch: true, fallbackAccountIds: ['unknown'] });
    assert.equal(staleConsent.status, 400);
    assert.deepEqual(calls, [`Bearer ${apiKey}`]);

    const approved = await request({ consentToAccountSwitch: true, fallbackAccountIds: [reserve.id] });
    assert.equal(approved.status, 200);
    const result = await approved.json();
    assert.equal(result.keyUsed.owner, 'Борис');
    assert.equal(result.fallbackUsed, true);
    assert.deepEqual(calls, [`Bearer ${apiKey}`, `Bearer ${reserveKey}`]);

    const again = await request({ consentToAccountSwitch: true, fallbackAccountIds: [reserve.id] });
    assert.equal(again.status, 200);
    assert.deepEqual(calls, [`Bearer ${apiKey}`, `Bearer ${reserveKey}`, `Bearer ${reserveKey}`]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
