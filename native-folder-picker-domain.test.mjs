import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nativeFolderPickerScript,
  nativeFolderPickerSupported,
  parseNativeFolderPickerOutput,
  windowsFolderPickerInvocation,
} from './native-folder-picker-domain.mjs';

test('supports the Windows native folder picker only on Windows', () => {
  assert.equal(nativeFolderPickerSupported('win32'), true);
  assert.equal(nativeFolderPickerSupported('linux'), false);
  assert.equal(nativeFolderPickerSupported('darwin'), false);
});

test('builds a GUI-safe PowerShell folder picker invocation', () => {
  const invocation = windowsFolderPickerInvocation('C:\\项目\\demo');
  assert.equal(invocation.command, 'powershell.exe');
  assert.deepEqual(invocation.args.slice(0, 5), ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command']);
  assert.match(invocation.args.at(-1), /FolderBrowserDialog/);
  assert.match(invocation.args.at(-1), /AOD_PICKER_INITIAL_PATH/);
  assert.equal(invocation.env.AOD_PICKER_INITIAL_PATH, 'C:\\项目\\demo');
  assert.equal(invocation.windowsHide, true);
});

test('treats empty native picker output as cancellation and preserves Unicode paths', () => {
  assert.equal(parseNativeFolderPickerOutput(''), null);
  assert.equal(parseNativeFolderPickerOutput('\r\n'), null);
  assert.equal(parseNativeFolderPickerOutput('C:\\项目\\演示\r\n'), 'C:\\项目\\演示');
  assert.equal(parseNativeFolderPickerOutput('noise\r\nC:\\项目\\演示\r\n'), 'C:\\项目\\演示');
});
