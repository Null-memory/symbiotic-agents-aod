function shortenedPath(value) {
  const parts = String(value || '').split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `...\\${parts.slice(-2).join('\\')}` : String(value || '');
}

function button(label, className = 'secondary small') {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = label;
  return element;
}

export function createWorkspaceController({ root = document, request, onSelected, onError }) {
  const selector = root.querySelector('#workspaceSelector');
  const dialog = root.querySelector('#workspaceDialog');
  const list = root.querySelector('#workspaceList');
  const pathInput = root.querySelector('#workspacePath');
  const browser = root.querySelector('#workspaceBrowser');
  const validationPanel = root.querySelector('#workspaceValidation');
  const selectButton = root.querySelector('#selectWorkspace');
  const pickButton = root.querySelector('#pickWorkspaceDirectory');
  let state = { activeWorkspaceId: null, workspaces: [] };
  let validation = null;

  const showError = error => {
    validation = null;
    selectButton.disabled = true;
    validationPanel.className = 'workspace-validation is-error';
    validationPanel.textContent = error.message;
    onError?.(error);
  };

  const renderRegistered = () => {
    list.replaceChildren();
    if (!state.workspaces?.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = '还没有已注册项目。';
      list.append(empty);
      return;
    }
    for (const workspace of state.workspaces) {
      const item = button('', `workspace-list-item ${workspace.id === state.activeWorkspaceId ? 'active' : ''}`);
      item.dataset.workspaceId = workspace.id;
      item.title = workspace.gitRoot;
      const signal = document.createElement('span');
      signal.className = `workspace-state-dot status-${workspace.status}${workspace.dirty ? ' is-dirty' : ''}`;
      const copy = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = workspace.name;
      const meta = document.createElement('small');
      meta.textContent = `${workspace.branch} · ${shortenedPath(workspace.gitRoot)}`;
      copy.append(name, meta);
      const stateLabel = document.createElement('em');
      stateLabel.textContent = workspace.status === 'ready' ? (workspace.dirty ? 'DIRTY' : 'CLEAN') : workspace.status.toUpperCase();
      item.append(signal, copy, stateLabel);
      item.addEventListener('click', () => {
        pathInput.value = workspace.gitRoot;
        validatePath(workspace.gitRoot);
      });
      list.append(item);
    }
  };

  const renderBrowser = result => {
    browser.replaceChildren();
    const toolbar = document.createElement('div');
    toolbar.className = 'workspace-browser-toolbar';
    const current = document.createElement('span');
    current.textContent = result.path;
    current.title = result.path;
    toolbar.append(current);
    if (result.parent) {
      const parent = button('向上', 'text-button');
      parent.addEventListener('click', () => browse(result.parent));
      toolbar.prepend(parent);
    }
    const entries = document.createElement('div');
    entries.className = 'workspace-browser-entries';
    for (const directory of result.directories) {
      const entry = button(directory.name, 'workspace-directory');
      entry.title = directory.path;
      entry.addEventListener('click', () => {
        pathInput.value = directory.path;
        browse(directory.path);
      });
      entries.append(entry);
    }
    if (!result.directories.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = '这个目录没有子目录。';
      entries.append(empty);
    }
    browser.append(toolbar, entries);
  };

  const browse = async path => {
    try {
      const result = await request(`/api/filesystem/directories?path=${encodeURIComponent(path)}`);
      pathInput.value = result.path;
      renderBrowser(result);
    } catch (error) { showError(error); }
  };

  const validatePath = async path => {
    validationPanel.className = 'workspace-validation is-loading';
    validationPanel.textContent = '正在验证 Git 仓库...';
    selectButton.disabled = true;
    try {
      validation = await request('/api/workspaces/validate', { method: 'POST', body: JSON.stringify({ path }) });
      validationPanel.className = `workspace-validation is-valid${validation.dirty ? ' is-dirty' : ''}`;
      validationPanel.replaceChildren();
      const title = document.createElement('strong');
      title.textContent = validation.name;
      const meta = document.createElement('span');
      meta.textContent = `${validation.branch} · ${validation.headCommit.slice(0, 8)} · ${validation.dirty ? '有未提交修改' : '工作区干净'}`;
      const fullPath = document.createElement('code');
      fullPath.textContent = validation.gitRoot;
      validationPanel.append(title, meta, fullPath);
      pathInput.value = validation.gitRoot;
      selectButton.disabled = false;
    } catch (error) { showError(error); }
  };

  const pickNativePath = async () => {
    if (!pickButton) return;
    pickButton.disabled = true;
    pickButton.textContent = '等待 Windows 窗口…';
    validation = null;
    selectButton.disabled = true;
    validationPanel.className = 'workspace-validation is-loading';
    validationPanel.textContent = '请在 Windows 文件夹窗口中选择项目目录；取消窗口不会改变当前项目。';
    try {
      const result = await request('/api/filesystem/pick-directory', {
        method: 'POST',
        body: JSON.stringify({ path: pathInput.value.trim() }),
      });
      if (result.canceled || !result.path) {
        validationPanel.className = 'workspace-validation';
        validationPanel.textContent = '已取消选择。你仍可以输入路径或使用目录浏览。';
        return;
      }
      pathInput.value = result.path;
      await validatePath(result.path);
    } catch (error) {
      showError(error);
    } finally {
      pickButton.disabled = false;
      pickButton.textContent = 'Windows 文件夹';
    }
  };

  const render = nextState => {
    state = { activeWorkspaceId: nextState.activeWorkspaceId, workspaces: nextState.workspaces || [] };
    const active = state.workspaces.find(workspace => workspace.id === state.activeWorkspaceId);
    root.querySelector('#workspaceSelectorName').textContent = active?.name || '选择项目';
    root.querySelector('#workspaceSelectorMeta').textContent = active ? `${active.branch} · ${shortenedPath(active.gitRoot)}` : '未选择';
    root.querySelector('#workspaceSelectorSignal').className = `workspace-selector-signal status-${active?.status || 'invalid'}${active?.dirty ? ' is-dirty' : ''}`;
    selector.title = active?.gitRoot || '选择默认项目工作区';
    renderRegistered();
  };

  const open = () => {
    validation = null;
    selectButton.disabled = true;
    validationPanel.className = 'workspace-validation';
    validationPanel.textContent = '选择一个包含至少一次提交的 Git 仓库。';
    renderRegistered();
    const active = state.workspaces.find(workspace => workspace.id === state.activeWorkspaceId);
    if (active) {
      pathInput.value = active.gitRoot;
      browse(active.gitRoot);
    }
    dialog.showModal();
  };

  selector.addEventListener('click', open);
  root.querySelector('#closeWorkspaceDialog').addEventListener('click', () => dialog.close());
  root.querySelector('#cancelWorkspace').addEventListener('click', () => dialog.close());
  pickButton?.addEventListener('click', pickNativePath);
  root.querySelector('#validateWorkspace').addEventListener('click', () => validatePath(pathInput.value));
  pathInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); validatePath(pathInput.value); }
  });
  selectButton.addEventListener('click', async () => {
    if (!validation) return;
    selectButton.disabled = true;
    try {
      const registered = await request('/api/workspaces', { method: 'POST', body: JSON.stringify({ path: validation.gitRoot }) });
      await request(`/api/workspaces/${registered.id}/select`, { method: 'POST', body: '{}' });
      dialog.close();
      await onSelected?.(registered);
    } catch (error) { showError(error); }
  });

  return { render, open, browse, validatePath, pickNativePath };
}
