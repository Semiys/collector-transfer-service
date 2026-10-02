import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { setTimeout as delay } from 'node:timers/promises';
import { createArchiveCapacity } from '../src/transfer/archive-capacity.js';
import { downloadHunt64Photo } from '../src/transfer/photos.js';

async function serve(t, capacity, work) {
  const app = express();
  app.get('/zip', capacity.middleware, async (_request, response) => {
    try {
      const value = await response.locals.runArchiveTask(work);
      if (!response.destroyed) response.json({ value });
    } catch { if (!response.destroyed) response.status(504).json({ error: 'stopped' }); }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/zip`;
}
async function waitFor(check) {
  for (let i = 0; i < 400; i += 1) { if (check()) return; await delay(5); }
  assert.fail('Operation did not reach expected state');
}

test('free HTTP and internal paid ZIP work share capacity and return Retry-After when full', async (t) => {
  const capacity = createArchiveCapacity({ maxActive: 1 });
  const url = await serve(t, capacity, async () => 'free ZIP');
  let finish, entered = false;
  const gate = new Promise((resolve) => { finish = resolve; });
  const paid = capacity.run(async () => { entered = true; await gate; return 'paid ZIP'; });
  await waitFor(() => entered);
  const blocked = await fetch(url);
  assert.equal(blocked.status, 503); assert.equal(blocked.headers.get('retry-after'), '5');
  finish(); assert.equal(await paid, 'paid ZIP');
  assert.equal((await fetch(url)).status, 200);
  assert.equal(await capacity.run(async () => 'slot reused'), 'slot reused');
});

test('disconnected browser aborts work but does not release capacity before actual unwind', async (t) => {
  const capacity = createArchiveCapacity({ maxActive: 1 });
  let finish, signal;
  const gate = new Promise((resolve) => { finish = resolve; });
  const url = await serve(t, capacity, async (value) => { signal = value; await gate; value.throwIfAborted(); });
  const controller = new AbortController();
  const pending = fetch(url, { signal: controller.signal });
  const rejected = assert.rejects(pending);
  await waitFor(() => !!signal); controller.abort(); await rejected;
  await waitFor(() => signal.aborted);
  await assert.rejects(capacity.run(async () => 'should not start'), (error) => error.statusCode === 503);
  finish();
  await waitFor(() => signal.aborted);
  // The server handler needs one event-loop turn to unwind and release its slot.
  await delay(5);
  assert.equal(await capacity.run(async () => 'released'), 'released');
});

test('deadline signals cancellation while retaining capacity until the slow operation stops', async () => {
  const capacity = createArchiveCapacity({ maxActive: 1, timeoutMs: 10 });
  let finish, signal;
  const gate = new Promise((resolve) => { finish = resolve; });
  const pending = capacity.run(async (value) => { signal = value; await gate; value.throwIfAborted(); });
  const rejected = assert.rejects(pending, (error) => error.name === 'TimeoutError');
  await waitFor(() => signal?.aborted);
  await assert.rejects(capacity.run(async () => 'not yet'), (error) => error.statusCode === 503);
  finish(); await rejected;
  assert.equal(await capacity.run(async () => 'reused'), 'reused');
});

test('Hunt64 photo requests receive cancellation and stop without further decoding', async () => {
  const controller = new AbortController();
  let signal;
  const pending = downloadHunt64Photo('https://juegmurcnhnfnvsqsqxn.supabase.co/storage/v1/object/public/collection-photos/test.jpg',
    async (_url, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }, { signal: controller.signal });
  const rejected = assert.rejects(pending, (error) => error.name === 'AbortError');
  controller.abort(); await rejected; assert.equal(signal.aborted, true);
  let called = false;
  await assert.rejects(downloadHunt64Photo('https://example.invalid/blocked', async () => { called = true; },
    { signal: controller.signal }), (error) => error.name === 'AbortError');
  assert.equal(called, false);
});
