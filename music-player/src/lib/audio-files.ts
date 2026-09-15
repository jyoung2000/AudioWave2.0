/**
 * Which filenames are music, and what a browser calls them.
 *
 * This is one paragraph of knowledge shared by two very different callers: the library scanner,
 * which is part of the first load, and the .zip reader, which is only fetched when someone actually
 * imports an archive. Keeping it in `library.ts` made the bundler pull that whole module — tag
 * parsing, scanning, the lot — into a shared chunk the moment the unpacker imported one function
 * from it. It lives here so the shared piece is the paragraph rather than the module, and so there
 * is still exactly one list of extensions rather than two that drift.
 */
export const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.mp4', '.aac', '.flac', '.ogg', '.oga', '.opus', '.wav', '.wave', '.webm', '.aiff', '.aif', '.alac', '.wma'] as const;

export const MIME_BY_EXTENSION: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg; codecs=opus',
  '.wav': 'audio/wav',
  '.wave': 'audio/wav',
  '.webm': 'audio/webm',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.alac': 'audio/mp4; codecs=alac',
  '.wma': 'audio/x-ms-wma',
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

export function isAudioFile(name: string): boolean {
  return (AUDIO_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}
