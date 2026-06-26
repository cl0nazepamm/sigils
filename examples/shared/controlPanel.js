/**
 * Spec-driven control panel for the sigils demo.
 */

export function mountControlPanel(root, specs, state, { onChange, onLive, signal, defaults = {} } = {}) {
  const ui = new Map();
  let host = root;
  const menu = createResetMenu(root.ownerDocument ?? document, signal);

  function commit(spec, input, row, value) {
    const next = coerceValue(spec, value);
    state[spec.key] = next;
    writeControlValue(spec, input, row, next, root);
    (spec.live ? onLive : onChange)?.(spec.key, next);
  }

  for (const spec of specs) {
    if (spec.type === 'section') {
      const section = document.createElement('section');
      section.className = 'control-section';
      if (spec.forge) section.classList.add(`forge-${spec.forge}`);
      const title = document.createElement('div');
      title.className = 'section-title';
      title.textContent = spec.label;
      section.appendChild(title);
      root.appendChild(section);
      host = section;
      continue;
    }

    if (spec.type === 'details') {
      const details = document.createElement('details');
      details.className = 'control-section control-details';
      if (spec.forge) details.classList.add(`forge-${spec.forge}`);
      const summary = document.createElement('summary');
      summary.className = 'section-title';
      summary.textContent = spec.label;
      details.appendChild(summary);
      root.appendChild(details);
      host = details;
      continue;
    }

    if (spec.type === 'hostReset') {
      host = root;
      continue;
    }

    const row = document.createElement('div');
    row.className = spec.type === 'check' ? 'control-row check' : 'control-row';
    if (spec.forge) row.classList.add(`forge-${spec.forge}`);

    const label = document.createElement('label');
    label.htmlFor = spec.key;
    label.textContent = spec.label;
    row.appendChild(label);

    let input;
    if (spec.type === 'select') {
      input = document.createElement('select');
      input.id = spec.key;
      for (const [value, text] of spec.options) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        input.appendChild(option);
      }
      input.value = String(state[spec.key] ?? spec.options[0][0]);
      input.addEventListener('change', () => {
        commit(spec, input, row, input.value);
      }, { signal });
      row.appendChild(input);
    } else if (spec.type === 'check') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.id = spec.key;
      input.checked = !!state[spec.key];
      input.addEventListener('change', () => {
        commit(spec, input, row, input.checked);
      }, { signal });
      row.appendChild(input);
    } else {
      input = document.createElement('input');
      input.type = 'range';
      input.id = spec.key;
      input.min = spec.min;
      input.max = spec.max;
      input.step = spec.step;
      input.value = state[spec.key];
      const out = document.createElement('output');
      out.id = `${spec.key}-out`;
      out.textContent = formatValue(spec, state[spec.key]);
      input.addEventListener('input', () => {
        commit(spec, input, row, input.value);
      }, { signal });
      row.appendChild(input);
      row.appendChild(out);
    }

    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const fallback = spec.type === 'select' ? spec.options[0][0] : spec.type === 'check' ? false : spec.min;
      const value = Object.prototype.hasOwnProperty.call(defaults, spec.key) ? defaults[spec.key] : fallback;
      menu.show(event.clientX, event.clientY, () => commit(spec, input, row, value));
    }, { signal });

    host.appendChild(row);
    ui.set(spec.key, { spec, input, row });
  }

  return ui;
}

/** Push current state values back into mounted control inputs. */
export function syncControlPanelToState(ui, state, root = document) {
  for (const [key, { spec, input, row }] of ui) {
    writeControlValue(spec, input, row, state[key], root);
  }
}

function coerceValue(spec, value) {
  if (spec.type === 'check') return !!value;
  if (spec.type === 'select') return spec.valueType === 'number' ? Number(value) : value;
  return spec.int ? Number(value) | 0 : Number(value);
}

function formatValue(spec, value) {
  if (spec.int) return String(Number(value) | 0);
  const decimals = String(spec.step).includes('.') ? String(spec.step).split('.')[1].length : 0;
  return Number(value).toFixed(decimals);
}

function writeControlValue(spec, input, row, value, root = document) {
  if (spec.type === 'check') {
    input.checked = !!value;
    return;
  }
  if (spec.type === 'select') {
    input.value = String(value ?? spec.options[0][0]);
    return;
  }
  input.value = value;
  const out = row.querySelector('output') ?? root.querySelector(`#${spec.key}-out`);
  if (out) out.textContent = formatValue(spec, value);
}

function createResetMenu(doc, signal) {
  const menu = doc.createElement('div');
  menu.className = 'control-context-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');

  const button = doc.createElement('button');
  button.type = 'button';
  button.textContent = 'Restore default';
  button.setAttribute('role', 'menuitem');
  menu.appendChild(button);
  doc.body.appendChild(menu);

  let reset = null;
  function hide() {
    menu.hidden = true;
    reset = null;
  }

  function show(x, y, resetFn) {
    reset = resetFn;
    menu.hidden = false;
    menu.style.left = '0px';
    menu.style.top = '0px';
    const rect = menu.getBoundingClientRect();
    const maxX = Math.max(6, window.innerWidth - rect.width - 6);
    const maxY = Math.max(6, window.innerHeight - rect.height - 6);
    menu.style.left = `${Math.min(Math.max(6, x), maxX)}px`;
    menu.style.top = `${Math.min(Math.max(6, y), maxY)}px`;
  }

  button.addEventListener('click', () => {
    const fn = reset;
    hide();
    fn?.();
  }, { signal });
  doc.addEventListener('pointerdown', (event) => {
    if (!menu.hidden && !menu.contains(event.target)) hide();
  }, { signal });
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide();
  }, { signal });
  signal?.addEventListener('abort', () => menu.remove(), { once: true });

  return { show, hide };
}
