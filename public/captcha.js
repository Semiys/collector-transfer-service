(() => {
  let configPromise;
  let scriptPromise;

  async function configuration() {
    configPromise ??= fetch('/api/captcha/config', { cache: 'no-store', signal: AbortSignal.timeout(8000) })
      .then(async (response) => {
        if (!response.ok) throw new Error('Не удалось получить настройки проверки человека.');
        return response.json();
      }).catch((error) => { configPromise = null; throw error; });
    return configPromise;
  }

  function loadScript() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    scriptPromise ??= new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timeout = setTimeout(() => {
        script.remove();
        reject(new Error('Проверка человека не загрузилась. Проверьте интернет и повторите.'));
      }, 15000);
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.onload = () => {
        clearTimeout(timeout);
        if (!window.turnstile) { reject(new Error('Проверка человека не загрузилась.')); return; }
        window.turnstile.ready(() => resolve(window.turnstile));
      };
      script.onerror = () => {
        clearTimeout(timeout); script.remove();
        reject(new Error('Проверка человека недоступна. Проверьте интернет и повторите.'));
      };
      document.head.append(script);
    }).catch((error) => { scriptPromise = null; throw error; });
    return scriptPromise;
  }

  function mount({ container, status, action, onChange = () => {} }) {
    let widgetId;
    let token = '';
    let config;
    let initializing = false;
    let lastTheme;
    let lastSize;
    const changed = (value) => { token = value; onChange(value); };
    function render() {
      if (!window.turnstile || !config?.configured) return;
      const theme = document.documentElement.dataset.theme || 'auto';
      const size = container.clientWidth < 300 ? 'compact' : 'flexible';
      if (widgetId !== undefined) window.turnstile.remove(widgetId);
      lastTheme = theme; lastSize = size;
      changed('');
      status.textContent = 'Пройдите проверку, что вы человек.';
      widgetId = window.turnstile.render(container, {
        sitekey: config.siteKey, action, theme, size, language: 'ru',
        callback: (value) => {
          changed(value);
          status.textContent = config.testMode ? 'Тестовая проверка пройдена. Этот режим только для локальной разработки.' : 'Проверка пройдена.';
        },
        'expired-callback': () => { changed(''); status.textContent = 'Проверка устарела. Пройдите её снова.'; },
        'error-callback': () => {
          changed(''); status.textContent = 'Не удалось пройти проверку. Нажмите «Повторить проверку».';
          return true;
        },
      });
    }
    const themes = new MutationObserver(() => {
      if (widgetId !== undefined && lastTheme !== (document.documentElement.dataset.theme || 'auto')) render();
    });
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const sizes = new ResizeObserver(() => {
      if (widgetId !== undefined && container.clientWidth > 0 &&
        lastSize !== (container.clientWidth < 300 ? 'compact' : 'flexible')) render();
    });
    sizes.observe(container);
    return {
      get token() { return token; },
      async initialize() {
        if (initializing || widgetId !== undefined) return;
        initializing = true;
        status.textContent = 'Загружаю проверку человека…';
        try {
          config = await configuration();
          if (!config.configured) {
            status.textContent = 'Проверка человека ещё не настроена. Обработка временно недоступна.';
            changed(''); return;
          }
          await loadScript(); render();
        } catch (error) { status.textContent = error.message; changed(''); }
        finally { initializing = false; }
      },
      reset() {
        changed('');
        if (widgetId !== undefined) window.turnstile.reset(widgetId);
      },
    };
  }
  window.CollectorCaptcha = { mount };
})();
