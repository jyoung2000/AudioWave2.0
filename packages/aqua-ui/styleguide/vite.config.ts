/**
 * The styleguide, as one file.
 *
 * Built the way the player's local file is built — a single classic script and every stylesheet
 * folded into the HTML — so the finished page depends on nothing beside it. It is committed at
 * `docs/design/styleguide.html`, where it can be opened from the repository with no toolchain, and
 * a body-only copy is written next to it for publishing as a hosted page.
 *
 * It renders the real components against the real stylesheets — the component library's, and for
 * the Airwave windows the generated sheets, AquaArt and each product's own kit. That is the whole
 * point: a styleguide that redraws the system by hand will describe one thing and show another the
 * first time a token changes.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { darkProperties, rootProperties, runChecks, sourceFingerprint } from '../../../scripts/styleguide-lib.mjs';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const workspace = (name: string): string => fileURLToPath(new URL(`../../${name}/src/index.ts`, import.meta.url));
const repoRoot = here('../../../');

const sourceFiles = (dir: string): string[] =>
  !existsSync(dir)
    ? []
    : readdirSync(dir).flatMap((name) => {
        const full = `${dir}/${name}`;
        if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(full);
        return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
      });

/**
 * Who uses what, read from the products' own source so the guide cannot claim a consumer that has
 * moved on: every component the library exports, which of them each product still imports, and what
 * each Airwave window kit exports.
 */
function usage() {
  // Components only: a capitalised, camel-cased name. Constants (AQUA_PROFILE) and hooks are not components.
  const capitalised = (file: string): string[] => [...readFileSync(file, 'utf8').matchAll(/^export (?:function|const|class) ([A-Za-z0-9_]+)/gm)].map((m) => m[1]!).filter((name) => /^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/.test(name));
  // What the package index exports: its own declarations, and everything behind each `export * from`.
  const exported = (file: string, seen = new Set<string>()): string[] => {
    if (seen.has(file) || !existsSync(file)) return [];
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    const dir = file.slice(0, file.lastIndexOf('/'));
    const behind = [...text.matchAll(/^export \* from '(\.[^']+)\.js';/gm)].flatMap((m) => {
      const base = `${dir}/${m[1]!.replace(/^\.\//, '')}`;
      return exported(existsSync(`${base}.tsx`) ? `${base}.tsx` : `${base}.ts`, seen);
    });
    return [...capitalised(file), ...behind];
  };
  const library = [...new Set(exported(here('../src/index.ts').replace(/\\/g, '/')))].sort();
  const importedBy = (dir: string): Set<string> => {
    const names = new Set<string>();
    for (const file of sourceFiles(`${repoRoot}${dir}`)) {
      for (const block of readFileSync(file, 'utf8').matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'@now-playing\/aqua-ui'/g)) {
        for (const part of block[1]!.split(',')) {
          const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!;
          if (name) names.add(name);
        }
      }
    }
    return names;
  };
  const player = importedBy('music-player/src');
  const hub = importedBy('docker-container/src/web');
  const companion = importedBy('windows-companion/src/renderer');
  return {
    library: library.map((name) => ({ name, player: player.has(name), hub: hub.has(name), companion: companion.has(name) })),
    kits: { hub: capitalised(`${repoRoot}docker-container/src/web/ui.tsx`).sort(), companion: capitalised(`${repoRoot}windows-companion/src/renderer/ui.tsx`).sort() },
  };
}

/**
 * What the page says about itself: the fingerprint of the sources it was built from (which
 * `pnpm styleguide:check` compares with the sources as they are now), the same counts the check
 * prints, and the dark palette read out of the shipped stylesheet. Computed here, in Node, so the
 * page never claims a number nobody measured.
 */
function buildInfo() {
  const check = runChecks(repoRoot, { freshness: false });
  const pageCss = readFileSync(here('../src/styles/now-playing.css'), 'utf8');
  const light = rootProperties(pageCss);
  const dark = darkProperties(pageCss);
  const scheme = Object.keys(dark)
    .filter((name) => name in light && /^(#|rgb)/i.test(light[name]!.trim()))
    .sort()
    .map((name) => ({ name, light: light[name]!, dark: dark[name]! }));
  return { fingerprint: sourceFingerprint(repoRoot), summary: check.summary, notes: check.notes, problems: check.errors.length, scheme, usage: usage() };
}

const BUILD = buildInfo();

function stampFingerprint(): Plugin {
  return {
    name: 'styleguide:fingerprint',
    transformIndexHtml: (html) => html.replace('</head>', `  <meta name="styleguide-fingerprint" content="${BUILD.fingerprint}" />\n  </head>`),
  };
}

/**
 * The hub's and the companion's real views, with a recording where their server would be.
 *
 * The views talk to their product through one module each — the hub's API client
 * (`docker-container/src/web/lib/api.ts`) and the companion's bridge to its main process
 * (`windows-companion/src/renderer/bridge.ts`). In this build, and only here, those two modules are
 * swapped for `fixtures/fake-hub-api.ts` and `fixtures/fake-companion-bridge.ts`, which answer from
 * what a running hub and companion answered. Everything else the views import is the products' own.
 */
function specimenTransports(): Plugin {
  const key = (path: string): string => path.replace(/\\/g, '/').replace(/\.js$/, '.ts').toLowerCase();
  const swaps = new Map([
    [key(here('../../../docker-container/src/web/lib/api.ts')), here('./fixtures/fake-hub-api.ts')],
    [key(here('../../../windows-companion/src/renderer/bridge.ts')), here('./fixtures/fake-companion-bridge.ts')],
  ]);
  return {
    name: 'styleguide:specimen-transports',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return null;
      const from = importer.split('?')[0]!.replace(/\\/g, '/');
      return swaps.get(key(resolvePath(from.slice(0, from.lastIndexOf('/')), source))) ?? null;
    },
  };
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Fold the emitted script and stylesheet into the HTML, then drop them from the bundle. */
function inlineEverything(): Plugin {
  return {
    name: 'styleguide:inline-everything',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const htmlName = Object.keys(bundle).find((name) => name.endsWith('.html'));
      const htmlAsset = htmlName ? bundle[htmlName] : undefined;
      if (!htmlAsset || htmlAsset.type !== 'asset') throw new Error('The styleguide build produced no HTML to inline into');
      let html = String(htmlAsset.source);
      // Function replacements throughout: a string replacement expands `$&`, and minified React
      // contains it.
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'chunk') {
          const code = chunk.code.replace(/<\/script>/gi, '<\\/script>');
          html = html.replace(new RegExp(`\\s*<script[^>]*src="[^"]*${escapeForRegExp(name)}"[^>]*></script>`, 'i'), '');
          html = html.replace('</body>', () => `  <script>\n${code}\n    </script>\n  </body>`);
          delete bundle[name];
        } else if (name.endsWith('.css')) {
          html = html.replace(new RegExp(`\\s*<link[^>]*href="[^"]*${escapeForRegExp(name)}"[^>]*>`, 'i'), () => `\n    <style>\n${String(chunk.source)}\n    </style>`);
          delete bundle[name];
        }
      }
      const markupOnly = html.replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, '$1</script>').replace(/(<style\b[^>]*>)[\s\S]*?<\/style>/gi, '$1</style>');
      const leftovers = [...new Set([...markupOnly.matchAll(/(?:src|href)="(?!data:|https?:|#)([^"]+)"/g)].map((match) => match[1]!))];
      if (leftovers.length) throw new Error(`The styleguide would still need these files beside it: ${leftovers.join(', ')}`);
      htmlAsset.source = html;
      htmlAsset.fileName = 'styleguide.html';
    },
  };
}

/**
 * Two copies of the result: the full document into docs/, and a body-only fragment for hosting.
 *
 * The hosted artifact wraps what it is given in its own document skeleton, so it wants the page's
 * title, styles, root and script without `<html>`, `<head>` or `<body>` of their own.
 */
function publish(): Plugin {
  return {
    name: 'styleguide:publish',
    enforce: 'post',
    writeBundle(options) {
      const built = `${options.dir ?? here('./dist')}/styleguide.html`;
      copyFileSync(built, here('../../../docs/design/styleguide.html'));
      const html = readFileSync(built, 'utf8');
      const title = /<title>[\s\S]*?<\/title>/i.exec(html)?.[0] ?? '<title>Airwave Style Guide</title>';
      const styles = [...html.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)].map((m) => m[0]).join('\n');
      const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? '';
      writeFileSync(`${options.dir ?? here('./dist')}/styleguide.fragment.html`, `${title}\n${styles}\n${body}\n`);
    },
  };
}

export default defineConfig({
  root: here('.'),
  base: './',
  publicDir: false,
  plugins: [specimenTransports(), react(), stampFingerprint(), inlineEverything(), publish()],
  define: { __STYLEGUIDE_BUILD__: JSON.stringify(BUILD) },
  resolve: {
    alias: {
      '@now-playing/contracts': workspace('contracts'),
      '@now-playing/domain': workspace('domain'),
      '@now-playing/aqua-ui/window.css': here('../src/styles/aqua-window.css'),
      '@now-playing/aqua-ui/media.css': here('../src/styles/aqua-media.css'),
      '@now-playing/aqua-ui/now-playing.css': here('../src/styles/now-playing.css'),
      '@now-playing/aqua-ui': here('../src/index.ts'),
    },
    // The Airwave window kits are imported from the products' own folders; they must share this
    // page's React rather than resolve a second copy through their own node_modules.
    dedupe: ['react', 'react-dom'],
  },
  build: {
    target: 'es2022',
    outDir: here('./dist'),
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: { output: { format: 'iife', inlineDynamicImports: true } },
  },
});
