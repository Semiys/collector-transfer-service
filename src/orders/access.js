import { OrderError } from './store.js';

const ACCESS = /^CT1\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{64})$/i;

export function parseOrderAccess(value) {
  if (typeof value !== 'string' || value.length > 512) throw new OrderError('Вставьте полный код доступа к заказу.');
  const match = ACCESS.exec(value.replace(/\s/g, ''));
  if (!match) throw new OrderError('Код заказа имеет неверный формат. Скопируйте его целиком.');
  return { id: match[1].toLowerCase(), accessToken: match[2].toLowerCase() };
}

// Keep access codes out of URLs, logs and persistent browser storage.
export function formatOrderAccess({ id, accessToken }) {
  const canonical = parseOrderAccess(`CT1.${id}.${accessToken}`);
  return `CT1.${canonical.id}.${canonical.accessToken}`;
}
