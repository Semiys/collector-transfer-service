import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { readJsonResponse, recognizeCollectionText, recognizeCollectionRecords, GroqRateLimitError } from '../src/ai/groq.js';

const privateText = 'PRIVATE_COLLECTION_CONTENT';
const request = (fetchImpl, signal) => recognizeCollectionText({ text: privateText, apiKey: 'test-key', fetchImpl, signal });

test('timeout after HTTP headers is reported as timeout rather than invalid JSON', async () => {
  await assert.rejects(request(async () => new Response(new ReadableStream({
    start(controller) { controller.error(new DOMException(privateText, 'TimeoutError')); },
  }))), (error) => {
    assert.match(error.message, /60 секунд/);
    assert.doesNotMatch(error.message, /JSON|PRIVATE_COLLECTION/);
    return true;
  });
});

test('interrupted response is distinguished from malformed JSON without leaking upstream text', async () => {
  await assert.rejects(request(async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error(privateText)); },
  }))), (error) => {
    assert.match(error.message, /соединение.*оборвалось/i);
    assert.doesNotMatch(error.message, /JSON|PRIVATE_COLLECTION/);
    return true;
  });
});

test('malformed and empty HTTP bodies have separate safe diagnostics', async () => {
  await assert.rejects(request(async () => new Response('{"secret":"' + privateText)), (error) => {
    assert.match(error.message, /некорректный JSON.*HTTP/);
    assert.doesNotMatch(error.message, /PRIVATE_COLLECTION/);
    return true;
  });
  await assert.rejects(request(async () => new Response(' \n ')), /пустой HTTP-ответ/);
});

test('oversized HTTP response is cancelled and reported as a size limit', async () => {
  let cancelled = false;
  await assert.rejects(request(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  }))), /превышает.*2 МБ/);
  assert.equal(cancelled, true);
});

test('cancelling a stalled body read releases the stream and preserves the caller reason', async () => {
  const controller = new AbortController();
  const reason = new Error('Cancelled test job');
  let cancelled = false;
  const pending = readJsonResponse(new Response(new ReadableStream({
    cancel() { cancelled = true; },
  })), controller.signal);
  const rejection = assert.rejects(pending, (error) => error === reason);
  await nextTurn();
  controller.abort(reason);
  await rejection;
  assert.equal(cancelled, true);
});

test('a complete Markdown JSON wrapper preserves CSV models and source coverage', async () => {
  const value = { models: [{ name: 'Test model', tags: [], sourceIds: [1], currency: 'EUR' }], unassigned: [], warnings: [] };
  const result = await recognizeCollectionRecords({ records: [{ id: 1, text: '{"Model Name":"Test model"}' }],
    apiKey: 'test-key', fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
      message: { content: '\n```json\n' + JSON.stringify(value) + '\n```\n' } }] })) });
  assert.equal(result.models[0].name, 'Test model');
  assert.deepEqual(result.models[0].sourceIds, [1]);
  assert.equal(result.models[0].currency, 'EUR');
});

test('truncated or mixed model output is rejected without repairing or exposing it', async () => {
  for (const content of ['```json\n{"models":[', 'Comment: ' + privateText + '\n{"models":[],"warnings":[]}']) {
    await assert.rejects(request(async () => new Response(JSON.stringify({ model: privateText + ' secret text',
      choices: [{ finish_reason: 'stop', message: { content } }] }))), (error) => {
      assert.match(error.message, /ИИ вернул результат не в формате JSON/);
      assert.doesNotMatch(error.message, /PRIVATE_COLLECTION|secret text/);
      return true;
    });
  }
});

test('an error within a choice prevents accepting even a valid partial result', async () => {
  const content = JSON.stringify({ models: [{ name: 'Partial model', tags: [] }], warnings: [] });
  for (const code of [429, 502]) {
    await assert.rejects(request(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'error',
      error: { code, message: privateText, metadata: { provider_name: 'Test provider' } }, message: { content } }] }))), (error) => {
      if (code === 429) assert.ok(error instanceof GroqRateLimitError);
      else assert.match(error.message, /ошибке во время обработки/);
      assert.doesNotMatch(error.message, /PRIVATE_COLLECTION/);
      return true;
    });
  }
  await assert.rejects(request(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'error',
    message: { content } }] }))), /остановил обработку с ошибкой/);
});
