export function createActionState({ setTimer = setTimeout, clearTimer = clearTimeout, onChange = () => {} } = {}) {
  const values = new Map();
  const timers = new Map();

  const set = (key, value) => {
    if (timers.has(key)) clearTimer(timers.get(key));
    timers.delete(key);
    if (value) values.set(key, value);
    else values.delete(key);
    onChange(key, value);
    return value;
  };

  const start = (key, message = '处理中') => set(key, { status: 'pending', message });
  const fail = (key, error) => set(key, { status: 'error', message: error instanceof Error ? error.message : String(error) });
  const succeed = (key, message = '已完成', duration = 2000) => {
    const value = set(key, { status: 'success', message });
    timers.set(key, setTimer(() => set(key, null), duration));
    return value;
  };

  return {
    start,
    fail,
    succeed,
    clear: key => set(key, null),
    get: key => values.get(key) || null,
    entries: () => [...values.entries()]
  };
}
