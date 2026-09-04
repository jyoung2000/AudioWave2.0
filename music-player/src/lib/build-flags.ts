/**
 * How this copy of the player was built, and what that means for what it can do.
 *
 * There are two builds from one source: the served one, which is a normal installable web app, and
 * the single-file one you open from your filesystem. They differ in what the *browser* will permit,
 * not in what the code tries to do — so the differences are discovered here once and reported to
 * the interface, rather than guessed at in a dozen places.
 */

/** True when this is the single-file build, whether or not it is currently on `file://`. */
export function isSingleFileBuild(): boolean {
  return typeof __NP_SINGLE_FILE__ !== 'undefined' && __NP_SINGLE_FILE__ === true;
}

/** True when the page is actually open from the filesystem, which is what the browser reacts to. */
export function isFileOrigin(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'file:';
}

/**
 * The compiled AudioWorklet, as a `data:` URL, or null when this build does not carry one.
 *
 * A worklet module is fetched with CORS, and a `file://` page has the opaque origin `null`, so it
 * cannot fetch its own sibling files — but `data:` is one of the schemes Chromium still allows.
 * That is why retuning keeps working from a local file when almost nothing else that needs a fetch
 * does. Base64 rather than percent-encoding: the source is ~30 KB and it survives every character
 * the compiler might emit.
 */
export function workletDataUrl(): string | null {
  if (typeof __NP_WORKLET_SOURCE__ === 'undefined' || !__NP_WORKLET_SOURCE__) return null;
  const bytes = new TextEncoder().encode(__NP_WORKLET_SOURCE__);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:text/javascript;base64,${btoa(binary)}`;
}

export interface LocalCapability {
  name: string;
  available: boolean;
  note: string;
}

/**
 * What a page opened from the filesystem can and cannot do.
 *
 * Every line here was measured in a browser rather than reasoned about, and the measurements are
 * written down in docs/LOCAL_FILE.md. The two that surprise people are the ones that still work:
 * a folder you grant is remembered, and the retune worklet loads.
 */
export function localFileReport(): { active: boolean; features: LocalCapability[] } {
  const active = isFileOrigin();
  if (!active) return { active, features: [] };
  return {
    active,
    features: [
      { name: 'Playing your own music', available: true, note: 'Files are read from your disk and played directly; nothing is copied.' },
      { name: 'Remembering your library between sessions', available: true, note: 'The index, playlists, presets and history are stored by the browser for this file.' },
      { name: 'Choosing a folder, and keeping access to it', available: typeof window !== 'undefined' && 'showDirectoryPicker' in window, note: 'Where the browser supports it. Otherwise pick files each time — the app says which you have.' },
      { name: 'The equalizer and the retune worklet', available: workletDataUrl() !== null, note: workletDataUrl() !== null ? 'The worklet is carried inside this file and loaded from memory.' : 'This build has no worklet, so retuning falls back to changing playback speed and says so.' },
      { name: 'Installing it as an app', available: false, note: 'A page opened from a file cannot be installed — there is no origin to install. It is already a file on your disk; make a shortcut to it.' },
      { name: 'Shared listening with a hub', available: false, note: 'Shared listening needs a WebSocket, which a browser refuses to open from a local file. Use the served player for that.' },
      { name: 'Searching providers through a hub', available: false, note: 'Possible only if the hub is configured to accept requests from a null origin, which it is not by default. The served player is the supported way.' },
    ],
  };
}
