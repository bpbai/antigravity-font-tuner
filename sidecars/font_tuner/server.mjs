/**
 * Sidecar server for Antigravity Font Tuner.
 * Hosts the auxiliary settings pane, manages custom/system font inventory,
 * and drives the low-overhead event-driven CDP style & FontFace injector.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, normalizeSettings } from './css_builder.mjs';
import { startFontInjector } from './cdp_injector.mjs';
import { scanInstalledFonts } from './font_scanner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LS_WATCHDOG_INTERVAL_MS = 30000;
const LS_WATCHDOG_MAX_FAILS = 4;
const LS_WATCHDOG_WINDOW_MS = 110000;

function installEpipeGuard() {
  for (const stream of [process.stdout, process.stderr]) {
    stream?.on?.('error', (err) => {
      if (err?.code === 'EPIPE') return;
      throw err;
    });
  }
}

function resolveSidecarDataDir() {
  const explicit = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (explicit) return explicit;
  return join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'antigravity-font-tuner', 'font_tuner', 'data');
}

function resolveProductRoots() {
  const roots = [];
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    let dir = resolve(dataDir);
    while (dir !== dirname(dir)) {
      if (basename(dir) === 'sidecar_data') {
        roots.push(dirname(dir));
        break;
      }
      dir = dirname(dir);
    }
  }
  for (const product of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
    const p = join(homedir(), '.gemini', product);
    if (!roots.includes(p)) roots.push(p);
  }
  return roots;
}

const DATA_DIR = resolveSidecarDataDir();
const SETTINGS_PATH = join(DATA_DIR, 'settings.json');
const CUSTOM_FONTS_DIR = join(DATA_DIR, 'fonts');
let lastSavedSerialized = '';

function ensureDirs() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(CUSTOM_FONTS_DIR, { recursive: true });
}

function loadSettings() {
  try {
    if (!existsSync(SETTINGS_PATH)) return { ...DEFAULT_SETTINGS };
    const raw = readFileSync(SETTINGS_PATH, 'utf8');
    const normalized = normalizeSettings(JSON.parse(raw));
    lastSavedSerialized = JSON.stringify(normalized, null, 2) + '\n';
    return normalized;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(next) {
  ensureDirs();
  const normalized = normalizeSettings(next);
  const serialized = JSON.stringify(normalized, null, 2) + '\n';
  const tmp = `${SETTINGS_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, serialized, 'utf8');
  renameSync(tmp, SETTINGS_PATH);
  lastSavedSerialized = serialized;
  return normalized;
}

function openCustomFontsFolder() {
  ensureDirs();
  const cmd = process.platform === 'win32'
    ? 'explorer.exe'
    : process.platform === 'darwin'
      ? 'open'
      : 'xdg-open';
  const child = spawn(cmd, [CUSTOM_FONTS_DIR], {
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => {});
  child.unref();
}

let currentSettings = loadSettings();
if (!existsSync(SETTINGS_PATH)) {
  currentSettings = saveSettings(currentSettings);
} else {
  ensureDirs();
}

let inventoryVersion = 1;
let fontInventory = {
  version: inventoryVersion,
  customDir: CUSTOM_FONTS_DIR,
  families: [],
  customFamilies: [],
  systemFamilies: [],
  customFiles: [],
  entries: [],
};

function refreshFontInventory() {
  ensureDirs();
  const scanned = scanInstalledFonts({ customDirs: [CUSTOM_FONTS_DIR] });
  inventoryVersion++;
  fontInventory = {
    version: inventoryVersion,
    customDir: CUSTOM_FONTS_DIR,
    ...scanned,
  };
  return fontInventory;
}

function getPublicInventoryInfo() {
  return {
    customDir: fontInventory.customDir,
    customFamilies: fontInventory.customFamilies,
    systemFamilies: fontInventory.systemFamilies,
    customFiles: fontInventory.customFiles,
    totalFamilies: fontInventory.families.length,
  };
}

const UI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Font Tuner</title>
  <script src="/preload.js"></script>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 14px;
      background: var(--background, transparent);
      color: var(--foreground, #e4e4e7);
      font-family: var(--font-family, "Inter", "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif);
      font-size: 13px;
      line-height: 1.5;
    }
    .card {
      border: 1px solid var(--border, rgba(128,128,128,0.22));
      border-radius: 10px;
      padding: 12px;
      margin-bottom: 12px;
      background: var(--card, rgba(128,128,128,0.06));
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .title { font-size: 14px; font-weight: 600; margin: 0; }
    .muted { color: var(--muted-foreground, #a1a1aa); font-size: 12px; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--border, rgba(128,128,128,0.25));
      font-weight: 500;
      white-space: nowrap;
    }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #9ca3af; }
    .dot.ok { background: #22c55e; }
    .dot.warn { background: #f59e0b; }
    .dot.err { background: #ef4444; }
    .grid2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    @media (max-width: 340px) {
      .grid2 { grid-template-columns: 1fr; }
    }
    .field { margin-top: 10px; }
    .field label {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      font-weight: 500;
      margin-bottom: 3px;
    }
    input[type="range"] { width: 100%; accent-color: var(--primary, #3b82f6); }
    input[type="text"], select {
      width: 100%;
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid var(--border, rgba(128,128,128,0.3));
      background: var(--background, rgba(0,0,0,0.12));
      color: inherit;
      font-size: 12px;
    }
    input[type="text"] {
      font-family: ui-monospace, Consolas, monospace;
    }
    .picker-row {
      display: flex;
      gap: 6px;
      margin-top: 5px;
    }
    .picker-row select { flex: 1; min-width: 0; }
    .switch-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-top: 8px;
      font-size: 12.5px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }
    button {
      padding: 6px 11px;
      border-radius: 6px;
      border: 1px solid var(--border, rgba(128,128,128,0.3));
      background: var(--secondary, rgba(128,128,128,0.14));
      color: inherit;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
    }
    button.primary {
      background: var(--primary, #3b82f6);
      color: var(--primary-foreground, #ffffff);
      border-color: transparent;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-top: 6px;
    }
    .chip {
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 5px;
      border: 1px solid var(--border, rgba(128,128,128,0.25));
      background: rgba(128,128,128,0.08);
    }
    code.path {
      font-family: ui-monospace, Consolas, monospace;
      font-size: 11px;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="row">
      <div>
        <h2 class="title">Antigravity 字体调节</h2>
        <div class="muted">全界面字体替换 + Chat/代码独立排版（不改整体缩放）</div>
      </div>
      <span class="badge"><span id="statusDot" class="dot"></span><span id="statusText">检测中</span></span>
    </div>
    <div id="statusDetail" class="muted" style="margin-top:6px;"></div>
  </div>

  <div class="card">
    <div class="switch-row" style="margin-top:0;">
      <span>启用字体与字号覆盖</span>
      <input type="checkbox" id="enabled">
    </div>
    <div class="switch-row">
      <span>全局强制统一 UI 字体（侧边栏/按钮/面板，保留图标）</span>
      <input type="checkbox" id="forceGlobalUiFont">
    </div>
    <div class="switch-row">
      <span>同步全局 CSS 字体变量（--font-sans / --font-mono）</span>
      <input type="checkbox" id="applyGlobalFontFace">
    </div>
    <div class="switch-row">
      <span>开启代码连字 (calt / liga)</span>
      <input type="checkbox" id="ligatures">
    </div>

    <div class="grid2">
      <div class="field">
        <label><span>Chat 正文字号</span><span id="chatSizeVal">20 px</span></label>
        <input type="range" id="chatFontSize" min="12" max="32" step="1">
      </div>
      <div class="field">
        <label><span>代码块字号</span><span id="codeSizeVal">20 px</span></label>
        <input type="range" id="codeFontSize" min="12" max="32" step="1">
      </div>
      <div class="field">
        <label><span>正文行高</span><span id="lineHeightVal">1.65</span></label>
        <input type="range" id="lineHeight" min="1.2" max="2.4" step="0.05">
      </div>
      <div class="field">
        <label><span>代码行高</span><span id="codeLineHeightVal">1.6</span></label>
        <input type="range" id="codeLineHeight" min="1.2" max="2.2" step="0.05">
      </div>
      <div class="field">
        <label><span>段落行距</span><span id="paragraphSpacingVal">原生</span></label>
        <input type="range" id="paragraphSpacing" min="0" max="28" step="1">
      </div>
      <div class="field">
        <label><span>正文字距</span><span id="letterSpacingVal">默认</span></label>
        <input type="range" id="letterSpacing" min="-0.04" max="0.1" step="0.005">
      </div>
    </div>

    <div class="field">
      <label><span>正文字体栈</span></label>
      <input type="text" id="textFont">
      <div class="picker-row">
        <select id="textFontPicker"></select>
        <button type="button" id="textPrependBtn">设为首选</button>
        <button type="button" id="textAppendBtn">追加</button>
      </div>
    </div>

    <div class="field">
      <label><span>代码字体栈</span></label>
      <input type="text" id="codeFont">
      <div class="picker-row">
        <select id="codeFontPicker"></select>
        <button type="button" id="codePrependBtn">设为首选</button>
        <button type="button" id="codeAppendBtn">追加</button>
      </div>
    </div>

    <div class="actions">
      <button type="button" class="primary" id="saveBtn">应用并保存</button>
      <button type="button" id="resetBtn">恢复默认</button>
    </div>
    <div id="saveMsg" class="muted" style="margin-top:6px;"></div>
  </div>

  <div class="card">
    <div class="row">
      <div>
        <div style="font-size:12.5px;font-weight:600;">自定义字体目录（免安装系统字体）</div>
        <div class="muted" id="fontStats">正在读取本机与自定义字体...</div>
      </div>
    </div>
    <div class="muted" style="margin-top:6px;">
      将 <code class="path">.ttf / .otf / .woff2</code> 放入：<br>
      <code class="path" id="customDirPath">-</code>
    </div>
    <div id="customChips" class="chips"></div>
    <div class="actions" style="margin-top:10px;">
      <button type="button" id="openFontsDirBtn">打开字体目录</button>
      <button type="button" id="rescanBtn">重新扫描</button>
    </div>
  </div>

  <script>
    (() => {
      const $ = (id) => document.getElementById(id);
      const api = async (path, method = 'GET', body) => {
        const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
        const opts = { method };
        if (body !== undefined) {
          opts.headers = { 'Content-Type': 'application/json' };
          opts.body = JSON.stringify(body);
        }
        const res = await f(path, opts);
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
      };

      const STATUS_MAP = {
        'active': ['ok', '已注入生效'],
        'paused': ['warn', '已暂停覆盖'],
        'no-cdp-port': ['err', '未找到 DevToolsActivePort'],
        'cdp-unreachable': ['err', 'CDP 端口不可达'],
        'waiting-ls': ['warn', '等待本地服务就绪'],
        'initializing': ['warn', '正在连接...'],
      };

      const SLIDERS = [
        ['chatFontSize', 'chatSizeVal', (v) => v + ' px'],
        ['codeFontSize', 'codeSizeVal', (v) => v + ' px'],
        ['lineHeight', 'lineHeightVal', (v) => String(v)],
        ['codeLineHeight', 'codeLineHeightVal', (v) => String(v)],
        ['paragraphSpacing', 'paragraphSpacingVal', (v) => Number(v) === 0 ? '原生' : v + ' px'],
        ['letterSpacing', 'letterSpacingVal', (v) => Number(v) === 0 ? '默认' : v + ' em'],
      ];

      function renderStatus(cdp) {
        const [cls, label] = STATUS_MAP[cdp?.status] || ['warn', cdp?.status || '未知'];
        $('statusDot').className = 'dot ' + cls;
        $('statusText').textContent = label + (cdp?.targets ? ' (' + cdp.targets + ')' : '');
        $('statusDetail').textContent = cdp?.error
          ? '提示: ' + cdp.error + '（请运行 node install.mjs enable-cdp 后重启 Antigravity）'
          : '已桥接 ' + (cdp?.bridgedFamilies || 0) + ' 个字体族 · 不修改 app.asar，AGY 更新不受影响。';
      }

      function populatePicker(selectEl, inv, emptyLabel) {
        selectEl.textContent = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = emptyLabel;
        selectEl.appendChild(placeholder);

        const groups = [
          ['自定义 fonts 目录 (' + (inv.customFamilies?.length || 0) + ')', inv.customFamilies || []],
          ['本机已安装字体 (' + (inv.systemFamilies?.length || 0) + ')', inv.systemFamilies || []],
        ];
        for (const [label, items] of groups) {
          if (!items.length) continue;
          const grp = document.createElement('optgroup');
          grp.label = label;
          for (const fam of items) {
            const opt = document.createElement('option');
            opt.value = fam;
            opt.textContent = fam;
            grp.appendChild(opt);
          }
          selectEl.appendChild(grp);
        }
      }

      function renderFonts(inv) {
        if (!inv) return;
        $('customDirPath').textContent = inv.customDir || '-';
        $('fontStats').textContent =
          '自定义目录: ' + (inv.customFiles?.length || 0) + ' 个文件 · 本机可用字体族: ' + (inv.totalFamilies || 0);
        populatePicker($('textFontPicker'), inv, '选择字体快速填入正文字体栈...');
        populatePicker($('codeFontPicker'), inv, '选择字体快速填入代码字体栈...');

        const chips = $('customChips');
        chips.textContent = '';
        for (const f of inv.customFiles || []) {
          const el = document.createElement('span');
          el.className = 'chip';
          el.textContent = f.family + ' (' + f.name + ')';
          chips.appendChild(el);
        }
      }

      function insertFontToken(inputEl, family, mode) {
        if (!family) return;
        const quoted = '"' + family.replace(/"/g, '') + '"';
        const parts = inputEl.value
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p && p.replace(/^['"]|['"]$/g, '').toLowerCase() !== family.toLowerCase());
        if (mode === 'prepend') parts.unshift(quoted);
        else parts.push(quoted);
        inputEl.value = parts.join(', ');
      }

      function fillForm(s) {
        $('enabled').checked = !!s.enabled;
        $('forceGlobalUiFont').checked = !!s.forceGlobalUiFont;
        $('applyGlobalFontFace').checked = !!s.applyGlobalFontFace;
        $('ligatures').checked = !!s.ligatures;
        for (const [id, valId, fmt] of SLIDERS) {
          $(id).value = s[id];
          $(valId).textContent = fmt(s[id]);
        }
        $('textFont').value = s.textFont;
        $('codeFont').value = s.codeFont;
      }

      function readForm() {
        return {
          enabled: $('enabled').checked,
          forceGlobalUiFont: $('forceGlobalUiFont').checked,
          applyGlobalFontFace: $('applyGlobalFontFace').checked,
          ligatures: $('ligatures').checked,
          chatFontSize: Number($('chatFontSize').value),
          codeFontSize: Number($('codeFontSize').value),
          lineHeight: Number($('lineHeight').value),
          codeLineHeight: Number($('codeLineHeight').value),
          paragraphSpacing: Number($('paragraphSpacing').value),
          letterSpacing: Number($('letterSpacing').value),
          textFont: $('textFont').value,
          codeFont: $('codeFont').value,
        };
      }

      async function save(payload) {
        $('saveMsg').textContent = '正在应用...';
        try {
          const res = await api('/api/settings', 'POST', payload);
          fillForm(res.settings);
          renderStatus(res.cdp);
          $('saveMsg').textContent = '已立即生效并保存';
        } catch (err) {
          $('saveMsg').textContent = '保存失败: ' + err.message;
        }
      }

      for (const [id, valId, fmt] of SLIDERS) {
        $(id).addEventListener('input', () => { $(valId).textContent = fmt($(id).value); });
      }
      $('textPrependBtn').addEventListener('click', () => {
        insertFontToken($('textFont'), $('textFontPicker').value, 'prepend');
      });
      $('textAppendBtn').addEventListener('click', () => {
        insertFontToken($('textFont'), $('textFontPicker').value, 'append');
      });
      $('codePrependBtn').addEventListener('click', () => {
        insertFontToken($('codeFont'), $('codeFontPicker').value, 'prepend');
      });
      $('codeAppendBtn').addEventListener('click', () => {
        insertFontToken($('codeFont'), $('codeFontPicker').value, 'append');
      });

      $('saveBtn').addEventListener('click', () => void save(readForm()));
      $('resetBtn').addEventListener('click', () => void save({ reset: true }));
      for (const id of ['enabled', 'forceGlobalUiFont', 'applyGlobalFontFace', 'ligatures']) {
        $(id).addEventListener('change', () => void save(readForm()));
      }

      $('openFontsDirBtn').addEventListener('click', async () => {
        try {
          await api('/api/open-fonts-dir', 'POST', {});
          $('saveMsg').textContent = '已打开自定义字体目录，放入字体后点击“重新扫描”';
        } catch (err) {
          $('saveMsg').textContent = '打开失败: ' + err.message;
        }
      });

      $('rescanBtn').addEventListener('click', async () => {
        $('saveMsg').textContent = '正在扫描字体...';
        try {
          const res = await api('/api/rescan', 'POST', {});
          renderFonts(res.fonts);
          renderStatus(res.cdp);
          $('saveMsg').textContent = '扫描完成（共 ' + (res.fonts?.totalFamilies || 0) + ' 个字体族）';
        } catch (err) {
          $('saveMsg').textContent = '扫描失败: ' + err.message;
        }
      });

      async function refreshState(loadFull = false) {
        try {
          const res = await api('/api/state', 'GET');
          if (loadFull) {
            fillForm(res.settings);
            renderFonts(res.fonts);
          }
          renderStatus(res.cdp);
        } catch (err) {
          if (loadFull) {
            $('statusText').textContent = '加载失败';
            $('statusDetail').textContent = err.message;
          }
        }
      }

      refreshState(true);
      setInterval(() => {
        if (!document.hidden) void refreshState(false);
      }, 12000);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) void refreshState(false);
      });
    })();
  </script>
</body>
</html>`;

function startSelfReloadWatcher(directory, onChanged) {
  const pluginDir = resolve(directory, '../..');
  const snapshot = () => {
    try {
      if (existsSync(join(pluginDir, '.update-in-progress'))) return null;
      const files = readdirSync(directory).filter((n) => /\.(mjs|js|json|html|css)$/.test(n)).sort();
      return JSON.stringify(
        [...files.map((n) => join(directory, n)), join(pluginDir, 'plugin.json')].map((f) => {
          const st = statSync(f);
          return [f, st.mtimeMs, st.size];
        })
      );
    } catch {
      return null;
    }
  };

  let base = snapshot();
  let debounce = null;
  const watchers = [];
  const check = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      const cur = snapshot();
      if (cur && base && cur !== base) {
        cleanup();
        onChanged();
      }
    }, 600);
    debounce.unref?.();
  };

  for (const dir of [directory, pluginDir]) {
    try {
      const w = watch(dir, { persistent: false }, (_eventType, filename) => {
        if (!filename || /\.(mjs|js|json|html|css)$/.test(String(filename))) check();
      });
      watchers.push(w);
    } catch {}
  }

  function cleanup() {
    if (debounce) clearTimeout(debounce);
    for (const w of watchers) {
      try { w.close(); } catch {}
    }
  }
  return cleanup;
}

function watchExternalSettingsAndFonts({ onSettingsReload, onFontsChanged }) {
  let settingsDebounce = null;
  let fontsDebounce = null;
  const watchers = [];

  try {
    ensureDirs();
    watchers.push(
      watch(DATA_DIR, { persistent: false }, (_eventType, filename) => {
        if (filename && String(filename) !== 'settings.json') return;
        if (settingsDebounce) clearTimeout(settingsDebounce);
        settingsDebounce = setTimeout(() => {
          try {
            if (!existsSync(SETTINGS_PATH)) return;
            const raw = readFileSync(SETTINGS_PATH, 'utf8');
            if (raw === lastSavedSerialized) return;
            onSettingsReload(loadSettings());
          } catch {}
        }, 250);
        settingsDebounce.unref?.();
      })
    );
  } catch {}

  try {
    watchers.push(
      watch(CUSTOM_FONTS_DIR, { persistent: false }, () => {
        if (fontsDebounce) clearTimeout(fontsDebounce);
        fontsDebounce = setTimeout(() => onFontsChanged(), 600);
        fontsDebounce.unref?.();
      })
    );
  } catch {}

  return () => {
    if (settingsDebounce) clearTimeout(settingsDebounce);
    if (fontsDebounce) clearTimeout(fontsDebounce);
    for (const w of watchers) {
      try { w.close(); } catch {}
    }
  };
}

function startLsWatchdog(lsAddr, onGone) {
  if (!lsAddr) return () => {};
  let failures = 0;
  let firstFailAt = 0;
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const res = await fetch(`http://${lsAddr}/healthz`, { signal: AbortSignal.timeout(2500) });
      await res.body?.cancel();
      if (res.ok) {
        failures = 0;
        firstFailAt = 0;
        return;
      }
    } catch {
      // Transient busy pause or host shutdown.
    } finally {
      busy = false;
    }
    const now = Date.now();
    if (!firstFailAt) firstFailAt = now;
    failures++;
    if (failures >= LS_WATCHDOG_MAX_FAILS && now - firstFailAt >= LS_WATCHDOG_WINDOW_MS) {
      clearInterval(timer);
      onGone('language server unreachable');
    }
  }, LS_WATCHDOG_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain && (process.env.ANTIGRAVITY_LS_ADDRESS || process.env.ANTIGRAVITY_SIDECAR_WEB_PORT)) {
  installEpipeGuard();
  refreshFontInventory();

  const injector = startFontInjector({
    getSettings: () => currentSettings,
    getFontInventory: () => fontInventory,
    productRoots: resolveProductRoots(),
  });

  const stopDataWatches = watchExternalSettingsAndFonts({
    onSettingsReload: (next) => {
      currentSettings = next;
      void injector.tick();
    },
    onFontsChanged: () => {
      refreshFontInventory();
      void injector.tick();
    },
  });

  let stopping = false;
  const shutdown = async (reason) => {
    if (stopping) return;
    stopping = true;
    stopWatchdog();
    stopReload();
    stopDataWatches();
    console.log('[font-tuner] stopping:', reason);
    try {
      await injector.stop();
    } finally {
      process.exit(0);
    }
  };

  const stopReload = startSelfReloadWatcher(__dirname, () => void shutdown('plugin files changed'));
  const stopWatchdog = startLsWatchdog(process.env.ANTIGRAVITY_LS_ADDRESS, shutdown);
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => void shutdown(sig));
  }

  if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT && process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN?.trim()) {
    const { SidecarApp } = await import('sidecar_sdk');
    const app = new SidecarApp();
    app.page('/', () => UI_HTML);
    app.api('/api/state', () => ({
      settings: currentSettings,
      cdp: injector.getState(),
      fonts: getPublicInventoryInfo(),
    }), 'GET');
    app.api('/api/settings', async (data) => {
      currentSettings = data?.reset ? saveSettings(DEFAULT_SETTINGS) : saveSettings({ ...currentSettings, ...data });
      await injector.tick();
      return { ok: true, settings: currentSettings, cdp: injector.getState() };
    }, 'POST');
    app.api('/api/rescan', async () => {
      refreshFontInventory();
      await injector.tick();
      return { ok: true, fonts: getPublicInventoryInfo(), cdp: injector.getState() };
    }, 'POST');
    app.api('/api/open-fonts-dir', () => {
      openCustomFontsFolder();
      return { ok: true, dir: CUSTOM_FONTS_DIR };
    }, 'POST');
    await app.run();
  }
}
