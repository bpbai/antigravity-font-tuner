import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SETTINGS, buildScopedCss, normalizeSettings } from './sidecars/font_tuner/css_builder.mjs';
import {
  defaultFontDirs,
  parseFontStack,
  readFontMetadata,
  resolveFontSpecsForStacks,
  rewriteStackWithAliases,
  scanInstalledFonts,
} from './sidecars/font_tuner/font_scanner.mjs';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));

function testCssBuilder() {
  assert.deepEqual(normalizeSettings(), DEFAULT_SETTINGS);

  const sanitized = normalizeSettings({
    chatFontSize: 999,
    codeFontSize: 2,
    lineHeight: 9,
    codeLineHeight: 0.5,
    paragraphSpacing: 100,
    letterSpacing: -1,
    textFont: 'MiSans; color: red{}<>',
  });
  assert.equal(sanitized.chatFontSize, 32);
  assert.equal(sanitized.codeFontSize, 12);
  assert.equal(sanitized.lineHeight, 2.4);
  assert.equal(sanitized.codeLineHeight, 1.2);
  assert.equal(sanitized.paragraphSpacing, 28);
  assert.equal(sanitized.letterSpacing, -0.04);
  assert.equal(sanitized.textFont, 'MiSans color: red');

  assert.equal(buildScopedCss({ enabled: false }), '');

  const cssDefault = buildScopedCss(DEFAULT_SETTINGS);
  assert.ok(cssDefault.includes('--font-family:'));
  assert.ok(cssDefault.includes('--font-mono:'));
  assert.ok(cssDefault.includes('body :is(div, span,'));
  assert.ok(cssDefault.includes('.codicon'));
  assert.ok(cssDefault.includes('.monaco-editor'));
  assert.ok(cssDefault.includes('.agy-composer-footer'));
  assert.ok(cssDefault.includes('#agy-capsule-host'));
  assert.ok(cssDefault.includes('font-size: 20px !important;'));
  assert.ok(!cssDefault.includes('margin-bottom:'));

  const cssCustom = buildScopedCss(
    {
      ...DEFAULT_SETTINGS,
      forceGlobalUiFont: false,
      applyGlobalFontFace: false,
      paragraphSpacing: 14,
      letterSpacing: 0.02,
      codeLineHeight: 1.75,
      ligatures: false,
    },
    new Map([['inter', 'AgyFont_deadbeef']])
  );
  assert.ok(!cssCustom.includes('--font-family:'));
  assert.ok(!cssCustom.includes('body :is(div, span,'));
  assert.ok(cssCustom.includes('"AgyFont_deadbeef"'));
  assert.ok(cssCustom.includes('margin-bottom: 14px !important;'));
  assert.ok(cssCustom.includes('letter-spacing: 0.02em !important;'));
  assert.ok(cssCustom.includes('line-height: 1.75 !important;'));
  assert.ok(cssCustom.includes('"calt" 0, "liga" 0'));
}

function testFontScanner() {
  assert.deepEqual(
    parseFontStack(`"Inter", 'MiSans Medium', system-ui, sans-serif`),
    ['Inter', 'MiSans Medium', 'system-ui', 'sans-serif']
  );

  const tmpDir = mkdtempSync(join(tmpdir(), 'agy-font-tuner-scan-'));
  try {
    // Valid wOF2 header magic + weight/style suffix in filename
    const woffHeader = Buffer.from('wOF2000000000000');
    const customWoff = join(tmpDir, 'DemoSans-SemiBold.woff2');
    writeFileSync(customWoff, woffHeader);

    const woffMeta = readFontMetadata(customWoff, { isCustom: true });
    assert.ok(woffMeta);
    assert.equal(woffMeta.family, 'DemoSans');
    assert.equal(woffMeta.weight, 600);
    assert.equal(woffMeta.style, 'normal');
    assert.equal(woffMeta.binarySupported, true);
    assert.equal(woffMeta.isCustom, true);

    const scanResult = scanInstalledFonts({ customDirs: [tmpDir], includeSystem: false });
    assert.deepEqual(scanResult.customFamilies, ['DemoSans']);
    assert.equal(scanResult.customFiles.length, 1);

    // Custom fonts should unconditionally bridge even if family name is arbitrary
    const resolvedCustom = resolveFontSpecsForStacks(['"DemoSans", sans-serif'], scanResult.entries);
    assert.ok(resolvedCustom.aliasMap.has('demosans'));
    assert.equal(resolvedCustom.specs.length, 1);
    const rewritten = rewriteStackWithAliases('"DemoSans", sans-serif', resolvedCustom.aliasMap);
    assert.ok(rewritten.includes('AgyFont_'));
    assert.ok(rewritten.includes('"DemoSans", sans-serif'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // Test real OS fonts scanning cleanly without full-file buffering
  const dirs = defaultFontDirs();
  assert.ok(Array.isArray(dirs));
  if (dirs.length > 0) {
    const sysScan = scanInstalledFonts({ includeSystem: true });
    assert.ok(sysScan.families.length > 0, 'Expected at least one OS font family');
    const shadowedOrSubstyle = sysScan.entries.find(
      (e) => e.binarySupported && (e.family.toLowerCase() === 'inter' || e.fullName.toLowerCase() !== e.family.toLowerCase())
    );
    if (shadowedOrSubstyle) {
      const targetName = shadowedOrSubstyle.family.toLowerCase() === 'inter'
        ? shadowedOrSubstyle.family
        : shadowedOrSubstyle.fullName;
      const resSys = resolveFontSpecsForStacks([`"${targetName}"`], sysScan.entries);
      assert.ok(resSys.aliasMap.has(targetName.toLowerCase()));
      assert.ok(resSys.specs.length >= 1);
    }
  }
}

function testInstallerAndSyntax() {
  for (const rel of [
    'install.mjs',
    'sidecars/font_tuner/font_scanner.mjs',
    'sidecars/font_tuner/css_builder.mjs',
    'sidecars/font_tuner/cdp_injector.mjs',
    'sidecars/font_tuner/server.mjs',
    'test.mjs',
  ]) {
    execFileSync(process.execPath, ['--check', join(REPO_ROOT, rel)], { encoding: 'utf8' });
  }

  const fakeHome = mkdtempSync(join(tmpdir(), 'agy-font-tuner-home-'));
  try {
    const env = { ...process.env, ANTIGRAVITY_TEST_HOME: fakeHome };
    const helpOut = execFileSync(process.execPath, [join(REPO_ROOT, 'install.mjs'), '--help'], { encoding: 'utf8', env });
    assert.ok(helpOut.includes('Antigravity Font Tuner Installer'));

    const installOut = execFileSync(process.execPath, [join(REPO_ROOT, 'install.mjs'), 'install'], { encoding: 'utf8', env });
    assert.ok(installOut.includes('Installed plugin to:'));
    assert.ok(existsSync(join(fakeHome, '.gemini', 'config', 'plugins', 'antigravity-font-tuner', 'plugin.json')));
    assert.ok(existsSync(join(fakeHome, '.gemini', 'config', 'plugins', 'antigravity-font-tuner', 'sidecars', 'font_tuner', 'server.mjs')));
    assert.ok(existsSync(join(fakeHome, '.gemini', 'antigravity', 'sidecar_data', 'antigravity-font-tuner', 'font_tuner', 'data', 'fonts')));

    const statusOut = execFileSync(process.execPath, [join(REPO_ROOT, 'install.mjs'), 'status'], { encoding: 'utf8', env });
    assert.ok(statusOut.includes('Plugin installed : YES'));

    execFileSync(process.execPath, [join(REPO_ROOT, 'install.mjs'), 'uninstall', '--purge-data'], { encoding: 'utf8', env });
    assert.equal(existsSync(join(fakeHome, '.gemini', 'config', 'plugins', 'antigravity-font-tuner')), false);
    assert.equal(existsSync(join(fakeHome, '.gemini', 'antigravity', 'sidecar_data', 'antigravity-font-tuner')), false);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

testCssBuilder();
testFontScanner();
testInstallerAndSyntax();
console.log('ALL_TESTS_PASSED');
