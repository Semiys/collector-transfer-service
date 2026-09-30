import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInput } from './transfer/parse-input.js';
import { suggestMapping, detectPriceCurrency } from './transfer/mapping.js';
import { getEurRate } from './transfer/cbr-rate.js';
import { buildArchive } from './transfer/build-archive.js';
import { createAccountStore } from './admin/account-store.js';
import { createAdminRouter } from './admin/routes.js';

const app = express();
const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const pagePath = path.resolve(currentDirectory, '../public/index.html');
const guidePagePath = path.resolve(currentDirectory, '../public/guide.html');
const adminPagePath = path.resolve(currentDirectory, '../public/admin.html');
const adminScriptPath = path.resolve(currentDirectory, '../public/admin.js');
const dataDir = process.env.DATA_DIR ?? path.resolve(currentDirectory, '../data');
const accountStore = process.env.OPENROUTER_KEY_ENC_KEY ?
  createAccountStore({ dataDir, encryptionKey: process.env.OPENROUTER_KEY_ENC_KEY }) : null;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

app.get('/', (_request, response) => response.sendFile(pagePath));
app.get('/guide', (_request, response) => response.sendFile(guidePagePath));
app.get('/admin', (_request, response) => {
  response.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
  response.sendFile(adminPagePath);
});
app.get('/admin.js', (_request, response) => response.sendFile(adminScriptPath));
app.use('/api/admin', createAdminRouter({ store: accountStore, token: process.env.ADMIN_ACCESS_TOKEN }));

app.get('/api/rates/eur', async (_request, response) => {
  try { response.json(await getEurRate()); }
  catch (error) { response.status(503).json({ error: error.message }); }
});

app.post('/api/preview', upload.single('file'), async (request, response) => {
  try {
    if (!request.file) throw new Error('Выберите файл коллекции');
    const parsed = await parseInput(request.file.originalname, request.file.buffer);
    const mapping = suggestMapping(parsed.headers);
    const rows = parsed.rows.slice(0, parsed.type === 'ai-json' ? 300 : 5);
    response.json({ type: parsed.type, headers: parsed.headers, rowCount: parsed.rows.length,
      mapping, priceCurrency: mapping.price ? detectPriceCurrency(mapping.price) : 'RUB',
      rows, warnings: parsed.warnings ?? [] });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.post('/api/convert', upload.single('file'), async (request, response) => {
  try {
    if (!request.file) throw new Error('Выберите файл коллекции');
    const parsed = await parseInput(request.file.originalname, request.file.buffer);
    const mapping = JSON.parse(request.body.mapping ?? '{}');
    const options = JSON.parse(request.body.options ?? '{}');
    const eurRate = options.priceCurrency === 'EUR' ? await getEurRate() : null;
    if (eurRate && options.expectedRateDate && options.expectedRateDate !== eurRate.date) {
      response.status(409).json({ error: 'Курс ЦБ обновился. Обновите предпросмотр и повторите перенос.' });
      return;
    }
    const result = await buildArchive({ parsed, mapping, options, eurRate });
    response.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="dom_collection_transfer.zip"',
      'Cache-Control': 'no-store',
      'X-Photo-Failed-Rows': result.failedPhotos.join(','),
    });
    response.send(Buffer.from(result.archive));
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.use((error, _request, response, _next) => {
  response.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ?
    'Файл больше 8 МБ' : 'Не удалось загрузить файл' });
});

export { app };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(port, '0.0.0.0', () => {
    console.log('Collector transfer service is listening on port ' + port);
  });
}
