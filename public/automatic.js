(() => {
  const aiConsent = document.getElementById('automatic-ai-consent');
  const processingConsent = document.getElementById('automatic-processing-consent');
  const switchConsent = document.getElementById('automatic-switch-consent');
  const check = document.getElementById('automatic-check');
  const status = document.getElementById('automatic-status');
  let config;
  let checking = false;
  function update() {
    check.disabled = checking || !config?.aiConfigured || !aiConsent.checked ||
      !processingConsent.checked || !captcha.token;
  }
  const captcha = CollectorCaptcha.mount({ container: document.getElementById('automatic-captcha'),
    status: document.getElementById('automatic-captcha-status'), action: 'collection_prepare', onChange: update });
  function clearConsents() {
    aiConsent.checked = false; processingConsent.checked = false; switchConsent.checked = false;
    update();
  }
  async function loadConditions() {
    config = null; clearConsents();
    try {
      const response = await fetch('/api/automatic/config', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      config = data;
      document.getElementById('automatic-availability').textContent = data.aiConfigured ?
        'Перед скачиванием вы проверите и подтвердите найденные модели.' : 'Автоматическое распознавание пока недоступно.';
      document.getElementById('automatic-owners').textContent = data.owners.length ?
        `Основной участник обработки: ${data.owners[0]}.` : 'Сведения об участниках обработки появятся перед запуском распознавания.';
      document.getElementById('automatic-switch-label').hidden = data.owners.length < 2;
      document.getElementById('automatic-switch-text').textContent = data.owners.length < 2 ? '' :
        `При временной недоступности распознавания разрешаю повторную отправку данных через участников сервиса: ${data.owners.slice(1).join(', ')}.`;
      update();
    } catch (error) {
      document.getElementById('automatic-availability').textContent = 'Не удалось проверить доступность распознавания. Попробуйте позже.';
      document.getElementById('automatic-owners').textContent = 'Не удалось загрузить сведения об обработке. Попробуйте позже.';
      document.getElementById('automatic-switch-label').hidden = true;
    }
  }
  for (const input of [aiConsent, processingConsent, switchConsent]) input.addEventListener('change', update);
  document.getElementById('automatic-captcha-retry').addEventListener('click', () => {
    captcha.reset(); captcha.initialize();
    if (!config) loadConditions();
  });
  check.addEventListener('click', async () => {
    if (check.disabled || checking) return;
    checking = true; update();
    status.className = 'status'; status.textContent = 'Проверяю подтверждения…';
    try {
      const response = await fetch('/api/automatic/check', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ policyVersion: config.policyVersion, routeRevision: config.routeRevision,
          consentToAI: aiConsent.checked, acceptProcessing: processingConsent.checked,
          consentToAccountSwitch: switchConsent.checked, captchaToken: captcha.token }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409) {
          await loadConditions();
          throw new Error('Условия обработки изменились. Ознакомьтесь с ними и подтвердите их снова.');
        }
        if (response.status === 503) throw new Error('Проверка временно недоступна. Попробуйте позже.');
        throw new Error(data.error);
      }
      status.className = 'status success'; status.textContent = data.message;
    } catch (error) {
      status.className = 'status error';
      status.textContent = error.name === 'TimeoutError' ? 'Проверка заняла слишком много времени. Попробуйте снова.' : error.message;
    } finally {
      checking = false; clearConsents(); captcha.reset();
    }
  });
  loadConditions(); captcha.initialize();
})();
