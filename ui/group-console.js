export function createGroupConsole({ root }) {
  function setActivePane(name) {
    root.dataset.activePane = name;
    root.querySelectorAll('[data-group-tab]').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.groupTab === name)));
  }

  root.addEventListener('click', event => {
    const tab = event.target.closest('[data-group-tab]');
    if (tab) setActivePane(tab.dataset.groupTab);
  });

  return { setActivePane };
}
