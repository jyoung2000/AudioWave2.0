/**
 * One compilation path for the pitch-shifter AudioWorklet, shared by both builds.
 *
 * The worklet runs on the audio rendering thread in its own global scope: no DOM, no module loader,
 * no import resolution. It therefore has to be compiled to a standalone script before a browser can
 * load it, and `new URL('…/pitch-shifter.ts', import.meta.url)` does not do that — Vite treats the
 * `.ts` file as a static asset and hands the audio thread TypeScript, which `addModule()` rejects.
 * That is exactly how preserve-tempo retuning came to be dead in the served build while the tests,
 * which import the DSP directly, stayed green.
 *
 * So the compilation lives here and both configs use it:
 *
 * - The served build emits the compiled script as a real hashed asset and exposes its URL through
 *   the virtual module `virtual:np-worklet-url`.
 * - The dev server serves the same compiled script from a fixed path.
 * - The single-file build inlines the source text instead (a `file://` page cannot fetch a sibling
 *   script), so there the virtual module reports no asset and the app falls back to the `data:` URL
 *   built from `__NP_WORKLET_SOURCE__`.
 */
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import type { Plugin } from 'vite';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const workspace = (name: string): string => fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));
/**
 * The worklet's view of `@now-playing/audio-core`: the DSP core alone, not the package index.
 *
 * The index re-exports `presets.ts`, which imports a Zod schema from `@now-playing/contracts`; via
 * that one runtime value the whole contracts surface and Zod itself follow, and the audio thread
 * ends up carrying ~900 kB it never calls. The worklet entry uses nothing but `PitchShifterCore`
 * and the two constants beside it, so it is resolved straight to that module. Anything else the
 * worklet comes to need should be moved into (or beside) `pitch-shifter-core.ts` rather than
 * widening this back to the index.
 */
const audioCoreForWorklet = fileURLToPath(new URL('../../packages/audio-core/src/worklets/pitch-shifter-core.ts', import.meta.url));

/** The module the app imports to learn where the worklet lives. */
export const WORKLET_VIRTUAL_ID = 'virtual:np-worklet-url';
const RESOLVED_ID = `\0${WORKLET_VIRTUAL_ID}`;
/** Dev-server path. Prefixed with `@` like Vite's own internal routes, so it cannot collide. */
const DEV_PATH = '/@np-worklet/pitch-shifter.js';

/**
 * Compile the worklet entry to a standalone classic script.
 *
 * `bundle: true` because the audio thread has no module loader: `@now-playing/audio-core` and
 * everything it touches has to be folded in. `format: 'iife'` for the same reason.
 */
export async function compileWorklet(): Promise<string> {
  const result = await esbuild({
    entryPoints: [here('../src/worklets/pitch-shifter.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    platform: 'browser',
    alias: {
      '@now-playing/audio-core': audioCoreForWorklet,
      '@now-playing/contracts': workspace('contracts'),
      '@now-playing/domain': workspace('domain'),
    },
    logLevel: 'silent',
  });
  const out = result.outputFiles[0];
  if (!out) throw new Error('The worklet produced no output');
  return out.text;
}

/**
 * @param inline - the single-file build, which carries the worklet as text rather than as a file.
 */
export function audioWorklet({ inline = false }: { inline?: boolean } = {}): Plugin {
  let serve = false;
  let source = '';
  let reference: string | null = null;

  return {
    name: 'now-playing:audio-worklet',
    configResolved(config) {
      serve = config.command === 'serve';
    },
    async buildStart() {
      source = await compileWorklet();
      // An asset, not an entry: the worklet is loaded by URL at runtime, never imported.
      reference = inline || serve ? null : this.emitFile({ type: 'asset', name: 'pitch-shifter.js', source });
    },
    configureServer(server) {
      server.middlewares.use(DEV_PATH, (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(source);
      });
    },
    resolveId(id) {
      return id === WORKLET_VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      if (inline) return 'export const workletAssetUrl = null;\n';
      if (serve) return `export const workletAssetUrl = ${JSON.stringify(DEV_PATH)};\n`;
      return `export const workletAssetUrl = import.meta.ROLLUP_FILE_URL_${reference};\n`;
    },
  };
}
