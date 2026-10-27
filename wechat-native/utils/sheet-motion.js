const { exitDuration } = require('./sheet-motion-config.js');
const runs = new WeakMap();
function resetSheet(component) {
  const run = runs.get(component);
  if (run && run.timer) clearTimeout(run.timer);
  runs.delete(component);
}
function enterSheet(component, mountData, onMounted) {
  resetSheet(component);
  runs.set(component, { closing: false, timer: null });
  component.setData({ ...mountData, sheetMotion: 'sheet-enter', backdropMotion: 'backdrop-enter' }, onMounted);
}
function exitSheet(component, onClosed) {
  const run = runs.get(component);
  if (!run) { onClosed(); return; }
  if (run.closing) return;
  run.closing = true;
  component.setData({ sheetMotion: 'sheet-exit', backdropMotion: 'backdrop-exit' });
  run.timer = setTimeout(() => {
    if (runs.get(component) !== run) return;
    runs.delete(component);
    onClosed();
  }, exitDuration);
  if (run.timer && run.timer.unref) run.timer.unref();
}
module.exports = { enterSheet, exitSheet, resetSheet, EXIT_DURATION: exitDuration };
