import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAccountStore } from '../src/admin/account-store.js';
import { automaticDisclosure, PROCESSING_VERSION } from '../src/automatic/routes.js';
import { createApp } from '../src/server.js';
import { recognizeCollectionText } from '../src/ai/groq.js';

test('existing encrypted OpenRouter keys remain readable but cannot be sent to Groq', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'collector-groq-migration-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const encryptionKey = '6'.repeat(64), legacyKey = `sk-or-v1-${'a'.repeat(64)}`;
  const legacy = { id: 'legacy', owner: 'Test owner', label: 'Old key', apiKey: legacyKey,
    enabled: true, createdAt: '2026-10-01T00:00:00Z' };
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'hex'), iv);
  cipher.setAAD(Buffer.from('collector-transfer-service:openrouter-accounts:v1'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify([legacy]), 'utf8'), cipher.final()]);
  const filePath = path.join(dataDir, 'openrouter-accounts.enc.json');
  await writeFile(filePath, JSON.stringify({ version: 1, iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
  const store = createAccountStore({ dataDir, encryptionKey });
  const [old] = await store.list();
  assert.equal(old.enabled, false); assert.equal(old.compatible, false); assert.equal(old.provider, 'openrouter');
  assert.equal('apiKey' in old, false);
  for (const operation of [() => store.getKey('legacy'), () => store.getEnabledKey('legacy'),
    () => store.getEnabledAccounts('legacy'), () => store.setEnabled('legacy', true)]) {
    await assert.rejects(operation(), /старому провайдеру/);
  }
  assert.deepEqual((await automaticDisclosure(store)).route, []);
  assert.throws(() => store.add({ owner: 'New owner', label: 'Wrong key', apiKey: legacyKey, consent: true }), /Groq/);
  const groq = await store.add({ owner: 'New owner', label: 'Groq key', apiKey: `gsk_${'b'.repeat(48)}`, consent: true });
  assert.equal(groq.compatible, true); assert.equal(groq.provider, 'groq');
  assert.deepEqual((await store.getEnabledAccounts(groq.id)).map(item => item.id), [groq.id]);
  assert.deepEqual((await automaticDisclosure(store)).route.map(item => item.id), [groq.id]);
  assert.equal((await store.list()).length, 2);
  const encrypted = await readFile(filePath, 'utf8');
  assert.equal(encrypted.includes(legacyKey), false); assert.equal(encrypted.includes('gsk_'), false);
});

test('new encryption setting and old .env remain compatible; conflicting keys fail without revealing values', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'collector-groq-env-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const key = '7'.repeat(64), otherKey = '8'.repeat(64);
  for (const env of [{ AI_KEY_ENC_KEY: key }, { OPENROUTER_KEY_ENC_KEY: key },
    { AI_KEY_ENC_KEY: key, OPENROUTER_KEY_ENC_KEY: key }]) {
    const app = createApp({ env: { DATA_DIR: dataDir, ...env } });
    await app.locals.closeJobs();
  }
  assert.throws(() => createApp({ env: { DATA_DIR: dataDir, AI_KEY_ENC_KEY: key, OPENROUTER_KEY_ENC_KEY: otherKey } }),
    error => /должны совпадать/.test(error.message) && !error.message.includes(key) && !error.message.includes(otherKey));
  assert.equal(PROCESSING_VERSION, '2026-10-02.4');
});

test('Groq oversized request fails clearly without exposing raw upstream data', async () => {
  await assert.rejects(recognizeCollectionText({ text: 'A test collection model', apiKey: 'key',
    fetchImpl: async () => new Response('private upstream payload', { status: 413 }) }),
  error => /меньший файл/.test(error.message) && /HTTP 413/.test(error.message) && !error.message.includes('private'));
});
