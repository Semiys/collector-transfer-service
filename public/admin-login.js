const form = document.getElementById('login-form');
const status = document.getElementById('login-status');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  status.textContent = 'Проверяю код…';
  status.className = 'status';
  try {
    const response = await fetch('/api/admin/session', {
      method: 'POST', cache: 'no-store', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: document.getElementById('admin-code').value.trim() }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Не удалось войти');
    location.assign('/admin');
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status error';
    button.disabled = false;
  }
});
