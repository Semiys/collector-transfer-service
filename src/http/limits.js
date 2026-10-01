export function rateLimit({ max, windowMs, now = Date.now }) {
  const clients = new Map();
  return (request, response, next) => {
    const ip = request.ip;
    const time = now();
    if (clients.size > 5000) {
      for (const [address, state] of clients) {
        if (state.resetAt <= time) clients.delete(address);
      }
      if (clients.size > 5000) clients.delete(clients.keys().next().value);
    }
    const state = clients.get(ip);
    const current = !state || state.resetAt <= time ? { count: 0, resetAt: time + windowMs } : state;
    current.count += 1;
    clients.set(ip, current);
    if (current.count > max) {
      response.set('Retry-After', String(Math.max(1, Math.ceil((current.resetAt - time) / 1000))));
      response.status(429).json({ error: 'Слишком много запросов. Подождите немного и повторите.' });
      return;
    }
    next();
  };
}

export function concurrencyLimit(max) {
  let active = 0;
  return (_request, response, next) => {
    if (active >= max) {
      response.set('Retry-After', '5');
      response.status(503).json({ error: 'Сервис обрабатывает другие архивы. Повторите через несколько секунд.' });
      return;
    }
    active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
    };
    response.once('finish', release);
    response.once('close', release);
    next();
  };
}
