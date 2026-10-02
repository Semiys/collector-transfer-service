import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const code = await readFile(new URL('../public/captcha.js', import.meta.url), 'utf8');
const flush = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };

test('CAPTCHA ready timeout ends loading and retry can render a usable widget', async () => {
  const timeouts = new Map(); let nextId = 0, script, readyCallback, renderOptions, removed = 0;
  const window = {}, container = { clientWidth: 400 }, status = { textContent: '' };
  const document = { documentElement: { dataset: {} }, createElement: () => ({ remove() { removed += 1; } }),
    head: { append(value) { script = value; } } };
  class Observer { observe() {} }
  runInNewContext(code, { window, document, MutationObserver: Observer, ResizeObserver: Observer, AbortSignal,
    fetch: async () => ({ ok: true, json: async () => ({ configured: true, siteKey: 'test', testMode: true }) }),
    setTimeout(callback) { const id = ++nextId; timeouts.set(id, callback); return id; }, clearTimeout(id) { timeouts.delete(id); } });
  const captcha = window.CollectorCaptcha.mount({ container, status, action: 'test' });
  const first = captcha.initialize(); await flush();
  window.turnstile = { ready(callback) { readyCallback = callback; }, render(_container, options) { renderOptions = options; return 'widget'; }, remove() {} };
  script.onload();
  assert.equal(timeouts.size, 1, 'deadline must remain until ready, not only script.onload');
  [...timeouts.values()][0](); await first;
  assert.match(status.textContent, /не загрузилась/);
  assert.equal(captcha.token, ''); assert.equal(removed, 1);
  readyCallback(); await flush(); assert.equal(renderOptions, undefined, 'late callback cannot revive a failed load');
  const retry = captcha.initialize(); await flush(); readyCallback(); await retry;
  assert.equal(renderOptions.action, 'test');
  renderOptions.callback('new-token'); assert.equal(captcha.token, 'new-token');
  renderOptions['error-callback']('110200'); assert.equal(captcha.token, '');
  assert.match(status.textContent, /Код: 110200/);
});
