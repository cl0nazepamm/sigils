/**
 * Undo/redo keyboard shortcuts shared by the drawing modes.
 * Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z (or Ctrl/Cmd+Y) redoes.
 */
export function bindUndoRedoKeys({ undo, redo, signal }) {
  addEventListener('keydown', (event) => {
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      undo();
    } else if ((key === 'z' && event.shiftKey) || key === 'y') {
      event.preventDefault();
      redo?.();
    }
  }, { signal });
}
