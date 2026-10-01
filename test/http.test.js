import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import { createApp } from '../src/server.js';
import { createTurnstile } from '../src/http/captcha.js';

function testApp() {
  return createApp({ env: {}, captcha: createTurnstile({
    env: { TURNSTILE_SITE_KEY: 'http-test-site', TURNSTILE_SECRET_KEY: 'http-test-secret',
      TURNSTILE_HOSTNAMES: '127.0.0.1' },
    fetchImpl: async () => Response.json({ success: true, hostname: '127.0.0.1', action: 'collection_zip' }),
  }) });
}

test('HTTP preview and ZIP download work without external services for RUB', async () => {
  const server = testApp().listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const adminPage = await fetch(`${base}/admin`);
    assert.equal(adminPage.status, 503);
    assert.match(adminPage.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await fetch(`${base}/admin/login`)).status, 200);
    assert.equal((await fetch(`${base}/api/admin/accounts`)).status, 503);
    const csv = 'Название,Цена,Категория\n' +
      Array.from({ length: 7 }, (_, index) => `Модель ${index + 1},125,Автомобили`).join('\n') + '\n';
    const file = new Blob([csv], { type: 'text/csv' });
    const previewForm = new FormData();
    previewForm.append('file', file, 'collection.csv');
    const previewResponse = await fetch(`${base}/api/preview`, { method: 'POST', body: previewForm });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.rowCount, 7);
    assert.equal(preview.rows.length, 7);
    assert.equal(preview.mapping.name, 'Название');

    const oversizedCsv = 'Название\n' + Array.from({ length: 301 }, (_, index) => `Модель ${index + 1}`).join('\n');
    const oversizedForm = new FormData();
    oversizedForm.append('file', new Blob([oversizedCsv], { type: 'text/csv' }), 'large.csv');
    const oversizedResponse = await fetch(`${base}/api/preview`, { method: 'POST', body: oversizedForm });
    assert.equal(oversizedResponse.status, 400);
    assert.match((await oversizedResponse.json()).error, /не более 300 моделей/);

    const convertForm = new FormData();
    convertForm.append('captchaToken', 'http-test-token');
    convertForm.append('file', file, 'collection.csv');
    convertForm.append('mapping', JSON.stringify(preview.mapping));
    convertForm.append('options', JSON.stringify({ priceCurrency: 'RUB', transferDate: '2026-09-29' }));
    const zipResponse = await fetch(`${base}/api/convert`, { method: 'POST', body: convertForm });
    assert.equal(zipResponse.status, 200);
    assert.match(zipResponse.headers.get('content-type'), /application\/zip/);
    const files = unzipSync(new Uint8Array(await zipResponse.arrayBuffer()));
    const document = JSON.parse(Buffer.from(files['collection.json']).toString('utf8'));
    assert.equal(document.models[0].name, 'Модель 1');
    assert.equal(document.models[0].price, 125);
    assert.equal(document.models[0].purchaseDate, '2026-09-29');
    assert.ok(files['photos/1.jpg']);
    assert.equal(document.models.length, 7);

    const txt = new Blob(['Мой список\n🔴 HOT WHEELS\n• A01 Classic Bird — Blue'], { type: 'text/plain' });
    const txtForm = new FormData(); txtForm.append('file', txt, 'notes.txt');
    const txtPreview = await (await fetch(`${base}/api/preview`, { method: 'POST', body: txtForm })).json();
    assert.equal(txtPreview.rowCount, 1);
    assert.equal(txtPreview.warnings.length, 1);
    const txtConvert = new FormData();
    txtConvert.append('captchaToken', 'http-test-token');
    txtConvert.append('file', txt, 'notes.txt');
    txtConvert.append('mapping', JSON.stringify(txtPreview.mapping));
    txtConvert.append('options', JSON.stringify({ priceCurrency: 'RUB', transferDate: '2026-09-29' }));
    assert.equal((await fetch(`${base}/api/convert`, { method: 'POST', body: txtConvert })).status, 400);
    txtConvert.set('options', JSON.stringify({ priceCurrency: 'RUB', transferDate: '2026-09-29', acceptTextWarnings: true }));
    assert.equal((await fetch(`${base}/api/convert`, { method: 'POST', body: txtConvert })).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('manual DeepSeek JSON is fully previewed and confirmed before ZIP', async () => {
  const server = testApp().listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const guide = await fetch(`${base}/guide`);
    assert.equal(guide.status, 200);
    assert.match(await guide.text(), /Скопировать запрос/);
    const source = { transferSource: 'manual-ai-v1', warnings: [], models: Array.from({ length: 7 }, (_, index) => ({
      name: `Модель ${index + 1}`, brand: 'Hot Wheels', scale: '1:64', category: 'Автомобили',
      price: '125', purchaseDate: '', notes: '', photoUrl: '',
    })) };
    const file = new Blob([JSON.stringify(source)], { type: 'application/json' });
    const previewForm = new FormData(); previewForm.append('file', file, 'deepseek-result.json');
    const previewResponse = await fetch(`${base}/api/preview`, { method: 'POST', body: previewForm });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.type, 'ai-json');
    assert.equal(preview.rowCount, 7);
    assert.equal(preview.rows.length, 7);
    assert.equal(preview.warnings[0].line, 'ИИ');
    const convertForm = new FormData();
    convertForm.append('captchaToken', 'http-test-token');
    convertForm.append('file', file, 'deepseek-result.json');
    convertForm.append('mapping', JSON.stringify(preview.mapping));
    convertForm.append('options', JSON.stringify({ priceCurrency: 'RUB', transferDate: '2026-09-30' }));
    assert.equal((await fetch(`${base}/api/convert`, { method: 'POST', body: convertForm })).status, 400);
    convertForm.set('options', JSON.stringify({ priceCurrency: 'RUB', transferDate: '2026-09-30', acceptTextWarnings: true }));
    const zipResponse = await fetch(`${base}/api/convert`, { method: 'POST', body: convertForm });
    assert.equal(zipResponse.status, 200);
    const files = unzipSync(new Uint8Array(await zipResponse.arrayBuffer()));
    const document = JSON.parse(Buffer.from(files['collection.json']).toString('utf8'));
    assert.equal(document.models.length, 7);
    assert.ok(files['photos/7.jpg']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
