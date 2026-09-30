import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createAccountStore } from '../src/admin/account-store.js';
import { createAdminRouter } from '../src/admin/routes.js';

const fakeKey = `sk-or-v1-${'a'.repeat(64)}`;

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

test('admin API requires token and owner consent', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'collector-admin-api-'));
  const token = 't'.repeat(40);
  const store = createAccountStore({ dataDir, encryptionKey: '3'.repeat(64) });
  const app = express();
  let sentAuthorization;
  app.use('/api/admin', createAdminRouter({ store, token, fetchImpl: async (_url, options) => {
    sentAuthorization = options.headers.Authorization;
    return new Response(JSON.stringify({ data: { is_free_tier: true, expires_at: null } }), { status: 200 });
  } }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/admin/accounts`;
    assert.equal((await fetch(base)).status, 401);
    const headers = { 'X-Admin-Token': token, 'Content-Type': 'application/json' };
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
    assert.deepEqual(await checkResponse.json(), { valid: true, freeTier: true, expiresAt: null });
    assert.equal(sentAuthorization, `Bearer ${fakeKey}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
