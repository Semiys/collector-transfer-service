import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAdminSession } from '../src/admin/session.js';

test('admin login protects pages and writes, then logout revokes the session', async () => {
  const code = 'z'.repeat(40);
  const auth = createAdminSession({ adminCode: code, secureCookie: true });
  const app = express();
  app.use('/api/admin/session', auth.router);
  app.get('/admin', auth.requirePage, (_request, response) => response.send('admin'));
  app.post('/api/admin/protected', auth.requireApi, (_request, response) => response.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const deniedPage = await fetch(`${base}/admin`, { redirect: 'manual' });
    assert.equal(deniedPage.status, 303);
    assert.equal(deniedPage.headers.get('location'), '/admin/login');
    assert.equal((await fetch(`${base}/api/admin/protected`, { method: 'POST' })).status, 401);

    const login = await fetch(`${base}/api/admin/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200; Secure/);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/api/admin/protected`, {
      method: 'POST', headers: { Cookie: cookie },
    })).status, 403);
    const session = await (await fetch(`${base}/api/admin/session`, { headers: { Cookie: cookie } })).json();
    assert.equal((await fetch(`${base}/admin`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/admin/protected`, {
      method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': session.csrfToken },
    })).status, 200);
    assert.equal((await fetch(`${base}/api/admin/session`, {
      method: 'DELETE', headers: { Cookie: cookie, 'X-CSRF-Token': session.csrfToken },
    })).status, 200);
    assert.equal((await fetch(`${base}/api/admin/session`, { headers: { Cookie: cookie } })).status, 401);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await fetch(`${base}/api/admin/session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'wrong' }),
      });
      assert.equal(wrong.status, 401);
    }
    const limited = await fetch(`${base}/api/admin/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    assert.equal(limited.status, 429);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('server redirects guests to login and keeps free transfer public', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'collector-admin-page-'));
  const previous = { code: process.env.ADMIN_ACCESS_TOKEN, key: process.env.OPENROUTER_KEY_ENC_KEY,
    dataDir: process.env.DATA_DIR };
  const code = 'a'.repeat(64);
  process.env.ADMIN_ACCESS_TOKEN = code;
  process.env.OPENROUTER_KEY_ENC_KEY = 'b'.repeat(64);
  process.env.DATA_DIR = dataDir;
  let server;
  try {
    const { app } = await import('../src/server.js?admin-page-test');
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base)).status, 200);
    const before = await fetch(`${base}/admin`, { redirect: 'manual' });
    assert.equal(before.status, 303);
    assert.equal(before.headers.get('location'), '/admin/login');
    assert.equal((await fetch(`${base}/api/admin/accounts`)).status, 401);
    const loginPage = await fetch(`${base}/admin/login`);
    assert.match(await loginPage.text(), /Вход администратора/);
    const login = await fetch(`${base}/api/admin/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/admin`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${base}/admin.js`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/admin/accounts`, { headers: { Cookie: cookie } })).status, 200);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const [name, value] of [['ADMIN_ACCESS_TOKEN', previous.code],
      ['OPENROUTER_KEY_ENC_KEY', previous.key], ['DATA_DIR', previous.dataDir]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
