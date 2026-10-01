(() => {
  let savedTheme = null;
  try { savedTheme = localStorage.getItem('collector-theme'); } catch { /* Хранилище может быть отключено. */ }
  if (savedTheme === 'light' || savedTheme === 'dark') document.documentElement.dataset.theme = savedTheme;

  function currentTheme() {
    return document.documentElement.dataset.theme ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }

  function updateButtons() {
    const dark = currentTheme() === 'dark';
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      button.textContent = dark ? '☀ Светлая' : '☾ Тёмная';
      button.setAttribute('aria-label', dark ? 'Включить светлую тему' : 'Включить тёмную тему');
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      button.addEventListener('click', () => {
        const next = currentTheme() === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem('collector-theme', next); } catch { /* Тема останется до закрытия страницы. */ }
        updateButtons();
      });
    });
    updateButtons();
  });
})();
