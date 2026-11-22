/**
 * Zero-dependency cross-platform font scanner and OpenType/TrueType metadata parser.
 * Reads only minimal table headers from OS font folders and plugin custom fonts dir,
 * avoiding full-file memory allocation during discovery.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.woff2']);
const GENERIC_CSS_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
  '-apple-system',
  'blinkmacsystemfont',
  'inherit',
  'initial',
  'unset',
]);
const BUILTIN_SHADOWED_FAMILIES = new Set(['inter', 'google sans', 'google sans flex', 'roboto']);
const SMALL_BRIDGE_LIMIT_BYTES = 4 * 1024 * 1024;
const TARGET_WEIGHTS = [400, 500, 600, 700, 300];

/**
 * Returns standard font directories for the current operating system.
 */
export function defaultFontDirs() {
  const dirs = [];
  if (process.platform === 'win32') {
    const winDir = process.env.WINDIR || 'C:\\Windows';
    const localApp = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    dirs.push(join(localApp, 'Microsoft', 'Windows', 'Fonts'), join(winDir, 'Fonts'));
  } else if (process.platform === 'darwin') {
    dirs.push(
      join(homedir(), 'Library', 'Fonts'),
      '/Library/Fonts',
      '/System/Library/Fonts',
      '/System/Library/Fonts/Supplemental'
    );
  } else {
    const xdgData = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
    dirs.push(
      join(xdgData, 'fonts'),
      join(homedir(), '.fonts'),
      '/usr/local/share/fonts',
      '/usr/share/fonts'
    );
  }
  return dirs.filter((d, idx, arr) => d && arr.indexOf(d) === idx && existsSync(d));
}

function readRange(fd, offset, length) {
  const buf = Buffer.allocUnsafe(length);
  let total = 0;
  while (total < length) {
    const n = readSync(fd, buf, total, length - total, offset + total);
    if (n <= 0) break;
    total += n;
  }
  return buf.subarray(0, total);
}

function decodeUtf16BE(buf) {
  let out = '';
  for (let i = 0; i + 1 < buf.length; i += 2) {
    out += String.fromCharCode(buf.readUInt16BE(i));
  }
  return out.replace(/\0+$/g, '').trim();
}

function decodeNameRecord(buf, platformId) {
  if (platformId === 3 || platformId === 0) return decodeUtf16BE(buf);
  if (platformId === 1) return buf.toString('latin1').replace(/\0+$/g, '').trim();
  return '';
}

function parseNameTable(buf) {
  if (buf.length < 6) return { byId: new Map(), allNames: new Set() };
  const count = buf.readUInt16BE(2);
  const strOffset = buf.readUInt16BE(4);
  const candidates = new Map();
  const allNames = new Set();

  for (let i = 0; i < count; i++) {
    const off = 6 + i * 12;
    if (off + 12 > buf.length) break;
    const platformId = buf.readUInt16BE(off);
    const languageId = buf.readUInt16BE(off + 4);
    const nameId = buf.readUInt16BE(off + 6);
    const len = buf.readUInt16BE(off + 8);
    const recOffset = strOffset + buf.readUInt16BE(off + 10);
    if (len <= 0 || recOffset + len > buf.length) continue;
    if (![1, 2, 4, 6, 16, 17].includes(nameId)) continue;

    const text = decodeNameRecord(buf.subarray(recOffset, recOffset + len), platformId);
    if (!text) continue;
    if ([1, 4, 16].includes(nameId)) allNames.add(text);

    // Prefer Windows Unicode English (0x0409), then other Windows Unicode, then Unicode/Mac.
    let score = 1;
    if (platformId === 3 && languageId === 0x0409) score = 5;
    else if (platformId === 3) score = 4;
    else if (platformId === 0) score = 3;
    else if (platformId === 1 && languageId === 0) score = 2;

    const prev = candidates.get(nameId);
    if (!prev || score > prev.score) {
      candidates.set(nameId, { score, text });
    }
  }

  const byId = new Map();
  for (const [k, v] of candidates) byId.set(k, v.text);
  return { byId, allNames };
}

function inferWeightAndStyleFromName(text) {
  const lower = text.toLowerCase();
  const style = /\b(italic|oblique)\b/.test(lower) ? 'italic' : 'normal';
  let weight = 400;
  if (/\b(thin|hairline)\b/.test(lower)) weight = 100;
  else if (/\b(extralight|ultralight)\b/.test(lower)) weight = 200;
  else if (/\blight\b/.test(lower)) weight = 300;
  else if (/\bmedium\b/.test(lower)) weight = 500;
  else if (/\b(semibold|demibold)\b/.test(lower)) weight = 600;
  else if (/\b(extrabold|ultrabold|heavy)\b/.test(lower)) weight = 800;
  else if (/\b(black)\b/.test(lower)) weight = 900;
  else if (/\bbold\b/.test(lower)) weight = 700;
  return { weight, style };
}

function inferFromWoff2Filename(filePath, size, isCustom) {
  const stem = basename(filePath, extname(filePath)).replace(/\[[^\]]+\]/g, '');
  const { weight, style } = inferWeightAndStyleFromName(stem);
  const cleanFamily = stem
    .replace(/[-_ ]?(thin|hairline|extralight|ultralight|light|regular|normal|medium|semibold|demibold|extrabold|ultrabold|heavy|black|bold|italic|oblique)+$/ig, '')
    .replace(/[-_]+/g, ' ')
    .trim() || stem;
  return {
    filePath,
    size,
    isCustom,
    binarySupported: true,
    family: cleanFamily,
    legacyFamily: cleanFamily,
    fullName: stem.replace(/[-_]+/g, ' ').trim(),
    aliases: [cleanFamily, stem].filter(Boolean),
    weight,
    style,
  };
}

/**
 * Reads OpenType/TrueType/TTC/WOFF2 font metadata cleanly via minimal ranged reads.
 */
export function readFontMetadata(filePath, { isCustom = false, size = 0 } = {}) {
  const ext = extname(filePath).toLowerCase();
  if (!FONT_EXTENSIONS.has(ext)) return null;

  let fd;
  try {
    const fileSize = size || statSync(filePath).size;
    fd = openSync(filePath, 'r');
    const probe = readRange(fd, 0, 16);
    if (probe.length < 12) return null;

    const tag = probe.toString('ascii', 0, 4);
    if (tag === 'wOF2') {
      return inferFromWoff2Filename(filePath, fileSize, isCustom);
    }

    let sfntOffset = 0;
    let isCollection = false;
    if (tag === 'ttcf') {
      isCollection = true;
      if (probe.length < 16) return null;
      sfntOffset = probe.readUInt32BE(12);
    }

    const sfntHdr = readRange(fd, sfntOffset, 12);
    if (sfntHdr.length < 12) return null;
    const sfntTag = sfntHdr.toString('ascii', 0, 4);
    const sfntU32 = sfntHdr.readUInt32BE(0);
    if (sfntU32 !== 0x00010000 && sfntTag !== 'OTTO' && sfntTag !== 'true') {
      return null;
    }

    const numTables = Math.min(sfntHdr.readUInt16BE(4), 128);
    const dirBuf = readRange(fd, sfntOffset + 12, numTables * 16);
    let nameEntry = null;
    let os2Entry = null;

    for (let i = 0; i < numTables; i++) {
      const off = i * 16;
      if (off + 16 > dirBuf.length) break;
      const tbl = dirBuf.toString('ascii', off, off + 4);
      const tblOffset = dirBuf.readUInt32BE(off + 8);
      const tblLength = dirBuf.readUInt32BE(off + 12);
      if (tbl === 'name') nameEntry = { offset: tblOffset, length: Math.min(tblLength, 65536) };
      else if (tbl === 'OS/2') os2Entry = { offset: tblOffset, length: Math.min(tblLength, 96) };
    }

    if (!nameEntry || nameEntry.length < 6) return null;
    const nameBuf = readRange(fd, nameEntry.offset, nameEntry.length);
    const { byId, allNames } = parseNameTable(nameBuf);

    const family = byId.get(16) || byId.get(1);
    if (!family) return null;
    const legacyFamily = byId.get(1) || family;
    const subfamily = byId.get(17) || byId.get(2) || 'Regular';
    const fullName = byId.get(4) || `${family} ${subfamily}`.trim();

    let weight = 400;
    let style = /italic|oblique/i.test(subfamily) ? 'italic' : 'normal';
    if (os2Entry && os2Entry.length >= 64) {
      const os2Buf = readRange(fd, os2Entry.offset, os2Entry.length);
      if (os2Buf.length >= 64) {
        const w = os2Buf.readUInt16BE(4);
        if (w >= 100 && w <= 1000) weight = w;
        const fsSelection = os2Buf.readUInt16BE(62);
        if ((fsSelection & 1) !== 0) style = 'italic';
      }
    }

    return {
      filePath,
      size: fileSize,
      isCustom,
      binarySupported: !isCollection,
      family,
      legacyFamily,
      fullName,
      aliases: [...allNames],
      weight,
      style,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function collectFontFiles(dirs, isCustomDir) {
  const out = [];
  const queue = dirs.map((d) => ({ dir: d, depth: 0 }));
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (depth > 3) continue;
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      const fullPath = join(dir, item.name);
      if (item.isDirectory()) {
        queue.push({ dir: fullPath, depth: depth + 1 });
      } else if (item.isFile() && FONT_EXTENSIONS.has(extname(item.name).toLowerCase())) {
        out.push({ fullPath, isCustom: isCustomDir });
      }
    }
  }
  return out;
}

/**
 * Scans custom user font folders (prioritized) and OS font directories.
 */
export function scanInstalledFonts({ customDirs = [], extraDirs = [], includeSystem = true } = {}) {
  const candidates = [];
  const validCustom = customDirs.filter((d) => d && existsSync(d));
  const systemDirs = [...(includeSystem ? defaultFontDirs() : []), ...extraDirs.filter((d) => d && existsSync(d))];

  candidates.push(...collectFontFiles(validCustom, true));
  candidates.push(...collectFontFiles(systemDirs, false));

  const seenPaths = new Set();
  const entries = [];
  const customFamilySet = new Set();
  const systemFamilySet = new Set();
  const customFiles = [];

  for (const item of candidates) {
    const key = process.platform === 'win32' ? item.fullPath.toLowerCase() : item.fullPath;
    if (seenPaths.has(key)) continue;
    seenPaths.add(key);

    const meta = readFontMetadata(item.fullPath, { isCustom: item.isCustom });
    if (!meta) continue;
    entries.push(meta);

    if (meta.isCustom) {
      customFamilySet.add(meta.family);
      customFiles.push({
        name: basename(meta.filePath),
        family: meta.family,
        weight: meta.weight,
        style: meta.style,
      });
    } else {
      systemFamilySet.add(meta.family);
    }
  }

  const sortAlpha = (a, b) => a.localeCompare(b, 'zh-CN', { sensitivity: 'base' });
  const customFamilies = [...customFamilySet].sort(sortAlpha);
  const systemFamilies = [...systemFamilySet].filter((f) => !customFamilySet.has(f)).sort(sortAlpha);
  const families = [...customFamilies, ...systemFamilies];

  return {
    families,
    customFamilies,
    systemFamilies,
    customFiles,
    entries,
  };
}

/**
 * Splits a CSS font-family stack string into ordered unquoted family names.
 */
export function parseFontStack(stackStr) {
  if (typeof stackStr !== 'string') return [];
  const parts = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < stackStr.length; i++) {
    const ch = stackStr[i];
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ',') {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function matchesRequestedName(entry, lowerName) {
  if (entry.family.toLowerCase() === lowerName) return 'family';
  if (entry.legacyFamily.toLowerCase() === lowerName) return 'family';
  if (entry.fullName.toLowerCase() === lowerName) return 'fullname';
  for (const alias of entry.aliases || []) {
    if (alias.toLowerCase() === lowerName) return 'alias';
  }
  return null;
}

function selectRepresentativeWeights(matchingEntries, exactMatchEntry) {
  const normal = matchingEntries.filter((e) => e.style === 'normal').sort((a, b) => a.weight - b.weight);
  const italic = matchingEntries.filter((e) => e.style === 'italic').sort((a, b) => a.weight - b.weight);

  const pickWeights = (list) => {
    if (list.length <= 4) return list;
    const chosen = new Set();
    for (const target of TARGET_WEIGHTS) {
      let best = null;
      let bestDist = Infinity;
      for (const item of list) {
        const d = Math.abs(item.weight - target);
        if (d < bestDist) {
          best = item;
          bestDist = d;
        }
      }
      if (best) chosen.add(best);
      if (chosen.size >= 4) break;
    }
    return [...chosen].sort((a, b) => a.weight - b.weight);
  };

  let pickedNormal = pickWeights(normal);
  if (exactMatchEntry && exactMatchEntry.style === 'normal' && pickedNormal.includes(exactMatchEntry)) {
    // Keep the exact requested weight and heavier weights so weight 400 renders that exact cut.
    pickedNormal = pickedNormal.filter((e) => e.weight >= exactMatchEntry.weight);
  }
  const pickedItalic = pickWeights(italic).slice(0, 2);
  return { normal: pickedNormal, italic: pickedItalic };
}

function assignWeightBands(sortedList, aliasFamily) {
  return sortedList.map((entry, idx) => {
    if (sortedList.length === 1) {
      return { filePath: entry.filePath, family: aliasFamily, weight: '100 900', style: entry.style };
    }
    const prevMid = idx === 0 ? 100 : Math.floor((sortedList[idx - 1].weight + entry.weight) / 2) + 1;
    const nextMid = idx === sortedList.length - 1 ? 900 : Math.floor((entry.weight + sortedList[idx + 1].weight) / 2);
    return {
      filePath: entry.filePath,
      family: aliasFamily,
      weight: `${Math.min(prevMid, entry.weight)} ${Math.max(nextMid, entry.weight)}`,
      style: entry.style,
    };
  });
}

function isUserScopedFontPath(filePath) {
  const norm = filePath.toLowerCase();
  const homeNorm = homedir().toLowerCase();
  const localApp = (process.env.LOCALAPPDATA || '').toLowerCase();
  return norm.startsWith(homeNorm) || (localApp && norm.startsWith(localApp)) || norm.includes('/.local/share/fonts');
}

/**
 * Resolves FontFace bridge specs for requested font stacks:
 * - Always bridges custom `fonts/` folder fonts (.ttf/.otf/.woff2)
 * - Always bridges shadowed built-in names (e.g. Inter) and substyle names (e.g. "MiSans Medium")
 * - Bridges lightweight user-dir .ttf/.otf fonts (<= 4MB), avoiding redundant OS system font transfers
 */
export function resolveFontSpecsForStacks(stacks, entries) {
  const aliasMap = new Map();
  const specs = [];
  const seenSpecs = new Set();

  for (const stack of stacks) {
    for (const rawName of parseFontStack(stack)) {
      const lower = rawName.toLowerCase();
      if (GENERIC_CSS_FAMILIES.has(lower) || aliasMap.has(lower)) continue;

      const binaryEntries = entries.filter((e) => e.binarySupported);
      const customMatches = binaryEntries.filter((e) => e.isCustom && matchesRequestedName(e, lower));
      const allMatches = customMatches.length
        ? customMatches
        : binaryEntries.filter((e) => matchesRequestedName(e, lower));

      if (!allMatches.length) continue;

      const isCustomMatch = customMatches.length > 0;
      const isShadowed = BUILTIN_SHADOWED_FAMILIES.has(lower);
      const exactFullName = allMatches.find(
        (e) => e.fullName.toLowerCase() === lower && e.family.toLowerCase() !== lower
      );

      // Expand to all cuts of the matched family so bold/italic headings stay consistent.
      const baseFamilyLower = allMatches[0].family.toLowerCase();
      const familyEntries = allMatches.some((e) => e.isCustom)
        ? binaryEntries.filter((e) => e.isCustom && e.family.toLowerCase() === baseFamilyLower)
        : binaryEntries.filter((e) => e.family.toLowerCase() === baseFamilyLower);

      const { normal, italic } = selectRepresentativeWeights(familyEntries, exactFullName);
      const chosen = [...normal, ...italic];
      if (!chosen.length) continue;

      const isUserInstalled = chosen.some((e) => isUserScopedFontPath(e.filePath));
      const totalBytes = chosen.reduce((acc, e) => acc + (e.size || 0), 0);
      const shouldBridge =
        isCustomMatch ||
        isShadowed ||
        Boolean(exactFullName) ||
        (isUserInstalled && totalBytes <= SMALL_BRIDGE_LIMIT_BYTES);

      if (!shouldBridge) continue;

      const alias = `AgyFont_${createHash('sha1').update(`${lower}:${isCustomMatch ? 'custom' : 'sys'}`).digest('hex').slice(0, 8)}`;
      aliasMap.set(lower, alias);

      for (const spec of [...assignWeightBands(normal, alias), ...assignWeightBands(italic, alias)]) {
        const key = `${spec.filePath}::${spec.family}::${spec.weight}::${spec.style}`;
        if (seenSpecs.has(key)) continue;
        seenSpecs.add(key);
        specs.push(spec);
      }
    }
  }

  return { aliasMap, specs };
}

/**
 * Prepends bridged FontFace aliases before original names so non-bridged fallbacks remain intact.
 */
export function rewriteStackWithAliases(stackStr, aliasMap) {
  if (!aliasMap || aliasMap.size === 0) return stackStr;
  const parts = parseFontStack(stackStr);
  if (!parts.length) return stackStr;

  const out = [];
  const emitted = new Set();
  for (const name of parts) {
    const alias = aliasMap.get(name.toLowerCase());
    if (alias && !emitted.has(alias)) {
      emitted.add(alias);
      out.push(`"${alias}"`);
    }
    const formatted = GENERIC_CSS_FAMILIES.has(name.toLowerCase()) ? name : `"${name.replace(/"/g, '')}"`;
    if (!emitted.has(formatted)) {
      emitted.add(formatted);
      out.push(formatted);
    }
  }
  return out.join(', ');
}
