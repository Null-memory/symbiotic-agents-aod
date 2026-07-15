export function createDialogs({ root = document } = {}) {
  function setBusy(button, busy, label = '处理中') {
    if (!button) return;
    if (busy) {
      button.dataset.idleLabel = button.textContent;
      button.textContent = label;
    } else if (button.dataset.idleLabel) {
      button.textContent = button.dataset.idleLabel;
      delete button.dataset.idleLabel;
    }
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
  }

  root.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('close', () => {
    dialog.querySelectorAll('[aria-busy="true"]').forEach(button => setBusy(button, false));
  }));

  return { setBusy };
}
