/**
 * NDJSON: one JSON document per line. What the search stream is written as, and how a client reads
 * it back from a `ReadableStream` (browser `fetch`, Node's `fetch`) without waiting for the end.
 */
import { CatalogSearchChunk } from '@now-playing/contracts';

/**
 * A search stream ended without the server saying it had finished.
 *
 * The `done` chunk is that statement. Without it the body was cut short -- a provider resting, a
 * dropped connection, a hub restarting mid-answer -- and whatever arrived is part of an answer, not
 * all of it. Callers that swallowed the end of the stream told the listener the search was complete.
 */
export class CatalogStreamTruncated extends Error {
  constructor(message = 'The search stopped part way: the service did not say it had finished') {
    super(message);
    this.name = 'CatalogStreamTruncated';
  }
}

/** One chunk as one line, newline included. JSON never contains a raw newline, so a line is a chunk. */
export function ndjsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Chunks from a byte stream, as they arrive. A malformed line is skipped, never fatal. */
export async function* readCatalogStream(body: ReadableStream<Uint8Array>): AsyncGenerator<CatalogSearchChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
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
        if (chunk) {
          if (chunk.type === 'done') finished = true;
          yield chunk;
        }
        at = buffer.indexOf('\n');
      }
    }
    const last = parse(buffer + decoder.decode());
    if (last) {
      if (last.type === 'done') finished = true;
      yield last;
    }
    // Every chunk that did arrive has been handed over by now: a partial answer beats no answer, so
    // this throws only after yielding, leaving the caller both the rows and the fact they are partial.
    if (!finished) throw new CatalogStreamTruncated();
  } finally {
    reader.releaseLock();
  }
}
