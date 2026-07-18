export function createRefreshScheduler(refresh, { delay = 100, onError = error => console.error(error) } = {}) {
  let timer = null;
  let active = false;
  let trailing = false;
  const eventTypes = new Set();

  const run = async () => {
    timer = null;
    if (active) {
      trailing = true;
      return;
    }
    active = true;
    const types = [...eventTypes];
    eventTypes.clear();
    try {
      await refresh(types);
    } catch (error) {
      onError(error);
    } finally {
      active = false;
      if (trailing || eventTypes.size) {
        trailing = false;
        if (!timer) timer = setTimeout(run, delay);
      }
    }
  };

  const schedule = type => {
    if (type) eventTypes.add(type);
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, delay);
  };

  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    await run();
  };

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    trailing = false;
    eventTypes.clear();
  };

  return { schedule, flush, cancel };
}

export function captureElementState(root, inputSelector) {
  const input = inputSelector ? root?.querySelector?.(inputSelector) : null;
  return {
    scrollTop: Number(root?.scrollTop) || 0,
    input: input ? {
      id: input.id || null,
      value: input.value ?? '',
      selectionStart: Number.isInteger(input.selectionStart) ? input.selectionStart : null,
      selectionEnd: Number.isInteger(input.selectionEnd) ? input.selectionEnd : null
    } : null
  };
}

export function restoreElementState(root, inputSelector, snapshot, frame = callback => requestAnimationFrame(callback)) {
  if (!root || !snapshot) return;
  frame(() => {
    root.scrollTop = snapshot.scrollTop || 0;
    if (!snapshot.input || !inputSelector) return;
    const input = root.querySelector?.(inputSelector);
    if (!input) return;
    input.value = snapshot.input.value;
    input.focus?.({ preventScroll: true });
    if (snapshot.input.selectionStart !== null && snapshot.input.selectionEnd !== null) {
      input.setSelectionRange?.(snapshot.input.selectionStart, snapshot.input.selectionEnd);
    }
  });
}
