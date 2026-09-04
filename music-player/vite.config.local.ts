/**
 * The single-file build: one `now-playing.html` you can double-click.
 *
 * This is the same application as the served build — same source, same tests — assembled so that a
 * browser opening it from `file://` never has to fetch anything. That constraint is stricter than
 * "no CDN": a `file://` page has the opaque origin `null`, and Chromium refuses *any* subresource
 * fetch from it, including a sibling `.js` next to the HTML. So everything becomes part of the one
 * document:
 *
 * - The JavaScript is emitted as a single classic IIFE and inlined. `inlineDynamicImports` folds
 *   the code-split chunks (Three.js, the tag reader) back in, because a dynamic import of a *file*
 *   would be one of those forbidden fetches. The served build keeps its splitting; only this one
 *   pays the size, and it pays it in a file already on the disk.
 * - The CSS is inlined, and every asset — icons included — becomes a `data:` URI.
 * - The AudioWorklet is compiled separately and injected as source text, so the app can hand the
 *   audio thread a `data:` URL. Worklets are fetched with CORS and a file:// page cannot fetch, but
 *   `data:` is on Chromium's allowed-scheme list, so retuning survives. That was worth checking
 *   rather than assuming: see `docs/LOCAL_FILE.md` for what else was measured.
 *
 * There is no service worker and no web app manifest here. Neither can work from `file://` (a
 * service worker cannot register against a null origin), and neither is needed: offline is not a
 * problem to solve for a file that is already on the disk.
 */
import { copyFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { defineConfig, type Plugin, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';

const workspace = (name: string): string => fileURLToPath(new URL(`../packages/${name}/src/index.ts`, import.meta.url));
const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/** Compile the worklet to a standalone script so it can be shipped as text inside the bundle. */
async function compileWorklet(): Promise<string> {
  const result = await esbuild({
    entryPoints: [here('./src/worklets/pitch-shifter.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    // The worklet global scope has no DOM and no module loader; everything it uses is bundled in.
    alias: { '@now-playing/audio-core': workspace('audio-core'), '@now-playing/contracts': workspace('contracts'), '@now-playing/domain': workspace('domain') },
    logLevel: 'silent',
  });
  const out = result.outputFiles[0];
  if (!out) throw new Error('The worklet produced no output');
  return out.text;
}

/**
 * Fold every emitted script and stylesheet into `index.html`, then drop them from the bundle.
 *
 * Written here rather than pulled in as a dependency: it is thirty lines, and the whole point of
 * this build is that the result depends on nothing it did not bring with it.
 */
function inlineEverything(): Plugin {
  return {
    name: 'now-playing:inline-everything',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const htmlName = Object.keys(bundle).find((name) => name.endsWith('.html'));
      const htmlAsset = htmlName ? bundle[htmlName] : undefined;
      if (!htmlAsset || htmlAsset.type !== 'asset') throw new Error('The local build produced no HTML to inline into');
      let html = String(htmlAsset.source);

      // The favicon and the touch icon come from `public/`, which Vite copies verbatim rather than
      // processing — so they are still two files beside the HTML. Inline them here.
      for (const [file, mime] of Object.entries(PUBLIC_ICONS)) {
        const data = readFileSync(here(`./public/${file}`));
        const uri = `data:${mime};base64,${data.toString('base64')}`;
        // `publicDir: false` leaves the reference exactly as index.html wrote it, so match the
        // absolute, relative and bare forms rather than assuming which one Vite emitted.
        html = html.replace(new RegExp(`(?:\\./|/)?${escapeForRegExp(file)}`, 'g'), uri);
        delete bundle[file];
      }

      /*
       * Every replacement below passes a *function*, never a string.
       *
       * `String.replace` expands `$&`, `` $` ``, `$'` and `$1` inside a replacement string — and
       * minified React contains `"$&/"`. Passing the bundle as a string spliced the surrounding
       * HTML into the middle of React's source, which closed the `<script>` early and left the
       * page loading a chunk file that a file:// page cannot fetch. A function replacement treats
       * the text literally.
       */
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'chunk') {
          /*
           * Drop the tag Vite emitted and put the code at the end of `<body>` instead.
           *
           * Vite puts a module script in `<head>`, which is correct because modules are deferred.
           * This one is a classic IIFE and therefore blocking, so in `<head>` it runs before
           * `#root` exists and the app throws on its first line.
           */
          // `</script>` inside a string literal would close the tag early and truncate the app.
          const code = chunk.code.replace(/<\/script>/gi, '<\\/script>');
          html = html.replace(new RegExp(`\\s*<script[^>]*src="[^"]*${escapeForRegExp(name)}"[^>]*></script>`, 'i'), '');
          html = html.replace('</body>', () => `  <script>\n${code}\n    </script>\n  </body>`);
          delete bundle[name];
        } else if (name.endsWith('.css')) {
          html = html.replace(new RegExp(`\\s*<link[^>]*href="[^"]*${escapeForRegExp(name)}"[^>]*>`, 'i'), () => `\n    <style>\n${String(chunk.source)}\n    </style>`);
          delete bundle[name];
        }
      }

      /*
       * Anything still referenced by a relative path would be a fetch this page cannot make, so the
       * build fails rather than shipping a file that half-works.
       *
       * The scan runs over the markup with the inlined script and style bodies removed. Without
       * that it reads the application's own source as if it were markup, and every `src="…"` in a
       * string literal becomes a false alarm — which is exactly what happened the first time.
       */
      // Only the *bodies* are removed; the opening tags keep their attributes, or the scan would
      // discard the very `src="…"` it exists to find — which it did, the first time it ran.
      const markupOnly = html.replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, '$1</script>').replace(/(<style\b[^>]*>)[\s\S]*?<\/style>/gi, '$1</style>');
      const leftovers = [...new Set([...markupOnly.matchAll(/(?:src|href)="(?!data:|https?:|#)([^"]+)"/g)].map((match) => match[1]!))];
      if (leftovers.length) throw new Error(`The local build would still need these files beside it, which a file:// page cannot fetch: ${leftovers.join(', ')}`);

      htmlAsset.source = html;
      htmlAsset.fileName = 'now-playing.html';
    },
  };
}

/** Copied verbatim by Vite, so they have to be folded in by hand. */
const PUBLIC_ICONS: Record<string, string> = { 'icon.svg': 'image/svg+xml', 'icon-192.png': 'image/png' };

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Copy the finished file to the repository root, where it is committed.
 *
 * A file whose whole point is "you need no tooling" should not require a toolchain to obtain, so
 * `now-playing.html` is checked in and can be downloaded straight from the repository. It is a
 * build output like `packages/contracts/generated` and the icon files — regenerated by
 * `pnpm build:local`, and `pnpm verify` fails if the committed copy has drifted from the source.
 *
 * That check is only meaningful because this build is deterministic: the same source produces a
 * byte-identical file, so the committed copy changes when the app changes and at no other time.
 */
function publishToRepoRoot(): Plugin {
  return {
    name: 'now-playing:publish-to-repo-root',
    enforce: 'post',
    writeBundle(options) {
      const built = `${options.dir ?? here('./dist-local')}/now-playing.html`;
      copyFileSync(built, here('../now-playing.html'));
    },
  };
}

export default defineConfig(async (): Promise<UserConfig> => {
  const workletSource = await compileWorklet();
  return {
    base: './',
    // Nothing is copied beside the HTML: `public/` assets that matter are inlined by the plugin
    // below, and an unused file next to the app is one more thing to wonder about.
    publicDir: false,
    resolve: {
      alias: {
        '@now-playing/contracts': workspace('contracts'),
        '@now-playing/domain': workspace('domain'),
        // Prefix matching again: the specific entry has to come first.
      '@now-playing/aqua-ui/now-playing.css': fileURLToPath(new URL('../packages/aqua-ui/src/styles/now-playing.css', import.meta.url)),
      '@now-playing/aqua-ui': workspace('aqua-ui'),
        '@now-playing/audio-core': workspace('audio-core'),
        '@now-playing/recommendations': workspace('recommendations'),
      },
    },
    define: {
      // The app reads both: one to hand the audio thread a data: URL, one to describe itself
      // honestly on the settings screen.
      __NP_WORKLET_SOURCE__: JSON.stringify(workletSource),
      __NP_SINGLE_FILE__: 'true',
    },
    plugins: [react(), inlineEverything(), publishToRepoRoot()],
    build: {
      target: 'es2022',
      outDir: 'dist-local',
      emptyOutDir: true,
      // A source map would be a second file, and a file:// page could not fetch it anyway.
      sourcemap: false,
      cssCodeSplit: false,
      // Every asset becomes a data: URI, however large. Size costs nothing on a local disk.
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      rollupOptions: {
        output: {
          // One classic script: no module resolution, no chunk files, nothing to fetch.
          format: 'iife',
          inlineDynamicImports: true,
        },
      },
    },
  };
});
