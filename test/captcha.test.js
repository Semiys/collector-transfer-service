import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnstile } from '../src/http/captcha.js';

const env = { TURNSTILE_SITE_KEY: 'public-site-key', TURNSTILE_SECRET_KEY: 'private-server-key',
  TURNSTILE_HOSTNAMES: 'transfer.example', NODE_ENV: 'production' };
const request = { token: 'a-valid-token', action: 'collection_zip', hostname: 'transfer.example', ip: '192.0.2.7' };
const validResponse = { success: true, action: 'collection_zip', hostname: 'transfer.example' };

test('CAPTCHA fails closed without settings and never exposes the server secret', async () => {
  const missing = createTurnstile({ env: {}, fetchImpl: () => { throw new Error('must not call'); } });
  assert.equal(missing.publicConfig().configured, false);
  await assert.rejects(missing.verify(request), (error) => error.statusCode === 503);
  const configured = createTurnstile({ env });
  assert.deepEqual(configured.publicConfig(), { configured: true, siteKey: 'public-site-key', testMode: false });
  assert.ok(!JSON.stringify(configured.publicConfig()).includes('private-server-key'));
});

test('CAPTCHA checks token, hostname and action against Siteverify', async () => {
  let calls = 0;
  let upstream = validResponse;
  const captcha = createTurnstile({ env, fetchImpl: async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.deepEqual(JSON.parse(options.body), { secret: 'private-server-key', response: request.token, remoteip: request.ip });
    assert.equal(options.redirect, 'error');
    return Response.json(upstream);
  } });
  for (const token of ['', undefined, 'x'.repeat(2049)]) {
    await assert.rejects(captcha.verify({ ...request, token }), (error) => error.statusCode === 403);
  }
  await assert.rejects(captcha.verify({ ...request, hostname: 'attacker.example' }));
  assert.equal(calls, 0);
  await captcha.verify(request);
  for (const bad of [{ success: false, 'error-codes': ['timeout-or-duplicate'] },
    { ...validResponse, hostname: 'other.example' }, { ...validResponse, action: 'collection_prepare' },
    { success: 'true' }]) {
    upstream = bad;
    await assert.rejects(captcha.verify(request), (error) => error.statusCode === 403);
  }
});

test('CAPTCHA outage rejects processing with a safe error', async () => {
  for (const fetchImpl of [async () => { throw new Error('private-server-key'); },
    async () => new Response('upstream private information', { status: 500 }),
    async () => new Response('not JSON')]) {
    const captcha = createTurnstile({ env, fetchImpl });
    await assert.rejects(captcha.verify(request), (error) => error.statusCode === 503 &&
      !error.message.includes('private-server-key') && !error.message.includes('upstream'));
  }
});

test('official dummy keys require explicit local test mode and are refused in production', async () => {
  const testing = { TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA', TURNSTILE_HOSTNAMES: 'localhost,127.0.0.1' };
  assert.equal(createTurnstile({ env: testing }).publicConfig().configured, false);
  assert.equal(createTurnstile({ env: { ...testing, TURNSTILE_TEST_MODE: 'true', NODE_ENV: 'production' } })
    .publicConfig().configured, false);
  let calls = 0;
  const captcha = createTurnstile({ env: { ...testing, TURNSTILE_TEST_MODE: 'true' },
    fetchImpl: async () => { calls += 1; return Response.json({ success: true, hostname: 'localhost', action: 'test' }); } });
  assert.equal(captcha.publicConfig().testMode, true);
  await assert.rejects(captcha.verify({ ...request, hostname: 'localhost' }));
  assert.equal(calls, 0);
  await captcha.verify({ ...request, hostname: '127.0.0.1', ip: '127.0.0.1' });
});
