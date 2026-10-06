/**
 * NDJSON: one JSON document per line. What the search stream is written as, and how a client reads
 * it back from a `ReadableStream` (browser `fetch`, Node's `fetch`) without waiting for the end.
 */
import { CatalogSearchChunk } from '@now-playing/contracts';

/** One chunk as one line, newline included. JSON never contains a raw newline, so a line is a chunk. */
export function ndjsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Chunks from a byte stream, as they arrive. A malformed line is skipped, never fatal. */
export async function* readCatalogStream(body: ReadableStream<Uint8Array>): AsyncGenerator<CatalogSearchChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const parse = (line: string): CatalogSearchChunk | null => {
    if (!line.trim()) return null;
    try {
      const parsed = CatalogSearchChunk.safeParse(JSON.parse(line));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at = buffer.indexOf('\n');
      while (at !== -1) {
        const chunk = parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        if (chunk) yield chunk;
        at = buffer.indexOf('\n');
      }
    }
    const last = parse(buffer + decoder.decode());
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}
