/**
 * The styleguide's checks, as functions.
 *
 * `pnpm styleguide:check` runs all of them; the styleguide build uses `sourceFingerprint` to stamp
 * the page; the unit test plants drift and expects these to catch it. Nothing here writes a file.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage', 'playwright-report', 'test-results']);

const readText = (root, path) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
const readJson = (root, path) => JSON.parse(readText(root, path));
const posix = (path) => path.split(sep).join('/');

function walk(root, path, out) {
  const abs = join(root, path);
  if (!existsSync(abs)) return;
  if (statSync(abs).isFile()) {
    out.push(posix(path));
    return;
  }
  for (const name of readdirSync(abs).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    walk(root, join(path, name), out);
  }
}

/** A hash of everything the styleguide is rendered from. Line endings are normalised so Windows and Linux agree. */
export function sourceFingerprint(root) {
  const manifest = readJson(root, 'design/manifest.json');
  const files = [];
  for (const input of manifest.guide.fingerprintInputs) walk(root, input, files);
  const hash = createHash('sha256');
  for (const file of [...new Set(files)].sort()) {
    hash.update(file);
    hash.update('\0');
    hash.update(readText(root, file));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

/* ------------------------------------------------------------------ CSS */

/**
 * Custom properties declared on a bare `:root` at the top level of a stylesheet — the light scheme,
 * before any media query (dark, touch, reduced motion) or profile override redefines them.
 */
export function rootProperties(css) {
  const out = {};
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  let start = 0;
  let selector = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) selector = text.slice(start, i).trim();
      depth += 1;
      start = i + 1;
    } else if (ch === '}') {
      if (depth === 1 && selector.split(',').some((part) => part.trim() === ':root')) {
        for (const m of text.slice(start, i).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);?/gi)) if (!(m[1] in out)) out[m[1]] = m[2].trim();
      }
      depth -= 1;
      start = i + 1;
    } else if (ch === ';' && depth === 0) {
      start = i + 1;
    }
  }
  return out;
}

/**
 * Custom properties the dark scheme redefines: declarations on a `:root…` rule nested inside an
 * `@media (prefers-color-scheme: dark)` block. First definition wins.
 */
export function darkProperties(css) {
  const out = {};
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const stack = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      stack.push({ prelude: text.slice(start, i).trim(), bodyStart: i + 1 });
      start = i + 1;
    } else if (ch === '}') {
      const block = stack.pop();
      if (block && /^:root\b/.test(block.prelude) && stack.some((outer) => /prefers-color-scheme\s*:\s*dark/.test(outer.prelude))) {
        for (const m of text.slice(block.bodyStart, i).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);?/gi)) if (!(m[1] in out)) out[m[1]] = m[2].trim();
      }
      start = i + 1;
    } else if (ch === ';') {
      start = i + 1;
    }
  }
  return out;
}

const trimNumber = (value) => String(Number(value));

/** Compare two CSS values the way a browser would: quotes, case, spacing and colour notation do not matter. */
export function normalizeCssValue(value) {
  let v = String(value).toLowerCase().replace(/["']/g, '').replace(/\s+/g, ' ').trim();
  v = v.replace(/#([0-9a-f])([0-9a-f])([0-9a-f])\b/g, '#$1$1$2$2$3$3');
  v = v.replace(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%)?)?\s*\)/g, (_m, r, g, b, a, pct) => {
    const alpha = a === undefined ? 1 : pct ? Number(a) / 100 : Number(a);
    return `rgba(${trimNumber(r)},${trimNumber(g)},${trimNumber(b)},${trimNumber(alpha)})`;
  });
  v = v.replace(/\s*,\s*/g, ',');
  v = v.replace(/\b0?\.(\d+)/g, (_m, d) => trimNumber(`0.${d}`));
  return v;
}

const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** tokens.json against the stylesheets, through design/token-map.json. Pure, so a test can plant drift. */
export function checkTokens({ tokens, map, sheets }) {
  const errors = [];
  const exceptions = [];
  const props = {};
  const allCss = {};
  for (const [path, css] of Object.entries(sheets)) {
    allCss[path] = css.toLowerCase();
    for (const [name, value] of Object.entries(rootProperties(css))) if (!(name in props)) props[name] = value;
  }
  let checked = 0;
  for (const group of Object.keys(tokens)) {
    const values = tokens[group];
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    for (const [key, raw] of Object.entries(values)) {
      const id = `${group}.${key}`;
      const entry = map.map[id];
      const prefixes = map.defaults[group];
      if (!entry && !prefixes) continue;
      checked += 1;
      const value = String(raw);
      if (entry?.literal) {
        const file = allCss[entry.file];
        if (file === undefined) errors.push(`${id}: token map names ${entry.file}, which is not one of the stylesheets`);
        else if (!file.includes(entry.literal.toLowerCase())) errors.push(`${id}: expected the literal ${entry.literal} in ${entry.file} (${entry.note ?? 'no note'})`);
        else if (!entry.literal.startsWith('opacity ') && normalizeCssValue(entry.literal) !== normalizeCssValue(value)) errors.push(`${id}: tokens.json says ${value} but the token map's literal is ${entry.literal}`);
        continue;
      }
      const candidates = entry?.var ? [entry.var] : prefixes.map((p) => p + kebab(key));
      const name = candidates.find((n) => n in props);
      if (!name) {
        errors.push(`${id}: no custom property ${candidates.join(' or ')} on :root — add it, or map the token in design/token-map.json`);
        continue;
      }
      const same = normalizeCssValue(props[name]) === normalizeCssValue(value);
      if (entry?.exception) {
        if (same) errors.push(`${id}: ${name} now matches tokens.json; remove exception ${entry.exception} from design/token-map.json`);
        else exceptions.push(`${id} ↔ ${name}: ${value} vs ${props[name]} (${entry.exception})`);
      } else if (!same) {
        errors.push(`${id}: tokens.json says ${value}, ${name} is ${props[name]}`);
      }
    }
  }
  return { errors, exceptions, checked };
}

/* -------------------------------------------------------------- discovery */

/** The members of `type <name> = 'a' | 'b' …` in a source file. */
export function unionMembers(source, typeName) {
  const m = new RegExp(`type\\s+${typeName}\\s*=\\s*([^;]+);`).exec(source);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
}

export function discoverSurfaces(root, coverage) {
  const found = [];
  const commands = [];
  for (const source of coverage.discovery) {
    if (source.kind === 'view-union') {
      for (const id of unionMembers(readText(root, source.file), source.type)) found.push({ id: `${source.prefix}${id}`, from: `${source.file} ${source.type}` });
    } else if (source.kind === 'files') {
      for (const name of readdirSync(join(root, source.dir)).sort()) {
        if (!name.endsWith(source.suffix)) continue;
        const stem = kebab(name.slice(0, -source.suffix.length)).replace(/^-/, '');
        found.push({ id: `${source.prefix}${stem}`, from: `${source.dir}/${name}` });
      }
    } else if (source.kind === 'discord-commands') {
      const block = /COMMAND_SPECS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(readText(root, source.file))?.[1] ?? '';
      // Top-level specs only: each is `{ name, description, arg }`; an arg's own name has no `arg` after it.
      for (const m of block.matchAll(/\{\s*name:\s*'([^']+)',\s*description:\s*'[^']*',\s*arg:/g)) commands.push(m[1]);
      found.push({ id: source.surface, from: source.file });
    } else if (source.kind === 'discord-templates') {
      found.push({ id: source.surface, from: source.file });
    }
  }
  return { found, commands };
}

/* ------------------------------------------------------------------ all */

export function runChecks(root, { freshness = true } = {}) {
  const errors = [];
  const notes = [];
  const exists = (path) => existsSync(join(root, path));
  const need = (path, where) => {
    if (!exists(path)) errors.push(`${where}: ${path} does not exist`);
  };

  const manifest = readJson(root, 'design/manifest.json');
  const rules = readJson(root, 'design/ux-rules.json');
  const coverage = readJson(root, 'design/coverage.json');
  const tokenMap = readJson(root, 'design/token-map.json');
  const decisionIds = new Set([...readText(root, 'design/decisions.md').matchAll(/^\|\s*(DEC-\d{3})\s*\|/gm)].map((m) => m[1]));

  // Manifest
  for (const [key, source] of Object.entries(manifest.sources)) {
    if (typeof source.path === 'string') need(source.path, `manifest.sources.${key}`);
    for (const path of source.paths ?? []) need(path, `manifest.sources.${key}`);
  }
  for (const [key, value] of Object.entries(manifest.sources.brand)) for (const path of [value].flat()) need(path, `manifest.sources.brand.${key}`);
  for (const path of manifest.guide.fingerprintInputs) need(path, 'manifest.guide.fingerprintInputs');
  need(manifest.guide.entry, 'manifest.guide.entry');
  for (const consumer of manifest.consumers) need(consumer.path, `manifest.consumers.${consumer.product}`);

  // Rules
  const ruleIds = new Set();
  const groups = new Set(rules.groups.map((g) => g.id));
  for (const rule of rules.rules) {
    const where = `ux-rules ${rule.id}`;
    if (!/^[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{3}$/.test(rule.id)) errors.push(`${where}: IDs look like UX-AREA-001`);
    if (ruleIds.has(rule.id)) errors.push(`${where}: duplicate ID`);
    ruleIds.add(rule.id);
    if (!groups.has(rule.group)) errors.push(`${where}: unknown group ${rule.group}`);
    if (!rules.authorityValues.includes(rule.authority)) errors.push(`${where}: unknown authority ${rule.authority}`);
    for (const owner of rule.owners) need(owner, where);
    if (!rule.evidence?.length) errors.push(`${where}: no evidence`);
    for (const evidence of rule.evidence ?? []) {
      if (!evidence.path) continue;
      need(evidence.path, where);
      if (evidence.name && exists(evidence.path) && !readText(root, evidence.path).includes(evidence.name)) errors.push(`${where}: ${evidence.path} has no test called “${evidence.name}”`);
    }
  }

  // Coverage
  const screens = exists('packages/aqua-ui/styleguide/screens.tsx') ? readText(root, 'packages/aqua-ui/styleguide/screens.tsx') : '';
  const guideSource = ['Styleguide.tsx', 'Governance.tsx']
    .map((name) => `packages/aqua-ui/styleguide/${name}`)
    .filter(exists)
    .map((path) => readText(root, path))
    .join('\n');
  const surfaceIds = new Set();
  for (const surface of coverage.surfaces) {
    const where = `coverage ${surface.id}`;
    if (surfaceIds.has(surface.id)) errors.push(`${where}: duplicate ID`);
    surfaceIds.add(surface.id);
    for (const path of surface.sourcePaths) need(path, where);
    for (const symbol of surface.symbols ?? []) {
      if (!surface.sourcePaths.some((path) => exists(path) && new RegExp(`\\b${symbol}\\b`).test(readText(root, path)))) errors.push(`${where}: ${symbol} is not defined in its source paths`);
    }
    for (const rule of surface.rules) if (!ruleIds.has(rule)) errors.push(`${where}: unknown rule ${rule}`);
    if (surface.decision && !decisionIds.has(surface.decision)) errors.push(`${where}: unknown decision ${surface.decision}`);
    if (surface.mockup && !screens.includes(`id: '${surface.mockup}'`)) errors.push(`${where}: no mockup screen ${surface.mockup} in styleguide/screens.tsx`);
    if (!guideSource.includes(`id="${surface.guideAnchor}"`)) errors.push(`${where}: the styleguide has no section #${surface.guideAnchor}`);
    if (!surface.states?.length) errors.push(`${where}: no states recorded`);
  }
  for (const flow of coverage.flows) {
    for (const id of flow.surfaces) if (!surfaceIds.has(id)) errors.push(`flow ${flow.id}: unknown surface ${id}`);
    for (const rule of flow.rules) if (!ruleIds.has(rule)) errors.push(`flow ${flow.id}: unknown rule ${rule}`);
    for (const path of flow.evidence) need(path, `flow ${flow.id}`);
  }
  for (const [id, entry] of Object.entries(tokenMap.map)) if (entry.exception && !decisionIds.has(entry.exception)) errors.push(`token-map ${id}: unknown decision ${entry.exception}`);

  // Discovery: every screen the products declare is in the ledger.
  const { found, commands } = discoverSurfaces(root, coverage);
  const excluded = new Set(coverage.exclusions.map((e) => e.id));
  for (const item of found) if (!surfaceIds.has(item.id) && !excluded.has(item.id)) errors.push(`discovery: ${item.id} (from ${item.from}) is not in design/coverage.json`);
  const discord = coverage.surfaces.find((s) => s.id === 'discord-replies');
  if (!commands.length) errors.push('discovery: could not read COMMAND_SPECS from the Discord gateway');
  for (const command of commands) if (!discord?.commands?.includes(command)) errors.push(`discovery: Discord command ${command} is not listed on discord-replies`);
  for (const command of discord?.commands ?? []) if (!commands.includes(command)) errors.push(`coverage discord-replies: ${command} is not a registered command`);

  // Runtime evidence refers to real surfaces.
  for (const record of manifest.verification.runtime) for (const id of record.surfaces) if (!surfaceIds.has(id)) errors.push(`manifest.verification: unknown surface ${id}`);

  // Tokens
  const sheets = Object.fromEntries(tokenMap.stylesheets.map((path) => [path, readText(root, path)]));
  const tokens = readJson(root, 'packages/aqua-ui/src/styles/tokens.json');
  const tokenResult = checkTokens({ tokens, map: tokenMap, sheets });
  errors.push(...tokenResult.errors.map((e) => `tokens: ${e}`));
  notes.push(...tokenResult.exceptions.map((e) => `recorded exception: ${e}`));

  // Freshness: the committed page was built from these sources.
  let fingerprint = null;
  if (freshness) {
    fingerprint = sourceFingerprint(root);
    const html = exists(manifest.guide.html) ? readText(root, manifest.guide.html) : '';
    const built = /<meta name="styleguide-fingerprint" content="([0-9a-f]+)"/.exec(html)?.[1] ?? null;
    if (built !== fingerprint) errors.push(`freshness: ${manifest.guide.html} was built from ${built ?? 'unknown sources'}, the sources are now ${fingerprint}. Run pnpm styleguide:build.`);
  }

  const summary = {
    rules: ruleIds.size,
    surfaces: surfaceIds.size,
    flows: coverage.flows.length,
    discovered: found.length,
    discordCommands: commands.length,
    tokensChecked: tokenResult.checked,
    tokenExceptions: tokenResult.exceptions.length,
    runtimeVerified: new Set(manifest.verification.runtime.flatMap((r) => r.surfaces)).size,
    mockups: coverage.surfaces.filter((s) => s.mockup).length,
    fingerprint,
  };
  return { errors, notes, summary };
}
