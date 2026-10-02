import { validDate } from '/transfer/review.js';
import { createOrderReview } from '/order-review.js';
const jobLabels = { queued: 'Ожидает очереди', running: 'Распознаём коллекцию', ready: 'Модели готовы',
  cancelled: 'Обработка остановлена', failed: 'Распознавание не завершилось', expired: 'Срок истёк', consumed: 'Перенос завершён' };

// Code, filename, source and preview exist only in this page's memory.
export function createOrderTransfer({ onOrderChange, onAccessUnavailable }) {
  const get = (id) => document.getElementById(id), root = get('order-transfer');
  const file = get('order-file'), text = get('order-text'), start = get('order-start');
  const ai = get('order-ai-consent'), processing = get('order-processing-consent'), switching = get('order-switch-consent');
  let accessCode = '', order = null, conditions = null, job = null, generation = 0;
  let busy = false, refreshing = false, loadingConditions = false, timer, controller = new AbortController(), requestId = null;
  let previewReady = false, previewGeneration = 0, expiryTimer, downloadController = null, downloadRequestId = null;
  let receipt = null, rate = null, loadingRate = false;
  const downloadUrls = new Map();
  const review = createOrderReview({ onChange: resetDelivery });
  const captcha = window.CollectorCaptcha.mount({ container: get('order-captcha'), status: get('order-captcha-status'),
    action: 'collection_recognize', onChange: controls });
  const zipCaptcha = window.CollectorCaptcha.mount({ container: get('order-zip-captcha'), status: get('order-zip-captcha-status'),
    action: 'collection_order_zip', onChange: controls });
  const active = () => job && ['queued', 'running', 'ready'].includes(job.status);
  function message(value, error = false) {
    get('order-transfer-status').textContent = value;
    get('order-transfer-status').className = error ? 'error' : 'note';
  }
  function controls() {
    const locked = busy || refreshing || loadingConditions || !!active() || !!job?.settling;
    const showSource = !!order?.canRetry && !active() && !job?.settling;
    get('order-source-form').hidden = !showSource;
    get('order-source-help').hidden = !showSource;
    get('order-transfer-title').textContent = job?.status === 'ready' ? 'Результат распознавания' :
      active() || job?.settling ? 'Обработка коллекции' : order?.processingState === 'completed' ? 'Перенос завершён' : 'Добавьте исходник коллекции';
    get('order-source-fields').disabled = locked;
    get('order-consent-fields').disabled = locked;
    start.disabled = locked || !order?.canRetry || !conditions?.aiConfigured || !captcha.token ||
      !ai.checked || !processing.checked || !(file.files.length || text.value.trim());
    get('order-captcha-retry').disabled = busy || refreshing || !!active();
    get('order-conditions-retry').disabled = locked;
    get('order-refresh').disabled = busy || refreshing;
    get('order-cancel').disabled = busy || refreshing || !active() || !!job?.settling;
    get('order-cancel').textContent = job?.status === 'ready' ? 'Удалить результат' : 'Остановить обработку';
    get('order-preview').hidden = job?.status !== 'ready' || previewReady;
    get('order-preview').disabled = busy || refreshing || !!job?.settling;
    const lockReview = busy || refreshing || loadingRate;
    review.setLocked(lockReview);
    get('order-zip-options').disabled = lockReview;
    get('order-zip-confirmations').disabled = lockReview;
    const valid = previewReady && review.snapshot().valid;
    const currency = get('order-currency').value;
    get('order-rate-box').hidden = currency !== 'EUR';
    get('order-rate-refresh').disabled = lockReview;
    get('order-zip-help').textContent = previewReady && !valid ? 'Сначала исправьте отмеченные ошибки в полях моделей.' : '';
    get('order-download').disabled = lockReview || !valid || job?.status !== 'ready' || !currency ||
      !validDate(get('order-date').value) || (currency === 'EUR' && !rate) ||
      !['order-confirm-audit', 'order-confirm-models', 'order-confirm-warnings'].every((id) => get(id).checked) || !zipCaptcha.token;
    get('order-download-stop').hidden = !downloadController;
    get('order-zip-captcha-retry').disabled = lockReview || !previewReady;
    get('order-finish').disabled = lockReview || !receipt || !get('order-download-saved').checked;
    get('order-download-saved').disabled = lockReview;
  }
  function resetReceipt() {
    receipt = null; get('order-saved').hidden = true;
    get('order-download-saved').checked = false; get('order-download-result').textContent = '';
  }
  function resetDelivery() {
    downloadRequestId = null; resetReceipt();
    for (const id of ['order-confirm-audit', 'order-confirm-models', 'order-confirm-warnings']) get(id).checked = false;
    zipCaptcha.reset(); controls();
  }
  function releaseDownloads() {
    for (const [url, timeout] of downloadUrls) { clearTimeout(timeout); URL.revokeObjectURL(url); }
    downloadUrls.clear();
  }
  function clearPreview() {
    previewGeneration += 1; clearTimeout(expiryTimer); downloadController?.abort(); downloadController = null;
    previewReady = false; review.clear(); resetReceipt(); downloadRequestId = null; rate = null; loadingRate = false;
    releaseDownloads();
    for (const id of ['order-currency', 'order-date', 'order-category', 'order-scale']) get(id).value = '';
    for (const id of ['order-confirm-audit', 'order-confirm-models', 'order-confirm-warnings']) get(id).checked = false;
    get('order-rate-status').textContent = ''; zipCaptcha.reset();
    get('order-models').hidden = true;
    for (const id of ['order-warnings', 'order-audit', 'order-model-list']) get(id).replaceChildren();
    get('order-model-count').textContent = '';
  }
  function clearConsents() {
    ai.checked = false; processing.checked = false; switching.checked = false; requestId = null;
    captcha.reset(); controls();
  }
  function clear() {
    generation += 1; clearTimeout(timer); controller.abort(); controller = new AbortController();
    accessCode = ''; order = null; job = null; conditions = null; busy = false; refreshing = false; loadingConditions = false;
    file.value = ''; text.value = ''; root.hidden = true; get('order-job').hidden = true;
    get('order-owners').textContent = ''; get('order-switch-text').textContent = ''; get('order-switch-label').hidden = true;
    for (const id of ['order-job-title', 'order-job-detail', 'order-job-expiry']) get(id).textContent = '';
    clearConsents(); clearPreview(); message('');
  }
  async function request(action, payload = {}, { multipart = false, key } = {}) {
    const headers = { 'X-Order-Code': accessCode.replace(/\s/g, '') };
    if (key) headers['Idempotency-Key'] = key;
    if (!multipart) headers['Content-Type'] = 'application/json';
    const response = await fetch(`/api/orders/transfer/${action}`, { method: 'POST', cache: 'no-store', credentials: 'omit',
      headers, body: multipart ? payload : JSON.stringify(payload),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Не удалось выполнить действие заказа.'), { status: response.status });
    return data;
  }
  async function loadConditions() {
    if (loadingConditions) return;
    const current = generation;
    loadingConditions = true;
    conditions = null; clearConsents(); get('order-owners').textContent = 'Загружаю условия…';
    try {
      const data = await request('conditions');
      if (current !== generation) return;
      conditions = data;
      get('order-owners').textContent = data.owners.length ? `Основной участник обработки: ${data.owners[0]}.` : 'Распознавание временно недоступно.';
      get('order-switch-label').hidden = data.owners.length < 2;
      get('order-switch-text').textContent = data.owners.length < 2 ? '' :
        `При временной недоступности разрешаю повторную отправку данных через участников сервиса: ${data.owners.slice(1).join(', ')}.`;
    } catch (error) { if (current === generation) { get('order-owners').textContent = 'Условия недоступны. Попробуйте обновить их позже.'; message(error.message, true); } }
    finally { if (current === generation) { loadingConditions = false; controls(); } }
  }
  function renderJob() {
    get('order-job').hidden = !job;
    if (!job) return;
    get('order-job-title').textContent = jobLabels[job.status] || 'Проверяем состояние';
    const progress = get('order-job-progress');
    progress.max = job.progress.total || 1;
    if (job.progress.total) progress.value = job.progress.completed;
    else progress.removeAttribute('value');
    progress.hidden = !['queued', 'running'].includes(job.status);
    get('order-job-detail').textContent = job.settling ? 'Обработка останавливается. Дождитесь сохранения статуса перед повтором.' :
      job.error || (job.progress.total ? `Частей: ${job.progress.completed} из ${job.progress.total}. Найдено моделей: ${job.progress.modelCount}.` : 'Задание принято.');
    get('order-job-expiry').textContent = active() ?
      `${job.status === 'ready' ? 'Результат доступен' : 'Обработка ограничена по времени'} до ${new Date(job.expiresAt).toLocaleTimeString('ru-RU')}.` : '';
  }
  async function refresh({ quiet = false } = {}) {
    if (busy || refreshing || !accessCode) return;
    const current = generation;
    refreshing = true; clearTimeout(timer); controls();
    try {
      const data = await request('state');
      if (current !== generation) return;
      order = data.order; onOrderChange(order);
      const next = data.jobs.find((item) => ['queued', 'running', 'ready'].includes(item.status) || item.settling) || data.jobs[0] || null;
      if (next?.id !== job?.id || next?.status !== 'ready') clearPreview();
      job = next; renderJob();
      if (!quiet) message(job ? 'Состояние обновлено.' : order.canRetry ? 'Выберите исходник и подтвердите условия.' : 'Новый запуск сейчас недоступен.');
      if (order.canRetry && !active() && !job?.settling && !conditions) {
        await loadConditions();
        if (current !== generation) return;
        void captcha.initialize();
      }
      if (!document.hidden && (job?.settling || active())) timer = setTimeout(() => refresh({ quiet: true }), 5000);
    } catch (error) {
      if (current !== generation) return;
      message(error.message, true);
      if (error.status === 402 || error.status === 404) { clear(); onAccessUnavailable(error.message); }
      // Network failures never trigger another AI request. Retry only the status.
      else if (!document.hidden) timer = setTimeout(() => refresh({ quiet: true }), 10000);
    } finally { if (current === generation) { refreshing = false; controls(); } }
  }
  async function open(input) {
    clear();
    if (!input.processingAvailable || input.order.paymentState !== 'paid') return;
    accessCode = input.code; order = input.order; root.hidden = false; controls();
    await refresh();
  }
  for (const input of [file, text]) input.addEventListener(input === file ? 'change' : 'input', () => {
    if (input === file && file.files.length) text.value = '';
    if (input === text && text.value) file.value = '';
    clearConsents(); message('Исходник изменён. Подтвердите условия снова.');
  });
  for (const input of [ai, processing, switching]) input.addEventListener('change', () => { requestId = null; captcha.reset(); controls(); });
  get('order-conditions-retry').addEventListener('click', () => { if (!busy && !refreshing) void loadConditions(); });
  get('order-captcha-retry').addEventListener('click', () => { captcha.reset(); void captcha.initialize(); });
  get('order-refresh').addEventListener('click', () => { if (!busy) void refresh(); });
  get('order-source-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (start.disabled || busy) return;
    const current = generation;
    const form = new FormData();
    if (file.files.length) {
      const source = file.files[0];
      if (source.size > 8 * 1024 * 1024 || !/\.(csv|xlsx|json|txt)$/i.test(source.name) || source.name.length > 200) {
        message('Нужен CSV, XLSX, JSON или TXT до 8 МБ с именем до 200 символов.', true); return;
      }
      form.append('file', source);
    } else form.append('text', text.value);
    form.append('policyVersion', conditions.policyVersion); form.append('routeRevision', conditions.routeRevision);
    form.append('consentToAI', String(ai.checked)); form.append('acceptProcessing', String(processing.checked));
    form.append('consentToAccountSwitch', String(switching.checked)); form.append('captchaToken', captcha.token);
    requestId ??= crypto.randomUUID(); busy = true; controls(); message('Загружаю исходник…');
    try {
      const data = await request('start', form, { multipart: true, key: requestId });
      if (current !== generation) return;
      order = data.order; job = data.job; onOrderChange(order); file.value = ''; text.value = ''; renderJob();
      message('Задание принято. Можно следить за обработкой ниже.');
    } catch (error) {
      if (current !== generation) return;
      message(error.status ? error.message : 'Связь прервалась. Обновите состояние: задание могло быть принято. Не загружайте коллекцию повторно до проверки.', true);
      if (error.status === 409) await loadConditions();
    } finally {
      if (current === generation) { busy = false; captcha.reset(); controls(); void refresh({ quiet: true }); }
    }
  });
  get('order-cancel').addEventListener('click', async () => {
    if (busy || !active() || job.settling) return;
    if (!window.confirm(job.status === 'ready' ? 'Удалить распознанные модели? Для повтора понадобится исходник.' : 'Остановить распознавание? Уже начатая попытка будет учтена.')) return;
    const current = generation; busy = true; controls(); clearPreview();
    try {
      const data = await request('cancel', { jobId: job.id });
      if (current !== generation) return;
      job = data.job; renderJob(); message('Запрошена остановка. Повтор станет доступен после завершения текущей работы.');
    } catch (error) { if (current === generation) message(error.message, true); }
    finally { if (current === generation) { busy = false; controls(); void refresh({ quiet: true }); } }
  });
  get('order-preview').addEventListener('click', async () => {
    if (busy || job?.status !== 'ready') return;
    const current = generation; busy = true; controls(); message('Открываю модели…');
    try {
      const data = await request('preview', { jobId: job.id });
      if (current !== generation) return;
      clearPreview();
      review.setData(data); const rows = review.snapshot().rows;
      get('order-model-count').textContent = `Найдено моделей: ${rows.length}. Валюта цены: ${data.priceCurrency || 'не определена'}.`;
      for (const warning of data.warnings ?? []) {
        const p = document.createElement('p'); p.textContent = warning.text; get('order-warnings').append(p);
      }
      const audit = data.audit;
      const summary = document.createElement('p');
      summary.textContent = `Исходных строк: ${audit.sourceCount}; привязано к моделям: ${audit.assignedCount}. ${audit.numbering}`;
      get('order-audit').append(summary);
      for (const item of audit.modelSources) {
        const p = document.createElement('p'); p.textContent = `Модель ${item.model}: ${item.name}. Строки: ${item.sourceIds.join(', ')}.`; get('order-audit').append(p);
      }
      for (const item of audit.unassigned) {
        const p = document.createElement('p'); p.textContent = `Строка ${item.sourceId} без модели: ${item.text}`; get('order-audit').append(p);
      }
      previewReady = true; get('order-currency').value = ['RUB', 'EUR'].includes(data.priceCurrency) ? data.priceCurrency : '';
      get('order-date').value = new Date().toISOString().slice(0, 10);
      // Clear even an open editor or a slow download at the server's result deadline.
      expiryTimer = setTimeout(() => {
        clearPreview(); message('Срок результата истёк. Обновите состояние заказа.', true); controls(); void refresh({ quiet: true });
      }, Math.max(0, data.expiresAt - Date.now()));
      void zipCaptcha.initialize();
      get('order-models').hidden = false; get('order-models-title').focus({ preventScroll: true }); message('Результат открыт. Проверьте модели и исходные строки.');
    } catch (error) { if (current === generation) message(error.message, true); }
    finally { if (current === generation) { busy = false; controls(); } }
  });
  for (const id of ['order-currency', 'order-date', 'order-category', 'order-scale']) {
    get(id).addEventListener(id === 'order-category' ? 'input' : 'change', resetDelivery);
  }
  for (const id of ['order-confirm-audit', 'order-confirm-models', 'order-confirm-warnings']) {
    get(id).addEventListener('change', () => { zipCaptcha.reset(); controls(); });
  }
  get('order-zip-captcha-retry').addEventListener('click', () => { zipCaptcha.reset(); void zipCaptcha.initialize(); });
  get('order-download-saved').addEventListener('change', controls);
  get('order-rate-refresh').addEventListener('click', async () => {
    if (busy || refreshing || loadingRate || !previewReady) return;
    const current = generation, version = previewGeneration;
    rate = null; loadingRate = true; resetDelivery(); get('order-rate-status').textContent = 'Проверяю курс…';
    try {
      const response = await fetch('/api/rates/eur', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
      const data = await response.json();
      if (!response.ok || !Number.isFinite(data.rubPerEuro) || data.rubPerEuro <= 0 || !/^\d{2}\.\d{2}\.\d{4}$/.test(data.date ?? '')) throw new Error('Курс ЦБ недоступен. Повторите позже.');
      if (current !== generation || version !== previewGeneration) return;
      rate = data; get('order-rate-status').textContent = `1 € = ${data.rubPerEuro.toLocaleString('ru-RU')} ₽. Курс на ${data.date}.`;
    } catch (error) { if (current === generation && version === previewGeneration) get('order-rate-status').textContent = error.message; }
    finally { if (current === generation && version === previewGeneration) { loadingRate = false; controls(); } }
  });
  get('order-download-stop').addEventListener('click', () => downloadController?.abort());
  get('order-download').addEventListener('click', async () => {
    if (get('order-download').disabled) return;
    const current = generation, version = previewGeneration, selectedJob = job.id;
    const options = { priceCurrency: get('order-currency').value, defaultCategory: get('order-category').value,
      defaultScale: get('order-scale').value, transferDate: get('order-date').value, acceptTextWarnings: true,
      ...(get('order-currency').value === 'EUR' ? { expectedRateDate: rate.date } : {}) };
    const payload = { jobId: selectedJob, confirmedAudit: true, confirmedModels: true, options,
      edits: review.snapshot().edits, captchaToken: zipCaptcha.token };
    downloadRequestId ??= crypto.randomUUID();
    const connection = new AbortController(); downloadController = connection; busy = true; clearTimeout(timer); resetReceipt(); controls();
    message('Собираю ZIP и загружаю его. Не закрывайте вкладку.');
    try {
      // Server assembly has its own two-minute deadline; allow time for a slow file download too.
      const response = await fetch('/api/orders/transfer/build', { method: 'POST', cache: 'no-store', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', 'X-Order-Code': accessCode.replace(/\s/g, ''), 'Idempotency-Key': downloadRequestId },
        body: JSON.stringify(payload), signal: AbortSignal.any([controller.signal, connection.signal, AbortSignal.timeout(20 * 60_000)]) });
      if (!response.ok) { const data = await response.json(); throw Object.assign(new Error(data.error || 'Не удалось скачать ZIP.'), { status: response.status }); }
      const confirmation = response.headers.get('X-Order-Receipt');
      if (!/^[0-9a-f]{64}$/.test(confirmation ?? '') || !response.headers.get('Content-Type')?.startsWith('application/zip')) throw new Error('Сервис вернул неожиданный файл. Повторите скачивание.');
      const blob = await response.blob();
      if (current !== generation || version !== previewGeneration || connection.signal.aborted) return;
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = 'dom_collection_transfer.zip'; document.body.append(link); link.click(); link.remove();
      downloadUrls.set(url, setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.delete(url); }, 60000));
      receipt = { jobId: selectedJob, value: confirmation }; get('order-saved').hidden = false;
      const failed = response.headers.get('X-Photo-Failed-Rows') || '';
      get('order-download-result').textContent = 'Файл передан браузеру. Проверьте папку загрузок.' +
        (failed ? ` Вместо недоступных фото добавлены изображения по умолчанию. Строки: ${failed}.` : '');
      message('ZIP передан браузеру. Заказ остаётся открытым до вашего подтверждения.');
    } catch (error) {
      if (current !== generation || version !== previewGeneration) return;
      message(connection.signal.aborted ? 'Скачивание отменено. Модели остались доступны до окончания срока. Можно повторить без нового распознавания.' :
        error.status ? error.message : 'Не удалось загрузить ZIP. Проверьте соединение и повторите скачивание.', true);
    } finally {
      if (current === generation) {
        downloadController = null; busy = false; zipCaptcha.reset(); controls(); void refresh({ quiet: true });
      }
    }
  });
  get('order-finish').addEventListener('click', async () => {
    if (get('order-finish').disabled) return;
    const current = generation; busy = true; controls(); message('Сохраняю завершение заказа…');
    try {
      const data = await request('confirm-saved', { jobId: receipt.jobId, receipt: receipt.value, downloadSaved: true });
      if (current !== generation) return;
      order = data.order; job = { ...job, status: 'consumed', settling: false }; clearPreview(); onOrderChange(order); renderJob();
      message('Заказ завершён. Распознанные модели удалены с сервера; архив остаётся на вашем устройстве.');
    } catch (error) {
      if (current === generation) message(error.status ? error.message : 'Связь прервалась. Обновите состояние заказа: подтверждение могло сохраниться.', true);
    } finally { if (current === generation) { busy = false; controls(); void refresh({ quiet: true }); } }
  });
  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    if (!document.hidden && accessCode && !busy) void refresh({ quiet: true });
  });
  window.addEventListener('pagehide', clear);
  return { open, clear };
}
