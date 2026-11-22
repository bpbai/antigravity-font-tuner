/**
 * Event-driven, low-overhead CDP style and dynamic FontFace injector.
 * - Verifies local Hub origin against Language Server daemon metadata
 * - Injects scoped & global UI typography CSS before uploading binary fonts
 * - Uses native OS font scanning + custom fonts/ folder without hardcoding paths
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildScopedCss } from './css_builder.mjs';
import { resolveFontSpecsForStacks } from './font_scanner.mjs';

const STYLE_ID = 'agy-font-tuner-style';
const CONNECTED_HEARTBEAT_MS = 25000;
const DISCOVERY_CACHE_MS = 20000;
const DISCONNECTED_BACKOFF_MS = [1500, 3000, 6000, 12000, 15000];
const FONT_CHUNK_CHARS = 1536 * 1024;
const YIELD_THRESHOLD_BYTES = 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Returns the platform-specific Antigravity DevToolsActivePort location.
 */
export function defaultPortFile() {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort');
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Antigravity', 'DevToolsActivePort');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Antigravity', 'DevToolsActivePort');
}

function createComposerOriginResolver(productRoots = [], env = process.env) {
  let session = null;
  return async function composerOrigin() {
    const address = env.ANTIGRAVITY_LS_ADDRESS;
    const token = env.ANTIGRAVITY_CSRF_TOKEN;
    const match = /^(127\.0\.0\.1|localhost):([1-9]\d{0,4})$/.exec(address || '');
    if (!match || +match[2] > 65535 || !token) return null;

    for (const root of productRoots) {
      let hub;
      try {
        hub = JSON.parse(readFileSync(join(root, 'daemon', `hub_${match[2]}.json`), 'utf8'));
      } catch {
        continue;
      }
      if (hub?.httpPort !== +match[2] || !Number.isInteger(hub.httpsPort) || hub.httpsPort < 1 || hub.httpsPort > 65535) {
        continue;
      }
      const origin = new URL(`https://127.0.0.1:${hub.httpsPort}`).origin;
      if (!session || session.address !== address || session.token !== token || session.origin !== origin || session.pid !== hub.pid) {
        session = { address, token, origin, pid: hub.pid, verified: false };
      }
      if (session.verified) return origin;
      try {
        const res = await fetch(`http://${match[1]}:${match[2]}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': token },
          body: '{}',
          redirect: 'error',
          signal: AbortSignal.timeout(3000),
        });
        await res.body?.cancel();
        if (res.ok) {
          session.verified = true;
          return origin;
        }
      } catch {
        // Ignore transient boot pause; next tick retries.
      }
      return null;
    }
    return null;
  };
}

function createPlanCompiler() {
  let cachedKey = '';
  let cachedPlan = { css: '', hash: 'disabled', specs: [], bridgedCount: 0 };
  return (settings, entries, entriesVersion) => {
    const key = `${entriesVersion}::${JSON.stringify(settings)}`;
    if (key === cachedKey) return cachedPlan;

    if (!settings?.enabled) {
      cachedKey = key;
      cachedPlan = { css: '', hash: 'disabled', specs: [], bridgedCount: 0 };
      return cachedPlan;
    }

    const { aliasMap, specs } = resolveFontSpecsForStacks(
      [settings.textFont || '', settings.codeFont || ''],
      entries || []
    );
    const css = buildScopedCss(settings, aliasMap);
    const hash = css ? createHash('sha256').update(css).digest('hex').slice(0, 16) : 'disabled';

    cachedKey = key;
    cachedPlan = { css, hash, specs, bridgedCount: aliasMap.size };
    return cachedPlan;
  };
}

function buildInjectExpression(css, hash) {
  const payload = JSON.stringify({ id: STYLE_ID, css, hash });
  return `(() => {
    const cfg = ${payload};
    const root = document.head || document.documentElement;
    if (!root) return 'no-root';
    let style = document.getElementById(cfg.id);
    if (!cfg.css) {
      if (style) style.remove();
      globalThis.__agyFontTunerObs?.disconnect();
      globalThis.__agyFontTunerObs = null;
      globalThis.__agyFontTunerCfg = null;
      globalThis.__agyFontTunerHash = 'disabled';
      return 'removed';
    }
    if (!style) {
      style = document.createElement('style');
      style.id = cfg.id;
      root.appendChild(style);
    } else if (style.parentElement !== root) {
      root.appendChild(style);
    }
    if (style.textContent !== cfg.css) {
      style.textContent = cfg.css;
    }
    globalThis.__agyFontTunerCfg = cfg;
    globalThis.__agyFontTunerHash = cfg.hash;
    if (!globalThis.__agyFontTunerObs && typeof MutationObserver === 'function') {
      const obs = new MutationObserver(() => {
        const c = globalThis.__agyFontTunerCfg;
        const r = document.head || document.documentElement;
        if (!c || !c.css || !r) return;
        let el = document.getElementById(c.id);
        if (!el) {
          el = document.createElement('style');
          el.id = c.id;
          el.textContent = c.css;
          r.appendChild(el);
        } else if (el.textContent !== c.css) {
          el.textContent = c.css;
        }
      });
      obs.observe(root, { childList: true });
      globalThis.__agyFontTunerObs = obs;
    }
    return 'applied';
  })()`;
}

function buildProbeExpression() {
  return `JSON.stringify({
    hasStyle: !!document.getElementById('${STYLE_ID}'),
    sampleP: (() => {
      const el = document.querySelector('[data-testid="conversation-view"] p');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { size: cs.fontSize, weight: cs.fontWeight, lineHeight: cs.lineHeight };
    })(),
    sampleCode: (() => {
      const el = document.querySelector('[data-testid="conversation-view"] pre code, [data-testid="conversation-view"] code');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { size: cs.fontSize };
    })(),
  })`;
}

/**
 * Starts the low-overhead CDP font and CSS injector.
 */
export function startFontInjector({
  getSettings,
  getFontInventory,
  productRoots = [],
  portFile = defaultPortFile(),
  onStatus,
} = {}) {
  const sockets = new Map();
  const resolveOrigin = createComposerOriginResolver(productRoots);
  const compilePlan = createPlanCompiler();

  let stopped = false;
  let status = 'initializing';
  let lastError = '';
  let cachedPages = [];
  let lastDiscoveryAt = 0;
  let backoffStep = 0;
  let lastProbeKey = '';
  let lastBridgedCount = 0;

  let nextTimer = null;
  let syncPromise = null;
  let resyncRequested = false;
  let forceDiscoverFlag = false;
  let forceHeartbeatFlag = false;
  let lastHeartbeatAt = 0;

  const setStatus = (next, err = '') => {
    const changed = next !== status || err !== lastError;
    status = next;
    lastError = err;
    if (changed) {
      console.log(`[font-tuner] state=${next} targets=${sockets.size}${err ? ' err=' + err : ''}`);
    }
    onStatus?.({ status, error: lastError, targets: sockets.size, bridgedFamilies: lastBridgedCount });
  };

  const scheduleNext = (delayMs) => {
    if (stopped) return;
    if (nextTimer) clearTimeout(nextTimer);
    nextTimer = setTimeout(() => {
      nextTimer = null;
      void requestSync();
    }, delayMs);
    nextTimer.unref?.();
  };

  const retire = (entry, id) => {
    if (entry.closed) return;
    entry.closed = true;
    for (const cb of entry.pending.values()) cb(undefined);
    entry.pending.clear();
    try { entry.ws.close(); } catch {}
    if (sockets.get(id) === entry) sockets.delete(id);
  };

  const sendCmd = (entry, method, params) => new Promise((resolve) => {
    if (entry.ws.readyState !== 1) return resolve(undefined);
    const id = entry.nextId++;
    const timer = setTimeout(() => { entry.pending.delete(id); resolve(undefined); }, 4000);
    entry.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg?.result); });
    try {
      entry.ws.send(JSON.stringify({ id, method, params }));
    } catch {
      clearTimeout(timer);
      entry.pending.delete(id);
      resolve(undefined);
    }
  });

  const evaluate = async (entry, expression) => {
    if (!entry.context || entry.closed) return undefined;
    const res = await sendCmd(entry, 'Runtime.evaluate', {
      uniqueContextId: entry.context,
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return res?.result?.value;
  };

  const connect = async (target) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const entry = {
      ws,
      pending: new Map(),
      nextId: 1,
      origin: new URL(target.url).origin,
      frameId: null,
      context: null,
      initialized: false,
      appliedHash: '',
      loadedSpecKeys: new Set(),
      probedForKey: '',
      closed: false,
    };
    await new Promise((resolve, reject) => {
      const fail = (msg) => { clearTimeout(timer); retire(entry, target.id); reject(new Error(msg)); };
      const timer = setTimeout(() => fail('ws timeout'), 3000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => fail('ws error');
    });
    if (stopped) {
      retire(entry, target.id);
      throw new Error('stopped');
    }
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.method === 'Runtime.executionContextCreated') {
          const ctx = msg.params?.context;
          if (ctx?.auxData?.isDefault && ctx.auxData.frameId === entry.frameId) {
            entry.context = ctx.origin === entry.origin ? ctx.uniqueId : null;
            if (entry.initialized && entry.context) {
              entry.appliedHash = '';
              entry.probedForKey = '';
              entry.loadedSpecKeys.clear();
              scheduleNext(40);
            }
          }
        } else if (
          msg.method === 'Runtime.executionContextsCleared' ||
          (msg.method === 'Runtime.executionContextDestroyed' && msg.params?.executionContextUniqueId === entry.context)
        ) {
          entry.context = null;
          entry.appliedHash = '';
          entry.probedForKey = '';
          entry.loadedSpecKeys.clear();
        }
        const cb = entry.pending.get(msg.id);
        if (cb) {
          entry.pending.delete(msg.id);
          cb(msg);
        }
      } catch {}
    };
    ws.onerror = ws.onclose = () => retire(entry, target.id);
    sockets.set(target.id, entry);

    const tree = await sendCmd(entry, 'Page.getFrameTree', {});
    entry.frameId = tree?.frameTree?.frame?.id || null;
    if (!entry.frameId || !(await sendCmd(entry, 'Runtime.enable', {}))) {
      retire(entry, target.id);
      throw new Error('runtime init failed');
    }
    entry.initialized = true;
    return entry;
  };

  const discoverPages = async (force) => {
    const now = Date.now();
    if (!force && sockets.size > 0 && lastDiscoveryAt && now - lastDiscoveryAt < DISCOVERY_CACHE_MS) {
      return cachedPages;
    }
    let port;
    try {
      port = readFileSync(portFile, 'utf8').split(/\r?\n/)[0].trim();
    } catch {
      setStatus('no-cdp-port', 'DevToolsActivePort not found');
      return [];
    }
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      setStatus('bad-cdp-port', 'Invalid CDP port');
      return [];
    }
    const origin = await resolveOrigin();
    if (!origin) {
      setStatus('waiting-ls', 'Waiting for verified Hub origin');
      return [];
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(3000),
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const targets = await res.json();
      const wsOrigin = new URL(`ws://127.0.0.1:${Number(port)}`).origin;
      cachedPages = targets.filter((t) => {
        if (t?.type !== 'page' || typeof t.id !== 'string' || !t.id) return false;
        if (!URL.canParse(t.url) || new URL(t.url).origin !== origin) return false;
        if (!URL.canParse(t.webSocketDebuggerUrl)) return false;
        const ws = new URL(t.webSocketDebuggerUrl);
        return ws.origin === wsOrigin && ws.pathname === `/devtools/page/${t.id}`;
      });
      lastDiscoveryAt = Date.now();
      const activeIds = new Set(cachedPages.map((t) => t.id));
      for (const [id, entry] of sockets) {
        if (!activeIds.has(id) || entry.origin !== origin) retire(entry, id);
      }
      return cachedPages;
    } catch (err) {
      setStatus('cdp-unreachable', err?.message || 'CDP fetch failed');
      return [];
    }
  };

  const ensureSpecsLoaded = async (entry, specs) => {
    if (!specs.length) return false;
    const withKeys = [];
    for (const spec of specs) {
      if (!existsSync(spec.filePath)) continue;
      let st;
      try {
        st = statSync(spec.filePath);
      } catch {
        continue;
      }
      const key = `${spec.filePath}::${Math.round(st.mtimeMs)}::${spec.family}::${spec.weight}::${spec.style}`;
      if (!entry.loadedSpecKeys.has(key)) {
        withKeys.push({ ...spec, key, fileSize: st.size });
      }
    }
    if (!withKeys.length) return false;

    const existingJson = await evaluate(entry, 'JSON.stringify([...(globalThis.__agyLoadedSpecKeys || [])])');
    try {
      for (const k of JSON.parse(existingJson || '[]')) {
        entry.loadedSpecKeys.add(k);
      }
    } catch {}

    const pendingSpecs = withKeys.filter((item) => !entry.loadedSpecKeys.has(item.key));
    if (!pendingSpecs.length) return false;

    let uploadedAny = false;
    const newlyLoaded = [];
    for (const spec of pendingSpecs) {
      if (stopped || entry.closed) break;
      let b64 = readFileSync(spec.filePath).toString('base64');
      try {
        await evaluate(entry, 'globalThis.__agyFontChunks = []');
        for (let i = 0; i < b64.length; i += FONT_CHUNK_CHARS) {
          const chunk = JSON.stringify(b64.slice(i, i + FONT_CHUNK_CHARS));
          await evaluate(entry, `globalThis.__agyFontChunks.push(${chunk})`);
        }
        b64 = '';
        const meta = JSON.stringify({ family: spec.family, weight: spec.weight, style: spec.style });
        const statusRes = await evaluate(entry, `(async () => {
          const meta = ${meta};
          const rawB64 = (globalThis.__agyFontChunks || []).join('');
          globalThis.__agyFontChunks = null;
          let bytes;
          if (typeof Uint8Array.fromBase64 === 'function') {
            bytes = Uint8Array.fromBase64(rawB64);
          } else {
            const bin = atob(rawB64);
            bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          }
          const face = new FontFace(meta.family, bytes.buffer, { weight: meta.weight, style: meta.style });
          await face.load();
          document.fonts.add(face);
          return face.status;
        })()`);
        if (statusRes === 'loaded') {
          uploadedAny = true;
          newlyLoaded.push(spec.key);
          entry.loadedSpecKeys.add(spec.key);
        }
      } catch {
        // Ignore single broken font file so other faces still load.
      } finally {
        b64 = '';
        await evaluate(entry, 'globalThis.__agyFontChunks = null').catch(() => {});
      }
      if (spec.fileSize > YIELD_THRESHOLD_BYTES) {
        await sleep(15);
      }
    }

    if (newlyLoaded.length) {
      const payload = JSON.stringify(newlyLoaded);
      await evaluate(entry, `(() => {
        const set = globalThis.__agyLoadedSpecKeys || (globalThis.__agyLoadedSpecKeys = new Set());
        for (const k of ${payload}) set.add(k);
      })()`);
    }
    return uploadedAny;
  };

  const runSyncPass = async () => {
    const forceDiscover = forceDiscoverFlag;
    const forceHeartbeat = forceHeartbeatFlag || Date.now() - lastHeartbeatAt >= CONNECTED_HEARTBEAT_MS;
    forceDiscoverFlag = false;
    forceHeartbeatFlag = false;

    const settings = getSettings();
    const inv = getFontInventory ? getFontInventory() : { entries: [], version: 0 };
    const plan = compilePlan(settings, inv.entries, inv.version);
    lastBridgedCount = plan.bridgedCount;

    const pages = await discoverPages(forceDiscover || sockets.size === 0);
    if (!pages.length) {
      const delay = DISCONNECTED_BACKOFF_MS[Math.min(backoffStep, DISCONNECTED_BACKOFF_MS.length - 1)];
      backoffStep++;
      scheduleNext(delay);
      return;
    }

    let appliedCount = 0;
    for (const target of pages) {
      if (stopped) break;
      try {
        const isNew = !sockets.has(target.id);
        const entry = sockets.get(target.id) || (await connect(target));
        if (!entry.context) continue;

        let needsInject = entry.appliedHash !== plan.hash;
        if (!needsInject && (isNew || forceHeartbeat)) {
          const inPageHash = await evaluate(entry, 'globalThis.__agyFontTunerHash ?? ""');
          if (inPageHash !== plan.hash) needsInject = true;
        }

        if (needsInject) {
          const injectRes = await evaluate(entry, buildInjectExpression(plan.css, plan.hash));
          if (injectRes === 'applied' || injectRes === 'removed') {
            entry.appliedHash = plan.hash;
          }
        }

        let uploadedFonts = false;
        if (settings.enabled && plan.specs.length > 0) {
          uploadedFonts = await ensureSpecsLoaded(entry, plan.specs);
        }

        if (settings.enabled && (needsInject || uploadedFonts) && entry.probedForKey !== `${plan.hash}:${uploadedFonts}`) {
          const probeJson = await evaluate(entry, buildProbeExpression());
          entry.probedForKey = `${plan.hash}:${uploadedFonts}`;
          if (probeJson && probeJson !== lastProbeKey) {
            lastProbeKey = probeJson;
            console.log('[font-tuner] probe:', probeJson);
          }
        }
        appliedCount++;
      } catch (err) {
        const entry = sockets.get(target.id);
        if (entry) retire(entry, target.id);
        lastError = err?.message || 'injection error';
      }
    }

    if (forceHeartbeat) lastHeartbeatAt = Date.now();
    if (appliedCount > 0) {
      backoffStep = 0;
      setStatus(settings.enabled ? 'active' : 'paused', '');
      scheduleNext(CONNECTED_HEARTBEAT_MS);
    } else {
      const delay = DISCONNECTED_BACKOFF_MS[Math.min(backoffStep, DISCONNECTED_BACKOFF_MS.length - 1)];
      backoffStep++;
      scheduleNext(delay);
    }
  };

  const requestSync = (opts = {}) => {
    if (stopped) return Promise.resolve();
    if (opts.forceDiscover) forceDiscoverFlag = true;
    if (opts.forceHeartbeat) forceHeartbeatFlag = true;
    resyncRequested = true;
    if (syncPromise) return syncPromise;
    syncPromise = (async () => {
      while (resyncRequested && !stopped) {
        resyncRequested = false;
        await runSyncPass();
      }
    })().finally(() => {
      syncPromise = null;
    });
    return syncPromise;
  };

  void requestSync();

  return {
    tick: (opts) => requestSync(opts),
    getState: () => ({ status, error: lastError, targets: sockets.size, bridgedFamilies: lastBridgedCount }),
    async stop() {
      if (stopped) return;
      stopped = true;
      if (nextTimer) {
        clearTimeout(nextTimer);
        nextTimer = null;
      }
      await Promise.all(
        [...sockets].map(async ([id, entry]) => {
          try {
            await Promise.race([
              evaluate(entry, buildInjectExpression('', 'disabled')),
              sleep(800),
            ]);
          } finally {
            retire(entry, id);
          }
        })
      );
    },
  };
}
