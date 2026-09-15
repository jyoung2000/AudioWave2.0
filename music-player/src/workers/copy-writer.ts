/**
 * Writes a chosen file into the app's private storage from a worker.
 *
 * Safari before version 26 offers no writable stream on the main thread, only a synchronous access
 * handle inside a worker; Chrome and Firefox offer both. This worker is the path that works
 * everywhere, so the main thread uses it whenever the stream is missing. It receives the File,
 * copies it in four-megabyte pieces, and answers once the bytes are flushed.
 */
interface WriteRequest {
  objectId: string;
  file: File;
}

interface SyncAccessHandle {
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  flush(): void;
  close(): void;
}

const CHUNK_BYTES = 4 * 1024 * 1024;
const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent<WriteRequest>) => void) | null };

scope.onmessage = (event: MessageEvent<WriteRequest>) => {
  void (async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle('copies', { create: true });
      const handle = await directory.getFileHandle(event.data.objectId, { create: true });
      const access = await (handle as unknown as { createSyncAccessHandle(): Promise<SyncAccessHandle> }).createSyncAccessHandle();
      try {
        const file = event.data.file;
        let offset = 0;
        while (offset < file.size) {
          const chunk = await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer();
          access.write(new Uint8Array(chunk), { at: offset });
          offset += chunk.byteLength;
        }
        access.flush();
      } finally {
        access.close();
      }
      scope.postMessage({ ok: true });
    } catch (error) {
      scope.postMessage({ ok: false, reason: error instanceof Error ? error.message : String(error) });
    }
  })();
};
