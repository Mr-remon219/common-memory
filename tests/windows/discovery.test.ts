import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { WINDOWS_DESKTOP_PROBE } from '../../src/cli/integration-targets.js';

const powershell = process.platform === 'win32'
  ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  : '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

// Only installed-app metadata is synthetic. Execute the actual production query
// in PowerShell 5.1, rather than reimplementing its matching in a JS mock.
it.each([
  { name: 'ChatGPT', packageName: 'OpenAI.Codex', detected: true },
  { name: 'ChatGPT', packageName: 'OpenAI.ChatGPT-Desktop', detected: true },
  { name: 'Codex', packageName: 'OpenAI.Codex', detected: false },
  { name: '', packageName: '', detected: false },
])('discovers $name / $packageName without confusing Codex-only or absent apps with ChatGPT', ({ name, packageName, detected }) => {
  const source = `$ErrorActionPreference='Stop'
$env:USERPROFILE='C:\\Users\\Synthetic 中文'
function Get-AppxPackage { param($Name)
  if ('${packageName}' -and '${packageName}' -like $Name) { [pscustomobject]@{Name='${packageName}'} }
}
function Get-StartApps { param($Name)
  if ('${name}' -and '${name}' -like $Name) { [pscustomobject]@{Name='${name}';AppID='${packageName}_synthetic!App'} }
}
${WINDOWS_DESKTOP_PROBE}`;
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 15_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(detected ? 'C:\\Users\\Synthetic 中文' : '');
});
