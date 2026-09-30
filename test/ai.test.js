import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { unzipSync } from 'fflate';
import { recognizeCollectionText } from '../src/ai/openrouter.js';
import { createAccountStore } from '../src/admin/account-store.js';
import { createAdminRouter } from '../src/admin/routes.js';
import { parseInput } from '../src/transfer/parse-input.js';
import { suggestMapping } from '../src/transfer/mapping.js';
import { buildArchive } from '../src/transfer/build-archive.js';

const apiKey = `sk-or-v1-${'b'.repeat(64)}`;
const aiResult = {
  models: [{ name: 'A01 Classic Bird', brand: 'Hot Wheels', scale: '1:64', category: 'Автомобили',
    price: '7.30', purchaseDate: '', notes: 'Синий', photoUrl: '' }],
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
  assert.equal(body.model, 'openrouter/free');
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.provider.require_parameters, true);
  assert.equal(result.transferSource, 'openrouter-ai-v1');
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
  assert.ok(files['photos/1.jpg']);
});

test('AI rejects a rate limit and malformed model data', async () => {
  await assert.rejects(recognizeCollectionText({ text: 'A01 Classic Bird Hot Wheels', apiKey,
    fetchImpl: async () => new Response('', { status: 429 }) }), /ограничил частоту/);
  await assert.rejects(recognizeCollectionText({ text: 'A01 Classic Bird Hot Wheels', apiKey,
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      models: [{ name: '', price: '7' }], warnings: [],
    }) } }] }), { status: 200 }) }), /название модели/);
});

test('AI API uses only the explicitly selected enabled account', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'collector-ai-api-'));
  const store = createAccountStore({ dataDir, encryptionKey: '4'.repeat(64) });
  const account = await store.add({ owner: 'Владелец', label: 'Основной', apiKey, consent: true });
  let calls = 0;
  const app = express();
  const token = 'x'.repeat(40);
  app.use('/api/admin', createAdminRouter({ store, token, aiFetchImpl: async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(aiResult) } }] }), { status: 200 });
  } }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/admin/ai/parse`;
    const body = JSON.stringify({ accountId: account.id, text: 'A01 Classic Bird Hot Wheels' });
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 401);
    const headers = { 'X-Admin-Token': token, 'Content-Type': 'application/json' };
    const accepted = await fetch(url, { method: 'POST', headers, body });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).models[0].name, 'A01 Classic Bird');
    assert.equal(calls, 1);
    await store.setEnabled(account.id, false);
    const rejected = await fetch(url, { method: 'POST', headers, body });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /выключен/);
    assert.equal(calls, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
