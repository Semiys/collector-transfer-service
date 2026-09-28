import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const pagePath = path.resolve(currentDirectory, '../public/index.html');

app.get('/', (_request, response) => {
  response.sendFile(pagePath);
});

app.listen(port, '0.0.0.0', () => {
  console.log('Collector transfer service is listening on port ' + port);
});
