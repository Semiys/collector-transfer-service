import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecognitionWorker } from '../src/jobs/recognize.js';
import { GroqRateLimitError } from '../src/ai/groq.js';

const source = (count) => ({ filename: 'test.csv', bytes: Buffer.from('Model Name\n' +
  Array.from({ length: count }, (_, index) => `Test model ${index + 1}`).join('\n')) });
const answer = (records) => ({ models: records.map(({ id }) => ({ name: `Test model ${id}`, price: '',
  currency: 'UNKNOWN', notes: '', sourceIds: [id] })), warnings: [], unassigned: [], modelUsed: 'test-model' });
const options = (count, progress = () => {}, signal = new AbortController().signal) => ({ source: source(count), route: {}, signal, progress });

test('a short 429 pauses and retries just the current part without losing or duplicating models', async () => {
  const calls = [], waits = [], updates = [];
  const worker = createRecognitionWorker({ run: async ({ records }) => {
    calls.push(records.map(({ id }) => id));
    if (calls.length === 3) throw new GroqRateLimitError(16_000, { retryAfterProvided: true });
    return answer(records);
  } }, { now: () => 100_000, waitForRetry: async (delay, signal) => {
    assert.equal(signal.aborted, false); waits.push(delay);
  } });
  const result = await worker(options(31, (update) => updates.push(update)));
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[2], [31]); assert.deepEqual(calls[3], [31]);
  assert.deepEqual(waits, [16_000]);
  assert.equal(result.models.length, 31);
  assert.equal(result.audit.assignedCount, 31);
  assert.deepEqual(result.audit.modelSources.map(({ sourceIds }) => sourceIds[0]), Array.from({ length: 31 }, (_, index) => index + 1));
  assert.ok(updates.some((update) => update.retryAt === 116_000 && update.retryPart === 3));
  assert.equal(updates.at(-1).retryAt, 0);
});

test('429 retries stop after two waits and never ignore long or unspecified pauses', async () => {
  let calls = 0, waits = 0;
  const worker = createRecognitionWorker({ run: async () => {
    calls += 1; throw new GroqRateLimitError(5_000, { retryAfterProvided: true });
  } }, { waitForRetry: async () => { waits += 1; } });
  await assert.rejects(worker(options(1)), /Часть 1.*429/);
  assert.equal(calls, 3); assert.equal(waits, 2);
  for (const error of [new GroqRateLimitError(61_000, { retryAfterProvided: true }), new GroqRateLimitError(300_000)]) {
    const single = createRecognitionWorker({ run: async () => { throw error; } }, {
      waitForRetry: async () => { assert.fail('long pauses must not retry'); },
    });
    await assert.rejects(single(options(1)), /429/);
  }
});

test('cancellation interrupts a real retry timer before another AI request', async () => {
  const controller = new AbortController();
  let calls = 0, waiting;
  const started = new Promise((resolve) => { waiting = resolve; });
  const worker = createRecognitionWorker({ run: async () => {
    calls += 1; throw new GroqRateLimitError(16_000, { retryAfterProvided: true });
  } });
  const pending = worker(options(1, (update) => { if (update.retryAt) waiting(); }, controller.signal));
  const rejection = assert.rejects(pending, (error) => error.name === 'AbortError');
  await started; controller.abort(); await rejection;
  assert.equal(calls, 1);
});

test('non-rate-limit failures and changed processing permissions are not retried', async () => {
  let calls = 0;
  const worker = createRecognitionWorker({ run: async () => {
    calls += 1;
    if (calls === 1) throw new GroqRateLimitError(5_000, { retryAfterProvided: true });
    throw new Error('Участники обработки изменились');
  } }, { waitForRetry: async () => {} });
  await assert.rejects(worker(options(1)), /Участники обработки изменились/);
  assert.equal(calls, 2);
  const invalid = createRecognitionWorker({ run: async () => { throw new Error('Invalid JSON'); } }, {
    waitForRetry: async () => assert.fail('JSON errors must not retry'),
  });
  await assert.rejects(invalid(options(1)), /Invalid JSON/);
});
