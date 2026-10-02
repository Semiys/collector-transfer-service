(() => {
  const get = (id) => document.getElementById(id);
  const form = get('job-form'), account = get('job-account'), fallback = get('job-fallback');
  const message = get('job-message'), jobsStatus = get('jobs-status'), list = get('jobs-list');
  const states = { queued: 'В очереди', running: 'Распознаётся', ready: 'Готово к проверке',
    failed: 'Ошибка', cancelled: 'Отменено', expired: 'Время истекло', consumed: 'Передано в предпросмотр' };
  let availableAccounts = [], requestId = crypto.randomUUID(), submitting = false;
  let timer = null, expiryTimer = null, loading = false, signature = '', selectedResult = null, selectedJob = null;

  function reserves() {
    const primary = availableAccounts.find((item) => item.id === account.value && item.enabled);
    if (!primary) return [];
    const owners = new Set([primary.owner.trim().toLocaleLowerCase('ru')]);
    return availableAccounts.filter((item) => {
      const owner = item.owner.trim().toLocaleLowerCase('ru');
      if (!item.enabled || owners.has(owner)) return false;
      owners.add(owner); return true;
    }).slice(0, 2);
  }
  function resetConsent() {
    requestId = crypto.randomUUID();
    get('job-consent').checked = false; fallback.checked = false;
    const others = reserves(); fallback.disabled = !others.length;
    get('job-fallback-label').textContent = others.length ?
      `Разрешаю для всех частей этого задания повторную отправку через Groq с ключами: ${others.map((item) => `${item.owner} (${item.label})`).join(', ')}. Переключение возможно только после ограничения частоты основного ключа. Ключи одной организации используют общие лимиты.` :
      'Нет резервных ключей других владельцев. Используется только выбранный основной ключ.';
  }
  document.addEventListener('collector-accounts', (event) => {
    availableAccounts = event.detail;
    const previous = account.value;
    account.replaceChildren(new Option('Выберите включённый ключ', ''));
    availableAccounts.filter((item) => item.enabled).forEach((item) => account.append(new Option(`${item.label} — ${item.owner}`, item.id)));
    if ([...account.options].some((item) => item.value === previous)) account.value = previous;
    resetConsent(); refresh();
  });
  account.addEventListener('change', resetConsent);
  get('job-file').addEventListener('change', resetConsent);
  get('job-text').addEventListener('input', resetConsent);
  fallback.addEventListener('change', () => { requestId = crypto.randomUUID(); });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting) return;
    const file = get('job-file').files[0], text = get('job-text').value;
    if ((!file && !text.trim()) || (file && text.trim())) { message.textContent = 'Выберите файл или вставьте текст, не оба сразу.'; return; }
    if (file?.size > 8 * 1024 * 1024) { message.textContent = 'Файл больше 8 МБ.'; return; }
    const body = new FormData();
    if (file) body.append('file', file); else body.append('text', text);
    body.append('accountId', account.value);
    body.append('consentToAI', String(get('job-consent').checked));
    body.append('consentToAccountSwitch', String(fallback.checked));
    body.append('fallbackAccountIds', JSON.stringify(fallback.checked ? reserves().map((item) => item.id) : []));
    submitting = true;
    const controls = [...form.elements].map((element) => [element, element.disabled]);
    controls.forEach(([element]) => { element.disabled = true; });
    message.textContent = 'Создаю задание…'; message.className = '';
    try {
      const response = await fetch('/api/admin/jobs', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'X-CSRF-Token': csrfToken, 'Idempotency-Key': requestId }, body });
      const result = await response.json();
      if (response.status === 401) { location.assign('/admin/login'); return; }
      if (!response.ok) throw new Error(result.error ?? 'Не удалось создать задание.');
      message.textContent = `Задание ${result.job.id.slice(0, 8)} принято. Прогресс появится ниже.`;
      message.className = 'success';
      get('job-file').value = ''; get('job-text').value = '';
      get('job-consent').checked = false; fallback.checked = false;
      await refresh();
    } catch (error) {
      message.textContent = `${error.message} При потере связи повторите отправку без изменения исходника: второе задание не создастся.`;
      message.className = 'error';
    } finally {
      submitting = false;
      controls.forEach(([element, disabled]) => { element.disabled = disabled; });
    }
  });

  function clearResult() {
    clearTimeout(expiryTimer);
    selectedResult = null; selectedJob = null;
    get('job-result').hidden = true; get('job-audit-accept').checked = false; get('job-review').disabled = true;
    for (const id of ['job-model-sources', 'job-unassigned', 'job-diagnostics']) get(id).replaceChildren();
  }
  const line = (parent, text) => { const element = document.createElement('p'); element.textContent = text; parent.append(element); };
  function button(title, action) {
    const element = document.createElement('button'); element.type = 'button'; element.className = 'secondary'; element.textContent = title;
    element.addEventListener('click', async () => {
      element.disabled = true;
      try { await action(); }
      catch (error) { jobsStatus.textContent = error.message; jobsStatus.className = 'error'; }
      finally { element.disabled = false; }
    });
    return element;
  }
  async function showResult(job) {
    clearResult();
    const result = await adminRequest('GET', `/jobs/${job.id}/result`);
    selectedResult = result; selectedJob = job;
    expiryTimer = setTimeout(() => {
      clearResult(); jobsStatus.textContent = 'Срок результата истёк. Создайте задание заново.';
    }, Math.max(0, job.expiresAt - Date.now()));
    const audit = result.audit;
    get('job-audit-summary').textContent = `Исходных непустых строк: ${audit.sourceCount}. Связано с моделями: ${audit.assignedCount}. Строк без модели: ${audit.unassigned.length}. Моделей: ${result.models.length}. ${audit.numbering} Даже полная сверка не гарантирует правильность полей.`;
    audit.modelSources.forEach((item) => line(get('job-model-sources'), `${item.model}. ${item.name} — строки ${item.sourceIds.join(', ')}`));
    audit.unassigned.forEach((item) => line(get('job-unassigned'), `Строка ${item.sourceId} · ${item.kind === 'section' ? 'заголовок' : 'требует проверки'}\n${item.text}\nПричина: ${item.reason}`));
    if (!audit.unassigned.length) line(get('job-unassigned'), 'Все строки связаны с моделями.');
    get('job-unassigned-details').open = audit.unassigned.some((item) => item.kind === 'other');
    result.warnings.forEach((item) => line(get('job-diagnostics'), item));
    result.diagnostics.forEach((item) => line(get('job-diagnostics'), `Часть ${item.part}: ${item.modelUsed}; ${item.keyUsed.label} (${item.keyUsed.owner})${item.fallbackUsed ? ', резервный ключ' : ''}.`));
    get('job-result').hidden = false;
    get('job-result').scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  function render(jobs) {
    list.replaceChildren();
    jobs.forEach((job) => {
      const card = document.createElement('article'); card.className = 'job-card';
      const title = document.createElement('h3'); title.textContent = `${job.id.slice(0, 8)} · ${states[job.status] ?? job.status}`;
      card.append(title);
      const progress = document.createElement('progress'); progress.max = job.progress.total || 1; progress.value = job.progress.completed;
      card.append(progress);
      line(card, `Части: ${job.progress.completed}/${job.progress.total || '…'}. Исходных строк: ${job.progress.sourceCount}. Распознано моделей: ${job.progress.modelCount}.`);
      if (job.status === 'running' && job.progress.retryAt) {
        line(card, `Временный лимит запросов. Часть ${job.progress.retryPart} повторится автоматически не раньше ${new Date(job.progress.retryAt).toLocaleTimeString('ru-RU')}. Повтор ${job.progress.retryAttempt} из 2. Готовые части остаются в памяти; можно отменить задание.`);
      }
      if (['queued', 'running', 'ready'].includes(job.status)) line(card, `Доступно до ${new Date(job.expiresAt).toLocaleTimeString('ru-RU')}.`);
      if (job.error) line(card, job.error);
      const actions = document.createElement('div'); actions.className = 'actions';
      if (['queued', 'running', 'ready'].includes(job.status)) actions.append(button(job.status === 'ready' ? 'Удалить результат' : 'Отменить', async () => {
        await adminRequest('POST', `/jobs/${job.id}/cancel`);
        if (selectedJob?.id === job.id) clearResult();
        await refresh();
      }));
      if (job.status === 'ready') actions.append(button('Открыть сверку', () => showResult(job)));
      card.append(actions); list.append(card);
    });
  }
  async function refresh() {
    if (loading || !csrfToken) return;
    clearTimeout(timer); loading = true;
    let delay = 5000;
    try {
      const { jobs } = await adminRequest('GET', '/jobs');
      const current = JSON.stringify(jobs);
      if (current !== signature) { render(jobs); signature = current; }
      if (selectedJob && !jobs.some((item) => item.id === selectedJob.id && item.status === 'ready')) clearResult();
      jobsStatus.textContent = jobs.length ? `Заданий: ${jobs.length}. Список обновляется автоматически.` : 'Заданий пока нет. Загрузите исходник выше.';
      jobsStatus.className = '';
      delay = jobs.some((item) => ['queued', 'running'].includes(item.status)) ? 2000 :
        jobs.some((item) => item.status === 'ready') ? 5000 : 0;
    } catch (error) { jobsStatus.textContent = error.message; jobsStatus.className = 'error'; }
    finally {
      loading = false;
      if (delay && !document.hidden) timer = setTimeout(refresh, delay);
    }
  }
  get('jobs-refresh').addEventListener('click', refresh);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else refresh(); });
  get('job-audit-accept').addEventListener('change', () => { get('job-review').disabled = !selectedResult || !get('job-audit-accept').checked; });
  get('job-review').addEventListener('click', async () => {
    if (!selectedResult || !selectedJob || !get('job-audit-accept').checked) return;
    const button = get('job-review'); button.disabled = true;
    try {
      if (Date.now() >= selectedJob.expiresAt) throw new Error('Срок результата истёк. Создайте задание заново.');
      const { transferSource, models, warnings, priceCurrency } = selectedResult;
      sessionStorage.setItem('collector-ai-import', JSON.stringify({ transferSource, models, warnings, priceCurrency }));
      await adminRequest('POST', `/jobs/${selectedJob.id}/consume`);
      clearResult(); location.assign('/');
    } catch (error) {
      sessionStorage.removeItem('collector-ai-import'); jobsStatus.textContent = error.message; jobsStatus.className = 'error';
      button.disabled = !selectedResult;
    }
  });
  // Account loading in admin.js emits the event after the session is ready.
  if (csrfToken) { availableAccounts = accountsCache; document.dispatchEvent(new CustomEvent('collector-accounts', { detail: accountsCache })); }
})();
