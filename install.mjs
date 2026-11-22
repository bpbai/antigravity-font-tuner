#!/usr/bin/env node
/**
 * Zero-dependency installer and CDP shortcut helper for Antigravity Font Tuner.
 *
 * Commands:
 *   node install.mjs install
 *   node install.mjs uninstall [--purge-data]
 *   node install.mjs enable-cdp
 *   node install.mjs status
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_NAME = 'antigravity-font-tuner';
const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const COPY_ITEMS = ['plugin.json', 'assets', 'sidecars'];

function resolvedHome() {
  return process.env.ANTIGRAVITY_TEST_HOME || homedir();
}

function getPaths() {
  const home = resolvedHome();
  const pluginDir = join(home, '.gemini', 'config', 'plugins', PLUGIN_NAME);
  const dataDir = join(home, '.gemini', 'antigravity', 'sidecar_data', PLUGIN_NAME, 'font_tuner', 'data');
  const fontsDir = join(dataDir, 'fonts');
  const portFile = process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort')
    : process.platform === 'win32'
      ? join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Antigravity', 'DevToolsActivePort')
      : join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'Antigravity', 'DevToolsActivePort');
  return { pluginDir, dataDir, fontsDir, portFile };
}

function readPortState(portFile) {
  try {
    const raw = readFileSync(portFile, 'utf8').split(/\r?\n/)[0].trim();
    if (/^\d{1,5}$/.test(raw) && Number(raw) > 0 && Number(raw) <= 65535) {
      return { ready: true, port: Number(raw) };
    }
  } catch {}
  return { ready: false, port: null };
}

function printHelp() {
  console.log(`Antigravity Font Tuner Installer

Usage:
  node install.mjs install         Install or update plugin into ~/.gemini/config/plugins/${PLUGIN_NAME}
  node install.mjs enable-cdp      Ensure Antigravity shortcuts pass --remote-debugging-port=0 (Windows)
                                   or print launch instructions (macOS/Linux)
  node install.mjs status          Show installation, CDP, and custom fonts directory status
  node install.mjs uninstall       Remove plugin (--purge-data also deletes settings & fonts)
  node install.mjs --help          Show this help
`);
}

function doInstall() {
  const { pluginDir, fontsDir, portFile } = getPaths();
  mkdirSync(dirname(pluginDir), { recursive: true });
  mkdirSync(fontsDir, { recursive: true });

  const tempDir = `${pluginDir}.staging-${process.pid}`;
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });

  for (const item of COPY_ITEMS) {
    const src = join(REPO_ROOT, item);
    if (!existsSync(src)) {
      rmSync(tempDir, { recursive: true, force: true });
      throw new Error(`Missing required source asset: ${src}`);
    }
    cpSync(src, join(tempDir, item), { recursive: true });
  }

  const marker = join(pluginDir, '.update-in-progress');
  try {
    if (existsSync(pluginDir)) writeFileSync(marker, '', 'utf8');
  } catch {}

  try {
    rmSync(pluginDir, { recursive: true, force: true });
    mkdirSync(pluginDir, { recursive: true });
    for (const item of COPY_ITEMS) {
      cpSync(join(tempDir, item), join(pluginDir, item), { recursive: true });
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(marker, { force: true });
  }

  const cdp = readPortState(portFile);
  console.log(`[ok] Installed plugin to: ${pluginDir}`);
  console.log(`[info] Custom font drop folder: ${fontsDir}`);
  if (cdp.ready) {
    console.log(`[ok] Active CDP detected on port ${cdp.port}. Restart Antigravity or reload plugins if needed.`);
  } else {
    console.log('[warn] DevToolsActivePort was not found.');
    console.log('       Run "node install.mjs enable-cdp" and restart Antigravity completely for CSS/font injection to work.');
  }
}

function doUninstall(purgeData) {
  const { pluginDir, dataDir } = getPaths();
  const sidecarDataRoot = resolve(dataDir, '..', '..');
  if (existsSync(pluginDir)) {
    rmSync(pluginDir, { recursive: true, force: true });
    console.log(`[ok] Removed plugin: ${pluginDir}`);
  } else {
    console.log(`[info] Plugin directory not present: ${pluginDir}`);
  }
  if (purgeData && existsSync(sidecarDataRoot)) {
    rmSync(sidecarDataRoot, { recursive: true, force: true });
    console.log(`[ok] Purged plugin settings & custom fonts: ${sidecarDataRoot}`);
  }
}

function doStatus() {
  const { pluginDir, fontsDir, portFile } = getPaths();
  const installed = existsSync(join(pluginDir, 'plugin.json'));
  const cdp = readPortState(portFile);
  console.log(`Plugin installed : ${installed ? 'YES' : 'NO'} (${pluginDir})`);
  console.log(`Custom fonts dir : ${fontsDir}${existsSync(fontsDir) ? '' : ' (not created yet)'}`);
  console.log(`CDP active port  : ${cdp.ready ? `YES (${cdp.port})` : `NO (${portFile})`}`);
}

function doEnableCdp() {
  if (process.platform === 'darwin') {
    console.log('macOS launch command with CDP enabled:');
    console.log('  open -a "Antigravity" --args --remote-debugging-port=0');
    console.log('Or quit Antigravity completely first, then run that command cleanly.');
    return;
  }
  if (process.platform !== 'win32') {
    console.log('Linux launch / .desktop Exec flag:');
    console.log('  antigravity --remote-debugging-port=0');
    console.log('Add --remote-debugging-port=0 to your .desktop Exec= line and restart Antigravity.');
    return;
  }

  const psScript = `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$roots = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) ''),
  (Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

$links = foreach ($r in $roots) {
  Get-ChildItem -Path $r -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue
}
$found = 0
$updated = 0
$already = 0

foreach ($item in $links) {
  $sc = $shell.CreateShortcut($item.FullName)
  $target = [string]$sc.TargetPath
  $args = [string]$sc.Arguments
  if ($item.Name -match 'Antigravity' -or $target -match 'Antigravity(\\.exe)?$') {
    $found++
    if ($args -match '--remote-debugging-port=\\d+') {
      $already++
      Write-Output "OK_ALREADY|$($item.FullName)|$args"
    } else {
      $expected = if ($args.Trim()) { "$($args.Trim()) --remote-debugging-port=0" } else { '--remote-debugging-port=0' }
      $sc.Arguments = $expected
      $sc.Save()
      $verify = $shell.CreateShortcut($item.FullName)
      if ([string]$verify.Arguments -ceq $expected) {
        $updated++
        Write-Output "UPDATED|$($item.FullName)|$expected"
      } else {
        Write-Output "VERIFY_FAILED|$($item.FullName)|$($verify.Arguments)"
      }
    }
  }
}
Write-Output "SUMMARY|found=$found|already=$already|updated=$updated"
`;

  const shellExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const out = execFileSync(shellExe, ['-NoProfile', '-NonInteractive', '-Command', psScript], {
    encoding: 'utf8',
    windowsHide: true,
  });
  for (const line of out.trim().split(/\r?\n/)) {
    if (!line) continue;
    console.log(line);
  }
  console.log('\nNote: Restart Antigravity completely from an updated shortcut for CDP injection to activate.');
}

const args = process.argv.slice(2);
const cmd = args[0] || '--help';
const flags = new Set(args.slice(1));

try {
  if (cmd === 'install') doInstall();
  else if (cmd === 'uninstall') doUninstall(flags.has('--purge-data'));
  else if (cmd === 'enable-cdp') doEnableCdp();
  else if (cmd === 'status') doStatus();
  else printHelp();
} catch (err) {
  console.error('[error]', err?.message || err);
  process.exit(1);
}
