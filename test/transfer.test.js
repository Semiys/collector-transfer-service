import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { unzipSync } from 'fflate';
import { parseInput } from '../src/transfer/parse-input.js';
import { suggestMapping, detectPriceCurrency } from '../src/transfer/mapping.js';
import { parseEurRate } from '../src/transfer/cbr-rate.js';
import { validateHunt64PhotoUrl, downloadHunt64Photo } from '../src/transfer/photos.js';
import { buildArchive } from '../src/transfer/build-archive.js';

const photoUrl = 'https://juegmurcnhnfnvsqsqxn.supabase.co/storage/v1/object/public/collection-photos/test/photo.webp';
const csv = `Brand,Model Name,Category,Price Paid (EUR),My Photo URL,Date Added\nHot Wheels,Chevy Silverado,automotive,10.00,${photoUrl},2026-09-29\n`;

test('Hunt64 CSV maps paid price, not date added', async () => {
  const parsed = await parseInput('hunt64.csv', Buffer.from(csv));
  const mapping = suggestMapping(parsed.headers);
  assert.equal(mapping.name, 'Model Name');
  assert.equal(mapping.price, 'Price Paid (EUR)');
  assert.equal(mapping.purchaseDate, '');
  assert.equal(mapping.photoUrl, 'My Photo URL');
  assert.equal(detectPriceCurrency(mapping.price), 'EUR');
});

test('CBR XML reads EUR with nominal', () => {
  const xml = '<ValCurs Date="29.09.2026"><Valute><CharCode>USD</CharCode><Nominal>1</Nominal><Value>80,00</Value></Valute><Valute><CharCode>EUR</CharCode><Nominal>10</Nominal><Value>905,00</Value></Valute></ValCurs>';
  assert.deepEqual(parseEurRate(xml), {
    currency: 'EUR', rubPerEuro: 90.5, date: '29.09.2026', source: 'https://www.cbr.ru/scripts/XML_daily.asp',
  });
});

test('ZIP matches DomCollection schema and converts EUR to RUB', async () => {
  const parsed = await parseInput('hunt64.csv', Buffer.from(csv));
  const result = await buildArchive({
    parsed, mapping: suggestMapping(parsed.headers),
    options: { priceCurrency: 'EUR', transferDate: '2026-09-29', defaultCategory: 'Без категории' },
    eurRate: { rubPerEuro: 90.5, date: '29.09.2026' },
    downloadPhoto: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });
  const files = unzipSync(result.archive);
  assert.deepEqual(Object.keys(files).sort(), ['collection.json', 'photos/1.jpg']);
  const document = JSON.parse(Buffer.from(files['collection.json']).toString('utf8'));
  assert.equal(document.formatVersion, 1);
  assert.equal(document.models[0].price, 905);
  assert.equal(document.models[0].purchaseDate, '2026-09-29');
  assert.equal(document.models[0].categoryId, document.categories[0].id);
  assert.match(document.models[0].notes, /Исходная цена: 10.00 EUR/);
  assert.match(document.models[0].notes, /Дата покупки отсутствовала/);
  assert.equal(result.failedPhotos.length, 0);
});

test('unavailable photo receives placeholder and warning', async () => {
  const parsed = await parseInput('hunt64.csv', Buffer.from(csv));
  const result = await buildArchive({
    parsed, mapping: suggestMapping(parsed.headers),
    options: { priceCurrency: 'EUR', transferDate: '2026-09-29' },
    eurRate: { rubPerEuro: 90.5, date: '29.09.2026' },
    downloadPhoto: async () => { throw new Error('offline'); },
  });
  assert.deepEqual(result.failedPhotos, [2]);
  const files = unzipSync(result.archive);
  assert.equal(files['photos/1.jpg'][0], 0xff);
  assert.equal(files['photos/1.jpg'][1], 0xd8);
});

test('photo URL only accepts public Hunt64 collection photos', () => {
  assert.equal(validateHunt64PhotoUrl(photoUrl).hostname, 'juegmurcnhnfnvsqsqxn.supabase.co');
  assert.throws(() => validateHunt64PhotoUrl('http://127.0.0.1/private'));
  assert.throws(() => validateHunt64PhotoUrl('https://juegmurcnhnfnvsqsqxn.supabase.co.evil.test/photo'));
});

test('WebP from Hunt64 is converted to JPEG', async () => {
  const webp = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#336699' } })
    .webp().toBuffer();
  const jpeg = await downloadHunt64Photo(photoUrl, async () => new Response(webp, {
    status: 200, headers: { 'content-type': 'image/webp', 'content-length': String(webp.length) },
  }));
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  assert.equal((await sharp(jpeg).metadata()).format, 'jpeg');
});

test('XLSX parser reads first sheet', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Коллекция');
  sheet.addRow(['Название', 'Цена']);
  sheet.addRow(['Модель 1', 120]);
  const bytes = await workbook.xlsx.writeBuffer();
  const parsed = await parseInput('collection.xlsx', bytes);
  assert.equal(parsed.rows[0]['Название'], 'Модель 1');
  assert.equal(parsed.rows[0]['Цена'], '120');
});

test('JSON backup resolves category names and purchase date', async () => {
  const source = { categories: [{ id: 2, name: 'Автомобили' }], models: [
    { id: 8, name: 'Модель 8', price: 120, purchaseDate: '2026-09-01', categoryId: 2 },
  ] };
  const parsed = await parseInput('collection.json', Buffer.from(JSON.stringify(source)));
  const mapping = suggestMapping(parsed.headers);
  assert.equal(mapping.category, 'Категория из JSON');
  assert.equal(mapping.purchaseDate, 'purchaseDate');
  assert.equal(parsed.rows[0][mapping.category], 'Автомобили');
});

test('semicolon CSV parses a quoted model name', async () => {
  const parsed = await parseInput('list.csv', Buffer.from('Название;Цена\n"Модель; серия";7,30\n'));
  assert.equal(parsed.rows[0]['Название'], 'Модель; серия');
  assert.equal(parsed.rows[0]['Цена'], '7,30');
});

test('structured TXT preserves sections, codes and multiline notes', async () => {
  const text = `🔴 HOT WHEELS REDLINE\n• A01 Classic Bird (1969) — Blue Spectraflame | C-9\n(Extremely rare)\n• B01T-Totaller (1979) — Black | Mattel USA\n\nАКСЕССУАРЫ\n• Collector Case — 24 машинки\nНеизвестная строка без модели`;
  const parsed = await parseInput('collection.txt', Buffer.from(text));
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.rows[0]['Бренд'], 'Hot Wheels');
  assert.equal(parsed.rows[0]['Название'], 'Classic Bird (1969)');
  assert.match(parsed.rows[0]['Заметки'], /Extremely rare/);
  assert.equal(parsed.rows[1]['Название'], 'T-Totaller (1979)');
  assert.equal(parsed.rows[2]['Категория'], 'АКСЕССУАРЫ');
  assert.match(parsed.rows[2]['Заметки'], /Неизвестная строка/);
});

test('TXT keeps explanatory bullets with their model', async () => {
  const text = 'АКСЕССУАРЫ\n• Архивный тест-сет — Редкий выпуск\n• Техническая расшифровка: код линии — 16\n• Статус: заводской образец';
  const parsed = await parseInput('list.txt', Buffer.from(text));
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0]['Название'], 'Архивный тест-сет');
  assert.match(parsed.rows[0]['Заметки'], /Техническая расшифровка/);
  assert.match(parsed.rows[0]['Заметки'], /Статус/);
});
