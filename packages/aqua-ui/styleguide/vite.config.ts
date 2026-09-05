/**
 * The styleguide, as one file.
 *
 * Built the way the player's local file is built — a single classic script and every stylesheet
 * folded into the HTML — so the finished page depends on nothing beside it. It is committed at
 * `docs/design/styleguide.html`, where it can be opened from the repository with no toolchain, and
 * a body-only copy is written next to it for publishing as a hosted page.
 *
 * It renders the real components against the real stylesheets. That is the whole point: a
 * styleguide that redraws the system by hand will describe one thing and show another the first
 * time a token changes.
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const workspace = (name: string): string => fileURLToPath(new URL(`../../${name}/src/index.ts`, import.meta.url));

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
      const title = /<title>[\s\S]*?<\/title>/i.exec(html)?.[0] ?? '<title>Now Playing Styleguide</title>';
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
  plugins: [react(), inlineEverything(), publish()],
  resolve: {
    alias: {
      '@now-playing/contracts': workspace('contracts'),
      '@now-playing/domain': workspace('domain'),
      '@now-playing/aqua-ui/window.css': here('../src/styles/aqua-window.css'),
      '@now-playing/aqua-ui/media.css': here('../src/styles/aqua-media.css'),
      '@now-playing/aqua-ui/now-playing.css': here('../src/styles/now-playing.css'),
      '@now-playing/aqua-ui': here('../src/index.ts'),
    },
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
