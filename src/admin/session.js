import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';

const COOKIE_NAME = 'collector_admin_session';
const SESSION_MS = 12 * 60 * 60_000;
const ATTEMPT_MS = 15 * 60_000;
const MAX_FAILURES = 5;

function equalSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sessionId(request) {
  const cookie = request.get('Cookie')?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));
  const value = cookie?.slice(COOKIE_NAME.length + 1);
  return /^[a-f0-9]{64}$/.test(value ?? '') ? value : null;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function createAdminSession({ adminCode, secureCookie = false, now = Date.now }) {
  const sessions = new Map();
  const attempts = new Map();
  const configured = typeof adminCode === 'string' && adminCode.length >= 32;
  const router = express.Router();
  router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  router.use(express.json({ limit: '2kb' }));

  function current(request) {
    const id = sessionId(request);
    if (!id) return null;
    const key = digest(id);
    const session = sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= now()) {
      sessions.delete(key);
      return null;
    }
    return { key, ...session };
  }

  function requireApi(request, response, next) {
    if (!configured) {
      response.status(503).json({ error: 'Админ-панель не настроена на сервере' });
      return;
    }
    const session = current(request);
    if (!session) {
      response.status(401).json({ error: 'Войдите в админ-панель' });
      return;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
        !equalSecret(request.get('X-CSRF-Token'), session.csrfToken)) {
      response.status(403).json({ error: 'Обновите страницу и повторите действие' });
      return;
    }
    next();
  }

  function requirePage(request, response, next) {
    response.set('Cache-Control', 'no-store');
    if (!configured) {
      response.status(503).send('Админ-панель не настроена на сервере');
    } else if (!current(request)) {
      response.redirect(303, '/admin/login');
    } else {
      next();
    }
  }

  router.get('/', (request, response) => {
    const session = current(request);
    if (!session) {
      response.status(401).json({ error: 'Войдите в админ-панель' });
      return;
    }
    response.json({ authenticated: true, csrfToken: session.csrfToken });
  });

  router.post('/', (request, response) => {
    if (!configured) {
      response.status(503).json({ error: 'Админ-панель не настроена на сервере' });
      return;
    }
    const ip = request.ip;
    if (attempts.size > 5000) {
      for (const [address, times] of attempts) {
        if (times.every((time) => now() - time >= ATTEMPT_MS)) attempts.delete(address);
      }
      if (attempts.size > 5000) attempts.delete(attempts.keys().next().value);
    }
    const recent = (attempts.get(ip) ?? []).filter((time) => now() - time < ATTEMPT_MS);
    attempts.set(ip, recent);
    if (recent.length >= MAX_FAILURES) {
      response.status(429).json({ error: 'Слишком много попыток входа. Повторите через 15 минут.' });
      return;
    }
    if (!equalSecret(request.body?.code, adminCode)) {
      recent.push(now());
      response.status(401).json({ error: 'Неверный админ-код' });
      return;
    }
    attempts.delete(ip);
    const id = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');
    sessions.set(digest(id), { csrfToken, expiresAt: now() + SESSION_MS });
    if (sessions.size > 100) sessions.delete(sessions.keys().next().value);
    const secure = secureCookie || request.secure ? '; Secure' : '';
    response.set('Set-Cookie', `${COOKIE_NAME}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`);
    response.json({ authenticated: true });
  });

  router.delete('/', (request, response) => {
    const session = current(request);
    if (!session) {
      response.status(401).json({ error: 'Войдите в админ-панель' });
      return;
    }
    if (!equalSecret(request.get('X-CSRF-Token'), session.csrfToken)) {
      response.status(403).json({ error: 'Обновите страницу и повторите действие' });
      return;
    }
    sessions.delete(session.key);
    const secure = secureCookie || request.secure ? '; Secure' : '';
    response.set('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
    response.json({ authenticated: false });
  });

  return { router, requireApi, requirePage, isAuthenticated: (request) => !!current(request) };
}
