import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { concurrencyLimit, rateLimit } from '../src/http/limits.js';

test('guest rate limit returns Retry-After and resets after its window', async () => {
  let time = 0;
  const app = express();
  app.get('/work', rateLimit({ max: 2, windowMs: 60_000, now: () => time }),
    (_request, response) => response.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/work`;
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(url)).status, 200);
    const limited = await fetch(url);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
    time = 60_000;
    assert.equal((await fetch(url)).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('only the configured number of ZIP jobs can run concurrently', async () => {
  let releaseJob;
  let jobEntered;
  const entered = new Promise((resolve) => { jobEntered = resolve; });
  const blocked = new Promise((resolve) => { releaseJob = resolve; });
  const app = express();
  app.get('/work', concurrencyLimit(1), async (_request, response) => {
    jobEntered();
    await blocked;
    response.json({ ok: true });
  });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/work`;
    const first = fetch(url);
    await entered;
    const busy = await fetch(url);
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get('retry-after'), '5');
    releaseJob();
    assert.equal((await first).status, 200);
    assert.equal((await fetch(url)).status, 200);
  } finally {
    releaseJob();
    await new Promise((resolve) => server.close(resolve));
  }
});
