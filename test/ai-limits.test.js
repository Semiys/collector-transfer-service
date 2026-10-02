import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { GroqRateLimitError, recognizeCollectionText } from '../src/ai/groq.js';
import { getKeyStatus } from '../src/ai/key-status.js';
import { createAiService } from '../src/ai/service.js';
import { createJobStore } from '../src/jobs/store.js';
import { createRecognitionWorker } from '../src/jobs/recognize.js';

const privateText = 'Private collection Model 2, personal notes';
const jsonResponse = (value, options = {}) => new Response(JSON.stringify(value), options);
const result = { models: [{ name: 'Corvette', tags: [] }], warnings: [] };

test('key check validates Groq authorization and listed model without exposing other metadata', async () => {
  const status = await getKeyStatus({ apiKey: 'private-key', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/models');
    assert.equal(options.headers.Authorization, 'Bearer private-key');
    return jsonResponse({ data: [{ id: 'openai/gpt-oss-20b', active: true, extra: 'private-key' }] });
  } });
  assert.deepEqual(status, { valid: true, model: 'openai/gpt-oss-20b', modelAvailable: true });
  assert.equal(JSON.stringify(status).includes('private-key'), false);
});

test('key check does not invent quota or expose malformed upstream responses', async () => {
  for (const data of [[], [{ id: 'other-model' }], [{ id: 'openai/gpt-oss-20b', active: false }]]) {
    assert.deepEqual(await getKeyStatus({ apiKey: 'key', fetchImpl: async () => jsonResponse({ data }) }),
      { valid: true, model: 'openai/gpt-oss-20b', modelAvailable: false });
  }
  assert.equal((await getKeyStatus({ apiKey: 'key', fetchImpl: async () => new Response('', { status: 401 }) })).valid, false);
  await assert.rejects(getKeyStatus({ apiKey: 'key', fetchImpl: async () => new Response(privateText) }),
    (error) => /некорректный ответ/.test(error.message) && !error.message.includes(privateText));
  await assert.rejects(getKeyStatus({ apiKey: 'key', fetchImpl: async () => jsonResponse({ data: {},
    large: 'x'.repeat(70_000) }) }), /некорректный ответ/);
});

test('429 diagnostics distinguish exhausted Groq request and token counters without retaining raw errors', async () => {
  const cases = [
    { metadata: {}, headers: { 'X-RateLimit-Limit-Requests': '1000', 'X-RateLimit-Remaining-Requests': '0' }, source: 'platform', dimension: 'requests', limit: 1000 },
    { metadata: {}, headers: { 'X-RateLimit-Limit-Tokens': '8000', 'X-RateLimit-Remaining-Tokens': '0' }, source: 'platform', dimension: 'tokens', limit: 8000 },
    { metadata: { provider_code: 'rate_limited', raw: privateText }, headers: {}, source: 'unknown' },
    { metadata: {}, headers: { 'X-RateLimit-Limit-Requests': '1000', 'X-RateLimit-Remaining-Requests': '998' }, source: 'unknown' },
    { metadata: {}, headers: {}, source: 'unknown' },
  ];
  for (const item of cases) {
    await assert.rejects(recognizeCollectionText({ text: privateText, apiKey: 'key', fetchImpl: async () =>
      jsonResponse({ error: { code: 429, message: privateText, metadata: item.metadata } }, {
        status: 429, headers: { ...item.headers, 'Retry-After': '120' } }) }), (error) => {
      assert.ok(error instanceof GroqRateLimitError);
      assert.equal(error.retryAfterMs, 120_000);
      assert.equal(error.details.source, item.source);
      assert.equal(error.details.retryAfterProvided, true);
      assert.match(error.message, /120 с/);
      assert.equal(error.message.includes(privateText), false);
      assert.equal(JSON.stringify(error).includes(privateText), false);
      if (item.source === 'platform') {
        assert.equal(error.details.dimension, item.dimension);
        assert.equal(error.details.limit, item.limit);
        assert.match(error.message, /по лимиту организации/);
      }
      return true;
    });
  }
  await assert.rejects(recognizeCollectionText({ text: privateText, apiKey: 'key',
    fetchImpl: async () => new Response(privateText, { status: 429 }) }), (error) => {
    assert.equal(error.retryAfterMs, 300_000);
    assert.equal(error.details.retryAfterProvided, false);
    assert.match(error.message, /Срок ожидания не указан/);
    assert.equal(error.message.includes(privateText), false);
    return true;
  });
});

test('HTTP 200 error bodies are handled as 429 and never accepted as a partial result', async () => {
  await assert.rejects(recognizeCollectionText({ text: privateText, apiKey: 'key', fetchImpl: async () =>
    jsonResponse({ error: { code: 429, message: privateText, metadata: { provider_code: 'rate_limited' } },
      choices: [{ message: { content: JSON.stringify(result) } }] }, { headers: { 'Retry-After': '30' } }) }),
    (error) => error instanceof GroqRateLimitError && error.details.source === 'unknown' && error.retryAfterMs === 30_000);
});

test('cooldown reports actual remaining wait and prevents premature upstream retries', async () => {
  let time = 1_000_000, calls = 0;
  const account = { id: 'one', owner: 'Owner', label: 'Key', apiKey: 'key' };
  const ai = createAiService({ store: { getEnabledAccounts: async () => [account] }, now: () => time,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({ error: { code: 429, metadata: { provider_code: 'rate_limited' } } },
        { status: 429, headers: { 'Retry-After': '120' } }) :
        jsonResponse({ choices: [{ message: { content: JSON.stringify(result) } }] });
    } });
  const route = await ai.approve({ accountId: 'one' });
  await assert.rejects(ai.run({ route, text: privateText }), (error) => error.retryAfterMs === 120_000);
  time += 5_000;
  await assert.rejects(ai.run({ route, text: privateText }), (error) => {
    assert.equal(error.retryAfterMs, 115_000);
    assert.equal(error.details.source, 'unknown');
    assert.match(error.message, /115 с/);
    return true;
  });
  assert.equal(calls, 1);
  time += 115_000;
  assert.equal((await ai.run({ route, text: privateText })).models[0].name, 'Corvette');
  assert.equal(calls, 2);
});

test('all approved keys blocked reports earliest actual cooldown without another request', async () => {
  let time = 1_000_000, calls = 0;
  const accounts = [{ id: 'one', owner: 'First', label: 'First', apiKey: 'key1' },
    { id: 'two', owner: 'Second', label: 'Second', apiKey: 'key2' }];
  const ai = createAiService({ store: { getEnabledAccounts: async () => accounts }, now: () => time,
    fetchImpl: async (_url, options) => {
      calls += 1;
      return new Response('', { status: 429, headers: {
        'Retry-After': options.headers.Authorization === 'Bearer key1' ? '120' : '90' } });
    } });
  const route = await ai.approve({ accountId: 'one', consentToAccountSwitch: true, fallbackAccountIds: ['two'] });
  await assert.rejects(ai.run({ route, text: privateText }), (error) => error.retryAfterMs === 90_000);
  assert.equal(calls, 2);
  time += 10_000;
  await assert.rejects(ai.run({ route, text: privateText }), (error) => error.retryAfterMs === 80_000);
  assert.equal(calls, 2);
});

test('background job displays safe 429 diagnostics for a two-row file', async (t) => {
  const account = { id: 'one', owner: 'Owner', label: 'Key', apiKey: 'key' };
  const ai = createAiService({ store: { getEnabledAccounts: async () => [account] },
    fetchImpl: async () => jsonResponse({ error: { code: 429, message: privateText,
      metadata: { provider_code: 'rate_limited' } } }, { status: 429, headers: { 'Retry-After': '120' } }) });
  const jobs = createJobStore({ run: createRecognitionWorker(ai) });
  t.after(() => jobs.close());
  const job = jobs.create({ owner: 'admin', requestId: randomUUID(), fingerprint: 'two rows',
    source: { filename: 'test.csv', bytes: Buffer.from('name\nCorvette\nMustang') },
    route: await ai.approve({ accountId: 'one' }) });
  for (let attempt = 0; attempt < 100 && jobs.get('admin', job.id).status !== 'failed'; attempt += 1) await nextTurn();
  const failed = jobs.get('admin', job.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.progress.sourceCount, 2);
  assert.equal(failed.progress.completed, 0);
  assert.match(failed.error, /Часть 1: Groq.*120 с/);
  assert.equal(failed.error.includes(privateText), false);
  assert.throws(() => jobs.result('admin', job.id), /не готов/);
});
