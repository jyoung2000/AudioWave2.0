/**
 * Writes audio into the app's private storage from a worker.
 *
 * Supports two operations:
 *  - write-file: store a File that the main thread already fetched
 *  - delete: remove a previously written entry by its key
 */
interface WriteFileRequest {
  type: 'write-file';
  objectId: string;
  file: File;
}

interface DeleteRequest {
  type: 'delete';
  key: string;
}

type WorkerRequest = WriteFileRequest | DeleteRequest;

type _WorkerResponse = 
  | { ok: true; bytes?: number }
  | { ok: false; reason: string };

const CHUNK_BYTES = 4 * 1024 * 1024;

const scope = self as unknown as { 
  postMessage(message: unknown): void; 
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null 
};

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  void (async () => {
    try {
      const msg = event.data;
      
      if (msg.type === 'write-file') {
        // Write a File that the main thread already fetched
        const { objectId, file } = msg;
        const root = await navigator.storage.getDirectory();
        const directory = await root.getDirectoryHandle('copies', { create: true });
        const handle = await directory.getFileHandle(objectId, { create: true });
        
        const withStream = handle as FileSystemFileHandle & { 
          createWritable?: () => Promise<WritableStream<BufferSource | Blob | string>> 
        };
        
        if (typeof withStream.createWritable === 'function') {
          const writable = await withStream.createWritable();
          await file.stream().pipeTo(writable);
        } else {
          // Fallback to sync access handle
          const access = await (handle as unknown as { 
            createSyncAccessHandle(): Promise<{ 
              write(buffer: ArrayBufferView, options?: { at?: number }): number;
              flush(): void;
              close(): void;
            }> 
          }).createSyncAccessHandle();
          
          try {
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
        }
        
        // Get the bytes written for the response
        const writtenFile = await handle.getFile();
        scope.postMessage({ ok: true, bytes: writtenFile.size });
        return;
      }
      
      if (msg.type === 'delete') {
        const root = await navigator.storage.getDirectory();
        const directory = await root.getDirectoryHandle('copies', { create: true });
        try {
          await directory.removeEntry(msg.key);
        } catch {
          // Already gone
        }
        scope.postMessage({ ok: true });
        return;
      }
      
      scope.postMessage({ ok: false, reason: `Unknown message type` });
    } catch (error) {
      scope.postMessage({ ok: false, reason: error instanceof Error ? error.message : String(error) });
    }
  })();
};