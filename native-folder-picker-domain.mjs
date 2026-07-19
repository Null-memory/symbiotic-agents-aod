const windowsFolderPickerScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择 AOD 项目文件夹'
$dialog.ShowNewFolderButton = $false
$initialPath = [Environment]::GetEnvironmentVariable('AOD_PICKER_INITIAL_PATH')
if ($initialPath -and (Test-Path -LiteralPath $initialPath -PathType Container)) {
  $dialog.SelectedPath = $initialPath
}
try {
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::WriteLine($dialog.SelectedPath)
  }
} finally {
  $dialog.Dispose()
}
`;

export const nativeFolderPickerScript = windowsFolderPickerScript;

export function nativeFolderPickerSupported(platform = process.platform) {
  return platform === 'win32';
}

export function windowsFolderPickerInvocation(initialPath = '') {
  return {
    command: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', windowsFolderPickerScript],
    env: { AOD_PICKER_INITIAL_PATH: String(initialPath || '') },
    windowsHide: true,
  };
}

export function parseNativeFolderPickerOutput(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.at(-1) || null;
}
