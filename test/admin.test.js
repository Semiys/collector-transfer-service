import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createAccountStore } from '../src/admin/account-store.js';
import { createAdminRouter } from '../src/admin/routes.js';
import { createAdminSession } from '../src/admin/session.js';

const fakeKey = `gsk_${'a'.repeat(64)}`;

test('admin storage encrypts API keys and does not return them in listings', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'collector-accounts-'));
  try {
    const encryptionKey = '1'.repeat(64);
    const store = createAccountStore({ dataDir, encryptionKey });
    const added = await store.add({ owner: 'Друг', label: 'Тестовый ключ', apiKey: fakeKey, consent: true });
    assert.equal(added.keyPreview, '••••aaaa');
    assert.equal('apiKey' in added, false);
    const file = await readFile(path.join(dataDir, 'openrouter-accounts.enc.json'), 'utf8');
    assert.equal(file.includes(fakeKey), false);
    const reopened = createAccountStore({ dataDir, encryptionKey });
    assert.equal((await reopened.list())[0].owner, 'Друг');
    await reopened.setEnabled(added.id, false);
    assert.equal((await store.list())[0].enabled, false);
    await store.remove(added.id);
    assert.deepEqual(await reopened.list(), []);
    await assert.rejects(createAccountStore({ dataDir, encryptionKey: '2'.repeat(64) }).list(), /ключ шифрования/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('admin API requires a session and owner consent', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'collector-admin-api-'));
  const token = 't'.repeat(40);
  const store = createAccountStore({ dataDir, encryptionKey: '3'.repeat(64) });
  const app = express();
  const auth = createAdminSession({ adminCode: token });
  let sentAuthorization;
  app.use('/api/admin/session', auth.router);
  app.use('/api/admin', createAdminRouter({ store, auth, fetchImpl: async (_url, options) => {
    sentAuthorization = options.headers.Authorization;
    return new Response(JSON.stringify({ data: [{ id: 'openai/gpt-oss-120b', active: true }] }), { status: 200 });
  } }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/admin/accounts`;
    assert.equal((await fetch(base)).status, 401);
    const login = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: token }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const session = await (await fetch(`http://127.0.0.1:${server.address().port}/api/admin/session`,
      { headers: { Cookie: cookie } })).json();
    const headers = { Cookie: cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' };
    const denied = await fetch(base, { method: 'POST', headers,
      body: JSON.stringify({ owner: 'Друг', label: 'Ключ', apiKey: fakeKey, consent: false }) });
    assert.equal(denied.status, 400);
    const addedResponse = await fetch(base, { method: 'POST', headers,
      body: JSON.stringify({ owner: 'Друг', label: 'Ключ', apiKey: fakeKey, consent: true }) });
    assert.equal(addedResponse.status, 201);
    const added = await addedResponse.json();
    assert.equal('apiKey' in added, false);
    const listed = await (await fetch(base, { headers })).json();
    assert.equal(listed.accounts.length, 1);
    const checkResponse = await fetch(`${base}/${added.id}/check`, { headers });
    assert.deepEqual(await checkResponse.json(), { valid: true, model: 'openai/gpt-oss-120b', modelAvailable: true });
    assert.equal(sentAuthorization, `Bearer ${fakeKey}`);
    const logout = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/session`,
      { method: 'DELETE', headers });
    assert.equal(logout.status, 200);
    assert.equal((await fetch(base, { headers })).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
