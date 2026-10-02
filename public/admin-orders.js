(() => {
  const get = (id) => document.getElementById(id);
  const list = get('orders-list'), status = get('orders-status'), message = get('orders-message');
  const create = get('order-create'), refreshButton = get('orders-refresh');
  const previous = get('orders-previous'), next = get('orders-next');
  const paymentStates = { pending: 'Ожидает оплаты', paid: 'Оплата подтверждена', cancelled: 'Оплата отменена',
    refund_pending: 'Возврат обрабатывается', refunded: 'Деньги возвращены' };
  const processingStates = { idle: 'Не запускалась', running: 'Обрабатывается', ready: 'Результат в памяти',
    completed: 'Перенос завершён', failed: 'Нужен повтор', interrupted: 'Прервано перезапуском' };
  let offset = 0, loading = false, creating = false, deleting = false, requestId = crypto.randomUUID();

  function text(parent, value) {
    const paragraph = document.createElement('p'); paragraph.textContent = value; parent.append(paragraph);
  }
  function controls() {
    const busy = creating || loading || deleting;
    create.disabled = busy || !csrfToken;
    refreshButton.disabled = busy || !csrfToken;
    previous.disabled = busy; next.disabled = busy;
    for (const button of list.querySelectorAll('button')) button.disabled = busy;
  }
  function render(orders) {
    list.replaceChildren();
    for (const order of orders) {
      const card = document.createElement('article'); card.className = 'order-card';
      const title = document.createElement('h3'); title.textContent = `Заказ ${order.id.slice(0, 8)}`; card.append(title);
      text(card, order.id);
      text(card, `${(order.amountMinor / 100).toLocaleString('ru-RU')} ₽ · ${paymentStates[order.paymentState] ?? 'Неизвестный статус'}`);
      text(card, `Обработка: ${processingStates[order.processingState] ?? 'Неизвестный статус'}. Попыток: ${order.attempts}. Осталось: ${order.attemptsRemaining}.`);
      text(card, `Создан ${new Date(order.createdAt).toLocaleString('ru-RU')}`);
      if (order.canRetry) text(card, 'Можно повторить перенос по этому заказу без нового платежа.');
      if (order.paymentState === 'pending' && !order.paymentLinked) {
        const remove = document.createElement('button'); remove.className = 'secondary'; remove.type = 'button';
        remove.textContent = 'Удалить черновик'; remove.setAttribute('aria-label', `Удалить черновик ${order.id.slice(0, 8)}`);
        remove.addEventListener('click', async () => {
          if (creating || loading || deleting) return;
          deleting = true; controls();
          try {
            await adminRequest('DELETE', `/orders/${order.id}`);
            message.textContent = `Черновик ${order.id.slice(0, 8)} удалён.`; message.className = 'success';
            await refresh();
          } catch (error) { message.textContent = error.message; message.className = 'error'; }
          finally { deleting = false; controls(); }
        });
        card.append(remove);
      }
      list.append(card);
    }
  }
  async function refresh() {
    if (!csrfToken || loading) return;
    loading = true; controls(); status.className = ''; status.textContent = 'Загружаю заказы…';
    try {
      let result = await adminRequest('GET', `/orders?offset=${offset}`);
      if (!result.orders.length && offset > 0) {
        offset = Math.max(0, Math.floor((result.total - 1) / 20) * 20);
        result = await adminRequest('GET', `/orders?offset=${offset}`);
      }
      render(result.orders);
      status.textContent = result.total ? `Заказов: ${result.total}. Показаны ${offset + 1}–${offset + result.orders.length}.` : 'Заказов пока нет.';
      previous.hidden = offset === 0; next.hidden = offset + result.orders.length >= result.total;
    } catch (error) { status.className = 'error'; status.textContent = error.message; }
    finally { loading = false; controls(); }
  }
  create.addEventListener('click', async () => {
    if (creating || loading || deleting || !csrfToken) return;
    creating = true; controls(); message.className = ''; message.textContent = 'Сохраняю черновик…';
    try {
      const { order } = await adminRequest('POST', '/orders', { requestId });
      requestId = crypto.randomUUID(); offset = 0;
      message.textContent = `Черновик ${order.id.slice(0, 8)} сохранён. Деньги не списывались, обработка не запускалась.`;
      message.className = 'success'; await refresh();
    } catch (error) {
      message.textContent = `${error.message} При потере связи повторите: номер запроса сохранён для этой вкладки.`;
      message.className = 'error';
    } finally { creating = false; controls(); }
  });
  refreshButton.addEventListener('click', refresh);
  previous.addEventListener('click', () => { if (!loading && !creating && !deleting) { offset = Math.max(0, offset - 20); refresh(); } });
  next.addEventListener('click', () => { if (!loading && !creating && !deleting) { offset += 20; refresh(); } });
  document.addEventListener('collector-session', () => { controls(); refresh(); });
  if (csrfToken) { controls(); refresh(); }
})();
