const TEST_SITE_KEYS = new Set(['1x00000000000000000000AA', '2x00000000000000000000AB',
  '1x00000000000000000000BB', '2x00000000000000000000BB', '3x00000000000000000000FF']);
const TEST_SECRET_KEYS = new Set(['1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA', '3x0000000000000000000000000000000AA']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const LOCAL_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function privateTransportIp(value) {
  const ip = typeof value === 'string' ? value.replace(/^::ffff:/i, '') : '';
  if (!isIPv4(ip)) return false;
  const [first, second] = ip.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

export class CaptchaError extends Error {
  constructor(message, statusCode = 403) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function createTurnstile({ env = process.env, fetchImpl = fetch } = {}) {
  const siteKey = (env.TURNSTILE_SITE_KEY ?? '').trim();
  const secretKey = (env.TURNSTILE_SECRET_KEY ?? '').trim();
  const testMode = env.TURNSTILE_TEST_MODE === 'true';
  // The local Docker launchers publish only to 127.0.0.1; NAT may change the transport IP.
  const dockerLocalTest = env.TURNSTILE_TEST_DOCKER_LOCAL === 'true';
  const hostnames = [...new Set((env.TURNSTILE_HOSTNAMES ?? '').split(',')
    .map((value) => value.trim().toLowerCase()).filter(Boolean))];
  const dummyKeys = TEST_SITE_KEYS.has(siteKey) || TEST_SECRET_KEYS.has(secretKey);
  const configured = Boolean(siteKey && secretKey && hostnames.length &&
    hostnames.length <= 20 && hostnames.every((host) => /^[a-z0-9.:[\]-]+$/.test(host)) &&
    (testMode ? env.NODE_ENV !== 'production' && TEST_SITE_KEYS.has(siteKey) &&
      TEST_SECRET_KEYS.has(secretKey) && hostnames.every((host) => LOCAL_HOSTS.has(host)) : !dummyKeys));

  return {
    publicConfig() {
      return { configured, siteKey: configured ? siteKey : null, testMode: configured && testMode };
    },
    async verify({ token, action, hostname, ip }) {
      if (!configured) throw new CaptchaError('Проверка человека ещё не настроена. Сборка ZIP временно недоступна.', 503);
      if (typeof token !== 'string' || !token.trim() || token.length > 2048) {
        throw new CaptchaError('Пройдите проверку, что вы человек.');
      }
      if (!hostnames.includes(String(hostname).toLowerCase()) ||
        (testMode && !LOCAL_IPS.has(ip) && !(dockerLocalTest && privateTransportIp(ip)))) {
        throw new CaptchaError('Проверка человека недоступна по этому адресу.');
      }
      let result;
      try {
        const response = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret: secretKey, response: token, remoteip: ip }),
          redirect: 'error', signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error('Siteverify unavailable');
        result = await response.json();
      } catch {
        throw new CaptchaError('Не удалось проверить CAPTCHA. Попробуйте ещё раз немного позже.', 503);
      }
      if (result?.success !== true) {
        throw new CaptchaError('Проверка человека не пройдена или устарела. Пройдите её снова.');
      }
      // Официальные тестовые ключи возвращают фиксированные hostname/action.
      // Они допустимы только при явном тестовом режиме и локальном запросе.
      if (!testMode && (!hostnames.includes(result.hostname) ||
        result.hostname !== String(hostname).toLowerCase() || result.action !== action)) {
        throw new CaptchaError('Проверка человека относится к другой странице. Пройдите её снова.');
      }
    },
  };
}
import { isIPv4 } from 'node:net';
