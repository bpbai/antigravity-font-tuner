/**
 * Builds scoped and optional global UI typography CSS for Antigravity
 * without altering overall zoom scale, sidebar proportions, UI icons, or Monaco editor metrics.
 */
import { rewriteStackWithAliases } from './font_scanner.mjs';

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  chatFontSize: 20,
  codeFontSize: 20,
  lineHeight: 1.65,
  codeLineHeight: 1.6,
  paragraphSpacing: 0,
  letterSpacing: 0,
  applyGlobalFontFace: true,
  forceGlobalUiFont: true,
  textFont: '"Inter", "MiSans Medium", "MiSans", "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", "Google Sans Flex", system-ui, sans-serif',
  codeFont: '"Maple Mono CN", "Maple Mono", "JetBrains Mono", "Cascadia Code", "Fira Code", ui-monospace, Consolas, monospace',
  ligatures: true,
});

function sanitizeCssValue(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.replace(/[;{}\r\n\\<>]/g, '').trim();
  return cleaned || fallback;
}

function clampNum(raw, min, max, fallback, decimals = 0) {
  const num = Number(raw);
  if (!Number.isFinite(num)) return fallback;
  const clamped = Math.min(max, Math.max(min, num));
  return decimals > 0 ? Number(clamped.toFixed(decimals)) : Math.round(clamped);
}

/**
 * Normalizes and bounds typography settings safely.
 */
export function normalizeSettings(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: input.enabled !== false,
    chatFontSize: clampNum(input.chatFontSize, 12, 32, DEFAULT_SETTINGS.chatFontSize, 0),
    codeFontSize: clampNum(input.codeFontSize, 12, 32, DEFAULT_SETTINGS.codeFontSize, 0),
    lineHeight: clampNum(input.lineHeight, 1.2, 2.4, DEFAULT_SETTINGS.lineHeight, 2),
    codeLineHeight: clampNum(input.codeLineHeight, 1.2, 2.2, DEFAULT_SETTINGS.codeLineHeight, 2),
    paragraphSpacing: clampNum(input.paragraphSpacing, 0, 28, DEFAULT_SETTINGS.paragraphSpacing, 0),
    letterSpacing: clampNum(input.letterSpacing, -0.04, 0.1, DEFAULT_SETTINGS.letterSpacing, 3),
    applyGlobalFontFace: input.applyGlobalFontFace !== false,
    forceGlobalUiFont: input.forceGlobalUiFont !== false,
    textFont: sanitizeCssValue(input.textFont, DEFAULT_SETTINGS.textFont),
    codeFont: sanitizeCssValue(input.codeFont, DEFAULT_SETTINGS.codeFont),
    ligatures: input.ligatures !== false,
  };
}

const CHAT_ROOTS = [
  '[data-testid="conversation-view"]',
  '[data-testid="subagent-tab-conversation"]',
  '[data-testid="side-question-tab-content"]',
].join(', ');

const EXCLUDE_CHAT_CONTROLS = [
  '.agy-composer-footer',
  '.agy-composer-footer *',
  '#agy-capsule-host',
  '#agy-capsule-host *',
  '[data-agy-capsule-subagent]',
  '[data-agy-capsule-subagent] *',
  'button',
  'button *',
  '[role="button"]',
  '[role="button"] *',
  'summary',
  'summary *',
  '.monaco-editor',
  '.monaco-editor *',
].join(', ');

const CODE_EXCLUDE_CONTAINERS = [
  '.agy-composer-footer',
  '.agy-composer-footer *',
  '#agy-capsule-host',
  '#agy-capsule-host *',
  '[data-agy-capsule-subagent]',
  '[data-agy-capsule-subagent] *',
  '.monaco-editor',
  '.monaco-editor *',
].join(', ');

const GLOBAL_UI_EXCLUDES = [
  '.codicon',
  '.codicon *',
  '[class*="codicon-"]',
  '.material-icons',
  '.material-symbols-outlined',
  '.material-symbols-rounded',
  '.lucide',
  'svg',
  'svg *',
  '.monaco-editor',
  '.monaco-editor *',
  '.xterm',
  '.xterm *',
  'pre',
  'pre *',
  'code',
  'code *',
  'kbd',
  'samp',
  '[class*="font-mono"]',
  '[class*="font-mono"] *',
].join(', ');

/**
 * Generates Antigravity scoped & optional global UI font CSS with bridged FontFace aliases.
 */
export function buildScopedCss(rawSettings, aliasMap = null) {
  const s = normalizeSettings(rawSettings);
  if (!s.enabled) return '';

  const textStack = rewriteStackWithAliases(s.textFont, aliasMap);
  const codeStack = rewriteStackWithAliases(s.codeFont, aliasMap);
  const ligSettings = s.ligatures ? '"calt" 1, "liga" 1' : '"calt" 0, "liga" 0';
  const ligVariant = s.ligatures ? 'contextual common-ligatures' : 'none';
  const letterCss = s.letterSpacing === 0 ? 'normal' : `${s.letterSpacing}em`;

  const h1Size = Math.round(s.chatFontSize * 1.35);
  const h2Size = Math.round(s.chatFontSize * 1.2);
  const h3Size = Math.round(s.chatFontSize * 1.1);

  const globalVarsBlock = s.applyGlobalFontFace
    ? `
:root {
  --font-family: ${textStack};
  --font-sans: ${textStack};
  --font-mono: ${codeStack};
  --editor-font-family: ${codeStack};
  --monaco-monospace-font: ${codeStack};
}
body {
  font-family: ${textStack};
}
`
    : '';

  const globalForceBlock = s.forceGlobalUiFont
    ? `
/* 0. 全局 UI 字体统一（包含侧边栏、按钮、表单、标签栏；严格避开图标字体与 Monaco/终端渲染） */
body :is(div, span, a, label, button, input, textarea, select, option, th, td, li, p, h1, h2, h3, h4, h5, h6, strong, em, small, [role="button"], [role="tab"], [role="menuitem"], [role="treeitem"], [class*="font-sans"]):not(${GLOBAL_UI_EXCLUDES}) {
  font-family: ${textStack} !important;
}
`
    : '';

  const paragraphBlock = s.paragraphSpacing > 0
    ? `
/* 2. 段落、引用、代码块与列表间距 */
:is(${CHAT_ROOTS}) :is(p, blockquote, pre, ul, ol):not(${EXCLUDE_CHAT_CONTROLS}):not(:last-child) {
  margin-bottom: ${s.paragraphSpacing}px !important;
}
`
    : '';

  return `${globalVarsBlock}${globalForceBlock}
/* 1. Chat 正文段落、列表、引用与表格（独立字号，不放大左侧 Session 栏与底部胶囊插件） */
:is(${CHAT_ROOTS}) :is(p, li, blockquote, td, th, dd, dt, [class*="whitespace-pre-wrap"], [class*="prose"]):not(${EXCLUDE_CHAT_CONTROLS}) {
  font-family: ${textStack} !important;
  font-size: ${s.chatFontSize}px !important;
  font-weight: 400 !important;
  line-height: ${s.lineHeight} !important;
  letter-spacing: ${letterCss} !important;
}
${paragraphBlock}
/* 3. Chat Markdown 标题按比例平滑缩放 */
:is(${CHAT_ROOTS}) h1:not(${EXCLUDE_CHAT_CONTROLS}) {
  font-family: ${textStack} !important;
  font-size: ${h1Size}px !important;
  line-height: 1.35 !important;
  letter-spacing: ${letterCss} !important;
}
:is(${CHAT_ROOTS}) h2:not(${EXCLUDE_CHAT_CONTROLS}) {
  font-family: ${textStack} !important;
  font-size: ${h2Size}px !important;
  line-height: 1.4 !important;
  letter-spacing: ${letterCss} !important;
}
:is(${CHAT_ROOTS}) h3:not(${EXCLUDE_CHAT_CONTROLS}) {
  font-family: ${textStack} !important;
  font-size: ${h3Size}px !important;
  line-height: 1.45 !important;
}
:is(${CHAT_ROOTS}) h4:not(${EXCLUDE_CHAT_CONTROLS}) {
  font-family: ${textStack} !important;
  font-size: ${s.chatFontSize}px !important;
  line-height: 1.5 !important;
}

/* 4. Chat 底部消息输入框（仅调整输入区，排除 footer 控件） */
[data-testid="agent-input-box"] :is([contenteditable="true"], [contenteditable="true"] p, textarea):not(.agy-composer-footer, .agy-composer-footer *) {
  font-family: ${textStack} !important;
  font-size: ${s.chatFontSize}px !important;
  font-weight: 400 !important;
  line-height: ${s.lineHeight} !important;
  letter-spacing: ${letterCss} !important;
}

/* 5. 代码块与行内代码独立字体、字号、行高与连字 */
:is(${CHAT_ROOTS}, [data-testid="agent-input-box"]) :is(pre, pre code, code, kbd, samp, [class*="font-mono"]):not(${CODE_EXCLUDE_CONTAINERS}) {
  font-family: ${codeStack} !important;
  font-variant-ligatures: ${ligVariant} !important;
  font-feature-settings: ${ligSettings} !important;
}

:is(${CHAT_ROOTS}, [data-testid="agent-input-box"]) :is(pre, pre code):not(${EXCLUDE_CHAT_CONTROLS}) {
  font-size: ${s.codeFontSize}px !important;
  line-height: ${s.codeLineHeight} !important;
}

:is(${CHAT_ROOTS}, [data-testid="agent-input-box"]) :not(pre) > code:not(${EXCLUDE_CHAT_CONTROLS}) {
  font-size: 0.9em !important;
}
`.trim();
}
