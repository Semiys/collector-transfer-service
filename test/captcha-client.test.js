import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const code = await readFile(new URL('../public/captcha.js', import.meta.url), 'utf8');
const flush = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };

test('async Turnstile loading renders without calling its incompatible ready method', async () => {
  let script, options, readyCalls = 0;
  const timeouts = new Map(), window = {}, status = { textContent: '' };
  const document = { documentElement: { dataset: {} }, createElement: () => ({ remove() {} }), head: { append(value) { script = value; } } };
  class Observer { observe() {} }
  runInNewContext(code, { window, document, MutationObserver: Observer, ResizeObserver: Observer, AbortSignal,
    fetch: async () => ({ ok: true, json: async () => ({ configured: true, siteKey: 'test', testMode: true }) }),
    setTimeout(callback) { const id = timeouts.size + 1; timeouts.set(id, callback); return id; }, clearTimeout(id) { timeouts.delete(id); } });
  const captcha = window.CollectorCaptcha.mount({ container: { clientWidth: 400 }, status, action: 'collection_zip' });
  const initializing = captcha.initialize(); await flush();
  window.turnstile = {
    ready() { readyCalls += 1; throw new Error('Remove async/defer from the Turnstile api.js script tag before using turnstile.ready().'); },
    render(_container, value) { options = value; return 'widget'; },
  };
  // A real async api.js rejects ready(), even after the script's load event.
  const callback = new URL(script.src).searchParams.get('onload');
  if (callback) window[callback](); else script.onload();
  await initializing;
  assert.equal(readyCalls, 0);
  assert.equal(options.sitekey, 'test'); assert.equal(options.action, 'collection_zip');
  options.callback('verified-token'); assert.equal(captcha.token, 'verified-token');
});

test('CAPTCHA onload callback timeout ends loading and retry can render a usable widget', async () => {
  const timeouts = new Map(); let nextId = 0, script, renderOptions, removed = 0;
  const window = {}, container = { clientWidth: 400 }, status = { textContent: '' };
  const document = { documentElement: { dataset: {} }, createElement: () => ({ remove() { removed += 1; } }),
    head: { append(value) { script = value; } } };
  class Observer { observe() {} }
  runInNewContext(code, { window, document, MutationObserver: Observer, ResizeObserver: Observer, AbortSignal,
    fetch: async () => ({ ok: true, json: async () => ({ configured: true, siteKey: 'test', testMode: true }) }),
    setTimeout(callback) { const id = ++nextId; timeouts.set(id, callback); return id; }, clearTimeout(id) { timeouts.delete(id); } });
  const captcha = window.CollectorCaptcha.mount({ container, status, action: 'test' });
  const first = captcha.initialize(); await flush();
  assert.ok(new URL(script.src).searchParams.get('onload'));
  const lateCallback = window.collectorTurnstileLoaded;
  assert.equal(timeouts.size, 1, 'loading is bounded while the provider callback is missing');
  [...timeouts.values()][0](); await first;
  assert.match(status.textContent, /не загрузилась/);
  assert.equal(captcha.token, ''); assert.equal(removed, 1);
  window.turnstile = { ready() { throw new Error('Async scripts cannot use ready'); },
    render(_container, options) { renderOptions = options; return 'widget'; }, remove() {} };
  lateCallback(); await flush(); assert.equal(renderOptions, undefined, 'late callback cannot revive a failed load');
  await captcha.initialize();
  assert.equal(renderOptions.action, 'test');
  renderOptions.callback('new-token'); assert.equal(captcha.token, 'new-token');
  renderOptions['error-callback']('110200'); assert.equal(captcha.token, '');
  assert.match(status.textContent, /Код: 110200/);
});
