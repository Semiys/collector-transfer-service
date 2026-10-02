import { reviewRows, rowProblems, parseTags, FIELD_LIMITS } from '/transfer/review.js';

const labels = { name: 'Название', brand: 'Бренд', scale: 'Масштаб', category: 'Категория', tags: 'Теги',
  price: 'Цена в исходной валюте', purchaseDate: 'Дата покупки', notes: 'Заметки', photoUrl: 'Ссылка на фото' };

// Corrections refer to positions, so two identical models remain separate records.
// Everything, including an unfinished dialog, disappears when the preview is cleared.
export function createOrderReview({ onChange }) {
  const get = (id) => document.getElementById(id), dialog = get('order-editor'), form = get('order-editor-form');
  let parsed = null, edits = new Map(), selected = null, locked = false, originalTags = '', shownTags = '';
  const inputs = {}, problems = {};
  for (const [field, label] of Object.entries(labels)) {
    const wrapper = document.createElement('label'); wrapper.textContent = label;
    if (['notes', 'photoUrl', 'tags'].includes(field)) wrapper.className = 'editor-wide';
    const input = document.createElement(['tags', 'notes'].includes(field) ? 'textarea' : 'input');
    input.id = `order-edit-${field}`; input.maxLength = FIELD_LIMITS[field];
    if (input.tagName === 'TEXTAREA') input.rows = field === 'notes' ? 4 : 2;
    if (field === 'price') input.inputMode = 'decimal';
    if (field === 'purchaseDate') input.placeholder = 'ГГГГ-ММ-ДД';
    if (field === 'tags') input.placeholder = 'Год: 1969, Premium';
    const problem = document.createElement('span'); problem.className = 'field-problem'; problem.id = `${input.id}-problem`;
    input.setAttribute('aria-describedby', problem.id); wrapper.append(input, problem);
    get('order-editor-fields').append(wrapper); inputs[field] = input; problems[field] = problem;
    input.addEventListener('input', validate);
  }
  function values() {
    return Object.fromEntries(Object.entries(inputs).map(([field, input]) => [field,
      field === 'tags' && input.value === shownTags ? originalTags : input.value.trim()]));
  }
  function validate() {
    const errors = rowProblems(values());
    for (const field of Object.keys(inputs)) {
      problems[field].textContent = errors[field] || '';
      inputs[field].setAttribute('aria-invalid', String(!!errors[field]));
    }
    get('order-editor-save').disabled = locked || Object.keys(errors).length > 0;
    return errors;
  }
  function snapshot() {
    const corrections = [...edits].map(([rowIndex, values]) => ({ rowIndex, values }));
    const rows = parsed ? reviewRows(parsed, parsed.mapping, corrections, { defaultBrand: get('order-brand').value }) : [];
    return { edits: corrections, rows, valid: rows.length > 0 && rows.every((row) => !Object.keys(rowProblems(row)).length) };
  }
  function render() {
    const expanded = new Set([...get('order-model-list').children].flatMap((card, index) => card.open ? [index] : []));
    get('order-model-list').replaceChildren();
    for (const [index, row] of snapshot().rows.entries()) {
      const card = document.createElement('details'), title = document.createElement('summary'), dl = document.createElement('dl');
      const errors = rowProblems(row); card.className = Object.keys(errors).length ? 'invalid-model' : '';
      card.open = expanded.has(index);
      title.textContent = `${index + 1}. ${row.name || 'Без названия'}`;
      for (const [field, label] of Object.entries(labels)) {
        const line = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
        let value = row[field];
        if (field === 'tags') { try { value = parseTags(value).join(', '); } catch { /* Show invalid source text. */ } }
        dt.textContent = label; dd.textContent = value || 'Не указано'; line.append(dt, dd); dl.append(line);
        if (errors[field]) { const p = document.createElement('span'); p.className = 'field-problem'; p.textContent = errors[field]; dd.append(p); }
      }
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary';
      button.textContent = 'Изменить модель'; button.disabled = locked; button.addEventListener('click', () => open(index));
      const actions = document.createElement('div'); actions.className = 'actions'; actions.append(button);
      card.append(title, dl, actions);
      if (edits.has(index)) { const p = document.createElement('span'); p.className = 'edited-marker'; p.textContent = 'Поля исправлены'; card.append(p); }
      get('order-model-list').append(card);
    }
  }
  get('order-brand').addEventListener('input', () => { if (parsed && !locked) { render(); onChange(); } });
  function open(index) {
    if (locked || !parsed) return;
    selected = index; const row = snapshot().rows[index];
    get('order-editor-title').textContent = `Модель ${index + 1}`;
    get('order-editor-status').textContent = '';
    for (const field of Object.keys(inputs)) {
      let value = row[field];
      if (field === 'tags') { try { value = parseTags(value).join(', '); } catch { /* Keep source text. */ } }
      inputs[field].value = value;
    }
    originalTags = row.tags; shownTags = inputs.tags.value;
    validate(); dialog.showModal(); inputs.name.focus();
  }
  function cleanDialog() { selected = null; originalTags = ''; shownTags = ''; form.reset(); get('order-editor-status').textContent = ''; }
  dialog.addEventListener('close', cleanDialog);
  get('order-editor-close').addEventListener('click', () => dialog.close());
  get('order-editor-discard').addEventListener('click', () => dialog.close());
  form.addEventListener('submit', (event) => {
    event.preventDefault(); if (locked || selected === null || Object.keys(validate()).length) return;
    const next = new Map(edits); next.set(selected, values());
    try { reviewRows(parsed, parsed.mapping, [...next].map(([rowIndex, values]) => ({ rowIndex, values }))); }
    catch (error) { get('order-editor-status').textContent = error.message; return; }
    const editedIndex = selected;
    edits = next; dialog.close(); render(); onChange();
    get('order-model-list').children[editedIndex].querySelector('button').focus({ preventScroll: true });
  });
  return {
    setData(value) { this.clear(); parsed = value; render(); },
    clear() { if (dialog.open) dialog.close(); cleanDialog(); parsed = null; edits.clear(); get('order-model-list').replaceChildren(); },
    setLocked(value) {
      locked = value;
      get('order-editor-fields').disabled = value;
      for (const button of get('order-model-list').querySelectorAll('button')) button.disabled = value;
      if (dialog.open) validate();
    },
    snapshot,
  };
}
