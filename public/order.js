import { createOrderTransfer } from '/order-transfer.js';

(() => {
  const get = (id) => document.getElementById(id);
  const code = get('order-code'), check = get('order-check'), show = get('order-show');
  const status = get('order-status'), result = get('order-result'), retry = get('order-config-retry');
  const payments = { pending: 'Ожидается оплата', paid: 'Оплата подтверждена', cancelled: 'Оплата отменена',
    refund_pending: 'Возврат обрабатывается', refunded: 'Возврат подтверждён' };
  const processing = { idle: 'Ещё не запускался', running: 'Идёт распознавание', ready: 'Модели готовы к проверке',
    completed: 'Перенос завершён', failed: 'Обработка не завершилась', interrupted: 'Прерван перезапуском сервера' };
  let available = false, busy = false, initializing = false, version = 0, controller = null;
  const transfer = createOrderTransfer({ onOrderChange: (order) => renderOrder(order, true),
    onAccessUnavailable: (message) => { clearResult(); status.className = 'error'; status.textContent = message; } });
  function controls() {
    code.disabled = busy || !available;
    check.disabled = busy || !available || !code.value.trim();
    show.disabled = busy || !available || !code.value;
  }
  function hideCode() { code.type = 'password'; show.textContent = 'Показать код'; show.setAttribute('aria-pressed', 'false'); }
  function clearResult() { transfer.clear(); result.hidden = true; for (const id of ['order-number', 'order-price', 'order-payment', 'order-processing', 'order-updated', 'order-next']) get(id).textContent = ''; }
  function renderOrder(order, processingAvailable) {
    get('order-number').textContent = `Номер: ${order.id}`;
    get('order-price').textContent = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' }).format(order.amountMinor / 100);
    get('order-payment').textContent = payments[order.paymentState];
    get('order-processing').textContent = processing[order.processingState];
    get('order-updated').textContent = new Date(order.updatedAt).toLocaleString('ru-RU');
    get('order-next').textContent = order.processingState === 'completed' ?
      'Перенос завершён по вашему подтверждению. Результат удалён с сервера; используйте сохранённый ZIP.' :
      order.processingState === 'interrupted' ?
      'Для повтора загрузите исходник снова. Сведения об оплате сохраняются.' :
      order.canRetry && processingAvailable ? 'Можно загрузить коллекцию в форме ниже.' :
      order.canRetry ? 'Запуск сейчас недоступен. Попробуйте позже.' :
      order.processingState === 'ready' ? processingAvailable ? 'Модели готовы. Откройте результат ниже, пока не истёк срок.' : 'Модели готовы, но просмотр сейчас недоступен.' :
        'Состояние можно проверить снова этой же кнопкой.';
  }
  function reset() {
    version += 1; controller?.abort(); controller = null; busy = false;
    code.value = ''; hideCode(); clearResult(); status.className = ''; status.textContent = ''; controls();
  }
  async function initialize() {
    if (initializing) return;
    initializing = true;
    available = false; controls(); retry.hidden = true;
    status.className = ''; status.textContent = 'Проверяю доступность…';
    try {
      const response = await fetch('/api/orders/config', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(8000) });
      const config = await response.json();
      if (!response.ok || !config.lookupAvailable) throw new Error();
      available = true; status.textContent = 'Вставьте код доступа к своему заказу.';
    } catch {
      status.className = 'error'; status.textContent = 'Проверка заказов пока недоступна. Попробуйте позже.'; retry.hidden = false;
    } finally { initializing = false; controls(); }
  }
  code.addEventListener('input', () => { clearResult(); status.textContent = ''; status.className = ''; controls(); });
  show.addEventListener('click', () => {
    if (code.type === 'password') { code.type = 'text'; show.textContent = 'Скрыть код'; show.setAttribute('aria-pressed', 'true'); }
    else hideCode();
  });
  get('order-clear').addEventListener('click', reset);
  retry.addEventListener('click', initialize);
  get('order-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy || check.disabled) return;
    const current = ++version, accessCode = code.value;
    controller = new AbortController();
    const requestController = controller;
    busy = true; hideCode(); clearResult(); controls(); status.className = ''; status.textContent = 'Проверяю заказ…';
    try {
      const response = await fetch('/api/orders/status', { method: 'POST', cache: 'no-store', credentials: 'omit',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.any([requestController.signal, AbortSignal.timeout(12000)]),
        body: JSON.stringify({ code: accessCode }) });
      const data = await response.json();
      if (current !== version) return;
      if (!response.ok) { status.className = 'error'; status.textContent = data.error || 'Не удалось проверить заказ.'; return; }
      const order = data.order;
      if (!order || !Number.isSafeInteger(order.amountMinor) || order.currency !== 'RUB' ||
          !payments[order.paymentState] || !processing[order.processingState]) throw new Error();
      renderOrder(order, data.processingAvailable);
      result.hidden = false; status.className = 'success'; status.textContent = 'Заказ найден.';
      get('order-result-title').focus({ preventScroll: true });
      void transfer.open({ code: accessCode, order, processingAvailable: data.processingAvailable });
    } catch {
      if (current !== version) return;
      status.className = 'error'; status.textContent = 'Не удалось связаться с сервисом. Проверьте соединение и повторите.';
    } finally {
      if (current === version) { busy = false; controller = null; controls(); }
    }
  });
  window.addEventListener('pagehide', reset);
  initialize();
})();
