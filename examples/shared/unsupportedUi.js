/**
 * WebGL-session helpers: gray out WebGPU-only controls and stub the trace
 * rigs so Drawing / Paint on Mesh keep their frame loops unchanged.
 */

export const WEBGL_NEEDS_WEBGPU = 'Needs WebGPU — this session is on WebGL2';

/** Disable a button/select and surface why (native :disabled already grays it). */
export function markUnsupported(el, reason = WEBGL_NEEDS_WEBGPU) {
  if (!el) return;
  el.disabled = true;
  el.title = reason;
  el.setAttribute('aria-disabled', 'true');
}

export const PT_NO_ORTHO = 'No perspective is unavailable while path tracing';

/** Gray out / restore the Stroke → No perspective checkbox during path trace. */
export function setOrthographicLocked(controlsRoot, locked, reason = PT_NO_ORTHO) {
  const input = controlsRoot?.querySelector?.('#orthographic');
  if (!input) return;
  input.disabled = !!locked;
  if (locked) {
    input.title = reason;
    input.setAttribute('aria-disabled', 'true');
  } else {
    input.removeAttribute('title');
    input.removeAttribute('aria-disabled');
  }
}

/** No-op photon + path-trace handles matching the real rig surface. */
export function createInactiveTraceRigs() {
  const noop = () => {};
  return {
    photon: {
      get active() { return false; },
      setActive: noop,
      resetDefaults: noop,
      refreshCaster: noop,
      syncCaster: noop,
      handleLive: noop,
      update: noop,
      dispose: noop,
    },
    pathTrace: {
      get active() { return false; },
      setActive: noop,
      setHold: noop,
      resetDefaults: noop,
      syncSigil: noop,
      handleLive: noop,
      beginComposite: noop,
      endComposite: noop,
      render: () => false,
      samples: () => 0,
      dispose: noop,
    },
  };
}

/** Lock the Field Backend control to CPU when compute isn't available. */
export function lockFieldBackendToCpu(controlsRoot, state) {
  if (!controlsRoot) return;
  state.backend = 'cpu';
  const select = controlsRoot.querySelector('#backend');
  if (!select) return;
  for (const opt of select.options) {
    if (opt.value !== 'cpu') {
      opt.disabled = true;
      if (!/\(needs/i.test(opt.textContent)) opt.textContent += ' (needs WebGPU)';
    }
  }
  select.value = 'cpu';
  markUnsupported(select, 'Field compute needs WebGPU — using CPU');
}
