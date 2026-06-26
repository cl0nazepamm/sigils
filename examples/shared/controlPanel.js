/**
 * Spec-driven control panel for the sigils demo.
 */

export function mountControlPanel(root, specs, state, { onChange, onLive, signal } = {}) {
  const ui = new Map();
  let host = root;

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
        state[spec.key] = spec.valueType === 'number' ? Number(input.value) : input.value;
        onChange?.(spec.key, state[spec.key]);
      }, { signal });
      row.appendChild(input);
    } else if (spec.type === 'check') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.id = spec.key;
      input.checked = !!state[spec.key];
      input.addEventListener('change', () => {
        state[spec.key] = input.checked;
        (spec.live ? onLive : onChange)?.(spec.key, state[spec.key]);
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
      const decimals = String(spec.step).includes('.') ? String(spec.step).split('.')[1].length : 0;
      const format = (v) => (spec.int ? String(v | 0) : Number(v).toFixed(decimals));
      out.textContent = format(state[spec.key]);
      input.addEventListener('input', () => {
        const v = spec.int ? Number(input.value) | 0 : Number(input.value);
        state[spec.key] = v;
        out.textContent = format(v);
        (spec.live ? onLive : onChange)?.(spec.key, v);
      }, { signal });
      row.appendChild(input);
      row.appendChild(out);
    }

    host.appendChild(row);
    ui.set(spec.key, { spec, input, row });
  }

  return ui;
}

/** Push current state values back into mounted control inputs. */
export function syncControlPanelToState(ui, state, root = document) {
  for (const [key, { spec, input, row }] of ui) {
    const v = state[key];
    if (spec.type === 'check') {
      input.checked = !!v;
      continue;
    }
    if (spec.type === 'select') {
      input.value = String(v ?? spec.options[0][0]);
      continue;
    }
    input.value = v;
    const out = row.querySelector('output') ?? root.querySelector(`#${key}-out`);
    if (out) {
      const decimals = String(spec.step).includes('.') ? String(spec.step).split('.')[1].length : 0;
      out.textContent = spec.int ? String(v | 0) : Number(v).toFixed(decimals);
    }
  }
}
