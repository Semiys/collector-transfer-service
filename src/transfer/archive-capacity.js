export class ArchiveBusyError extends Error {
  constructor() { super('Сервис обрабатывает другие архивы. Повторите через несколько секунд.'); this.statusCode = 503; }
}

// Shared by the free HTTP path and the internal paid builder. A disconnected
// browser does not free a slot while photo decoding or ZIP work is still active.
export function createArchiveCapacity({ maxActive = 2, timeoutMs = 120_000 } = {}) {
  let active = 0;
  function acquire() {
    if (active >= maxActive) throw new ArchiveBusyError();
    active += 1;
    let released = false;
    return () => { if (!released) { released = true; active -= 1; } };
  }
  return {
    async run(work, { signal } = {}) {
      const release = acquire();
      const deadline = AbortSignal.timeout(timeoutMs);
      try { return await work(signal ? AbortSignal.any([signal, deadline]) : deadline); }
      finally { release(); }
    },
    middleware(_request, response, next) {
      let release;
      try { release = acquire(); }
      catch (error) { response.set('Retry-After', '5').status(503).json({ error: error.message }); return; }
      const controller = new AbortController();
      let running = false, finished = false;
      response.locals.runArchiveTask = async (work) => {
        controller.signal.throwIfAborted();
        running = true;
        try { return await work(AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)])); }
        finally { running = false; if (finished) release(); }
      };
      const end = () => { finished = true; if (!running) release(); };
      response.once('finish', end);
      response.once('close', () => { if (!response.writableFinished) controller.abort(); end(); });
      next();
    },
  };
}
