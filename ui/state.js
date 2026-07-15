export function createStore(initial = {}) {
  let value = initial;
  const subscribers = new Set();
  const notify = () => subscribers.forEach(subscriber => subscriber(value));
  return {
    getState: () => value,
    setState(next) { value = typeof next === 'function' ? next(value) : next; notify(); return value; },
    patchSelection(selection) { value = { ...value, selection: { ...(value.selection || {}), ...selection } }; notify(); return value; },
    subscribe(subscriber) { subscribers.add(subscriber); return () => subscribers.delete(subscriber); }
  };
}
