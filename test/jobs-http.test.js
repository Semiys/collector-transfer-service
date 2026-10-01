import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createAdminSession } from '../src/admin/session.js';
import { createAdminJobsRouter } from '../src/admin/jobs-routes.js';
import { createAiService } from '../src/ai/service.js';
import { createJobStore } from '../src/jobs/store.js';
import { createRecognitionWorker } from '../src/jobs/recognize.js';

test('background API protects source and result, requires consent and deduplicates multipart retries', async (t) => {
  let calls = 0;
  const aiService = createAiService({ store: { getEnabledAccounts: async () => [{ id: 'primary', owner: 'Owner', label: 'Key', apiKey: 'fake' }] },
    fetchImpl: async (_url, options) => {
      calls += 1;
      const { records } = JSON.parse(JSON.parse(options.body).messages[1].content);
      const models = records.map((item) => ({ name: 'Corvette', brand: 'Hot Wheels', scale: '', category: 'Автомобили', price: '',
        purchaseDate: '', notes: '', photoUrl: '', tags: [], currency: 'UNKNOWN', sourceIds: [item.id] }));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ models, warnings: [], unassigned: [] }) } }] }));
    } });
  const jobs = createJobStore({ run: createRecognitionWorker(aiService) });
  const auth = createAdminSession({ adminCode: 'a'.repeat(40) });
  const app = express();
  app.use('/api/admin/session', auth.router);
  app.use('/api/admin/jobs', createAdminJobsRouter({ auth, aiService, jobs, enabled: true }));
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => { jobs.close(); await new Promise((resolve) => server.close(resolve)); });
  await new Promise((resolve) => server.once('listening', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  const makeBody = (consent = true) => {
    const form = new FormData(); form.append('file', new Blob(['Name\nCorvette\n'], { type: 'text/csv' }), 'models.csv');
    form.append('accountId', 'primary'); form.append('consentToAI', String(consent)); return form;
  };
  assert.equal((await fetch(`${root}/api/admin/jobs`, { method: 'POST', body: makeBody() })).status, 401);
  const login = await fetch(`${root}/api/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'a'.repeat(40) }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const session = await (await fetch(`${root}/api/admin/session`, { headers: { Cookie: cookie } })).json();
  const requestId = randomUUID();
  const headers = { Cookie: cookie, 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': requestId };
  assert.equal((await fetch(`${root}/api/admin/jobs`, { method: 'POST', headers: { Cookie: cookie }, body: makeBody() })).status, 403);
  assert.equal((await fetch(`${root}/api/admin/jobs`, { method: 'POST', headers, body: makeBody(false) })).status, 400);
  assert.equal(calls, 0);
  const first = await fetch(`${root}/api/admin/jobs`, { method: 'POST', headers, body: makeBody() });
  assert.equal(first.status, 202);
  const { job } = await first.json();
  const retry = await fetch(`${root}/api/admin/jobs`, { method: 'POST', headers, body: makeBody() });
  assert.equal((await retry.json()).job.id, job.id);
  for (let attempt = 0; attempt < 50 && jobs.get('administrator', job.id).status !== 'ready'; attempt += 1) await delay(5);
  assert.equal(jobs.get('administrator', job.id).status, 'ready'); assert.equal(calls, 1);
  const resultUrl = `${root}/api/admin/jobs/${job.id}/result`;
  assert.equal((await fetch(resultUrl)).status, 401);
  const result = await (await fetch(resultUrl, { headers })).json();
  assert.equal(result.models.length, 1); assert.equal(result.audit.sourceCount, 1);
  const listing = await (await fetch(`${root}/api/admin/jobs`, { headers })).json();
  assert.equal(JSON.stringify(listing).includes('Corvette'), false);
  assert.equal((await fetch(`${root}/api/admin/jobs/${job.id}/consume`, { method: 'POST', headers })).status, 200);
  assert.equal((await fetch(resultUrl, { headers })).status, 409);
});
