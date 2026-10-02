const status = document.getElementById('status');
const list = document.getElementById('accounts');
const aiAccount = document.getElementById('ai-account');
const aiFallback = document.getElementById('ai-fallback');
const aiFallbackLabel = document.getElementById('ai-fallback-label');
const aiStatus = document.getElementById('ai-status');
const aiReview = document.getElementById('ai-review');
let recognizedCollection = null;
let accountsCache = [];
let csrfToken = '';

function fallbackAccounts() {
  const selected = accountsCache.find((account) => account.id === aiAccount.value && account.enabled);
  if (!selected) return [];
  const owners = new Set([selected.owner.trim().toLocaleLowerCase('ru')]);
  return accountsCache.filter((account) => {
    if (!account.enabled || account.id === selected.id) return false;
    const owner = account.owner.trim().toLocaleLowerCase('ru');
    if (owners.has(owner)) return false;
    owners.add(owner);
    return true;
  }).slice(0, 2);
}

function renderFallbackConsent() {
  aiFallback.checked = false;
  const fallback = fallbackAccounts();
  aiFallback.disabled = fallback.length === 0;
  aiFallbackLabel.textContent = fallback.length ?
    `Разрешаю для этого запроса повторно отправить мой текст через OpenRouter с ключами владельцев: ${fallback.map((account) => `${account.owner} (${account.label})`).join(', ')}. Это произойдёт только при лимите основного ключа или приближении к нему по счётчику нашего сервиса.` :
    'Нет доступных резервных ключей других владельцев. Добавьте их выше, если они согласны участвовать.';
}

function showStatus(message, kind = '') {
  status.textContent = message;
  status.className = kind;
}

async function adminRequest(method, route, body) {
  const response = await fetch(`/api/admin${route}`, {
    method, cache: 'no-store', credentials: 'same-origin',
    headers: { ...(method !== 'GET' ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (response.status === 401) {
    location.assign('/admin/login');
    throw new Error('Сессия завершилась. Войдите снова.');
  }
  if (!response.ok) throw new Error(result.error ?? 'Запрос не выполнен');
  return result;
}

function accountRow(account) {
  const item = document.createElement('div');
  item.className = 'account';
  const title = document.createElement('strong');
  title.textContent = `${account.label} — ${account.owner}`;
  const detail = document.createElement('p');
  detail.textContent = `${account.keyPreview} · ${account.enabled ? 'Включён' : 'Выключен'} · добавлен ${new Date(account.createdAt).toLocaleDateString('ru-RU')}`;
  const actions = document.createElement('div');
  actions.className = 'actions';
  const check = document.createElement('button');
  check.type = 'button'; check.className = 'secondary'; check.textContent = 'Проверить';
  check.addEventListener('click', async () => {
    check.disabled = true;
    try {
      const result = await adminRequest('GET', `/accounts/${encodeURIComponent(account.id)}/check`);
      const quota = result.freeRequestsToday;
      const quotaText = quota ? ` Бесплатных запросов сегодня: использовано ${quota.used}, осталось ${quota.remaining} из ${quota.limit}. Суточный счётчик общий для аккаунта; у поставщика модели могут быть отдельные ограничения.` :
        ' OpenRouter не сообщил остаток бесплатных запросов; по действительности ключа нельзя судить об остатке лимита.';
      showStatus(result.valid ? `Ключ «${account.label}» принят OpenRouter${result.freeTier ? ' (бесплатный тариф)' : ''}.${quotaText}` :
        `Ключ «${account.label}» отклонён OpenRouter.`, result.valid ? 'success' : 'error');
    } catch (error) { showStatus(error.message, 'error'); }
    finally { check.disabled = false; }
  });
  const toggle = document.createElement('button');
  toggle.type = 'button'; toggle.className = 'secondary';
  toggle.textContent = account.enabled ? 'Выключить' : 'Включить';
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    try {
      await adminRequest('PATCH', `/accounts/${encodeURIComponent(account.id)}`, { enabled: !account.enabled });
      await loadAccounts();
    } catch (error) { showStatus(error.message, 'error'); toggle.disabled = false; }
  });
  const remove = document.createElement('button');
  remove.type = 'button'; remove.className = 'danger'; remove.textContent = 'Удалить';
  remove.addEventListener('click', async () => {
    if (!confirm(`Удалить ключ «${account.label}»? Восстановить его из панели нельзя.`)) return;
    remove.disabled = true;
    try {
      await adminRequest('DELETE', `/accounts/${encodeURIComponent(account.id)}`);
      await loadAccounts();
    } catch (error) { showStatus(error.message, 'error'); remove.disabled = false; }
  });
  actions.append(check, toggle, remove);
  item.append(title, detail, actions);
  return item;
}

async function loadAccounts() {
  const result = await adminRequest('GET', '/accounts');
  accountsCache = result.accounts;
  list.replaceChildren();
  const previousAccount = aiAccount.value;
  aiAccount.replaceChildren(new Option('Выберите включённый ключ', ''));
  if (result.accounts.length === 0) {
    const empty = document.createElement('p'); empty.textContent = 'Ключей пока нет.'; list.append(empty);
  } else result.accounts.forEach((account) => {
    list.append(accountRow(account));
    if (account.enabled) aiAccount.append(new Option(`${account.label} — ${account.owner}`, account.id));
  });
  if ([...aiAccount.options].some((option) => option.value === previousAccount)) aiAccount.value = previousAccount;
  renderFallbackConsent();
  showStatus(`Ключей в списке: ${result.accounts.length}`, 'success');
  document.dispatchEvent(new CustomEvent('collector-accounts', { detail: result.accounts }));
}

aiAccount.addEventListener('change', renderFallbackConsent);

document.getElementById('load').addEventListener('click', () => {
  loadAccounts().catch((error) => showStatus(error.message, 'error'));
});

document.getElementById('logout').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/admin/session', { method: 'DELETE', cache: 'no-store',
      credentials: 'same-origin', headers: { 'X-CSRF-Token': csrfToken } });
    if (response.ok || response.status === 401) location.assign('/admin/login');
    else showStatus('Не удалось выйти. Обновите страницу и повторите.', 'error');
  } catch {
    showStatus('Нет связи с сервером. Повторите выход позже.', 'error');
  }
});

document.getElementById('ai-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  recognizedCollection = null;
  aiReview.hidden = true;
  button.disabled = true;
  aiStatus.textContent = 'Отправляю текст в OpenRouter…';
  aiStatus.className = '';
  try {
    const consentToAccountSwitch = aiFallback.checked;
    const result = await adminRequest('POST', '/ai/parse', {
      accountId: aiAccount.value, text: document.getElementById('ai-text').value,
      consentToAccountSwitch,
      fallbackAccountIds: consentToAccountSwitch ? fallbackAccounts().map((account) => account.id) : [],
    });
    recognizedCollection = result;
    aiStatus.textContent = `Модель: ${result.modelUsed}. Ключ: ${result.keyUsed.label} (${result.keyUsed.owner})${result.fallbackUsed ? ' — использован резервный ключ' : ''}. Распознано моделей: ${result.models.length}. Замечаний: ${result.warnings.length}. Проверьте все строки перед скачиванием ZIP.`;
    aiStatus.className = 'success';
    aiReview.hidden = false;
  } catch (error) {
    aiStatus.textContent = error.message;
    aiStatus.className = 'error';
  } finally { button.disabled = false; aiFallback.checked = false; }
});

aiReview.addEventListener('click', () => {
  if (!recognizedCollection) return;
  sessionStorage.setItem('collector-ai-import', JSON.stringify(recognizedCollection));
  location.assign('/');
});

document.getElementById('add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await adminRequest('POST', '/accounts', {
      owner: document.getElementById('owner').value,
      label: document.getElementById('label').value,
      apiKey: document.getElementById('api-key').value,
      consent: document.getElementById('consent').checked,
    });
    form.reset();
    await loadAccounts();
    showStatus('Ключ сохранён. Его действительность ещё не проверена через OpenRouter.', 'success');
  } catch (error) { showStatus(error.message, 'error'); }
  finally { button.disabled = false; }
});

fetch('/api/admin/session', { cache: 'no-store', credentials: 'same-origin' })
  .then(async (response) => {
    if (response.status === 401) { location.assign('/admin/login'); return null; }
    if (!response.ok) throw new Error('Не удалось проверить вход администратора');
    return response.json();
  })
  .then((session) => {
    if (!session) return;
    csrfToken = session.csrfToken;
    document.dispatchEvent(new CustomEvent('collector-session'));
    return loadAccounts();
  })
  .catch((error) => showStatus(error.message, 'error'));
