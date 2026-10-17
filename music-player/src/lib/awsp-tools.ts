/** Downloader backend for the already-paired Windows Companion. All RPCs cross AWSP; the helper
 * token and its loopback address remain inside the Companion process. */
import {
  HELPER_FILE_CHUNK_BYTES,
  HelperFileChunk,
  HelperHealth,
  HelperJob,
  type HelperFetchRequest,
  type HelperInstallResult,
  type HelperJobFile,
  type HelperToolId,
} from '@now-playing/contracts';
import type { ShellAwsp } from '../shell/awsp.js';
import { ToolError, protocolMatches, type ToolBackend } from './tools-core.js';

export type PairedCompanionTools = Pick<ShellAwsp, 'status' | 'connect' | 'companion' | 'connectionType'>;

function bytesFromBase64(encoded: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new ToolError('The paired Companion sent a malformed file chunk.', 'file-chunk');
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function fileOf(awsp: PairedCompanionTools, job: HelperJob, entry: HelperJobFile): Promise<File> {
  if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
    throw new ToolError('The paired Companion reported an invalid file size.', 'file-chunk');
  }
  const chunks: BlobPart[] = [];
  for (let offset = 0; offset < entry.sizeBytes; offset += HELPER_FILE_CHUNK_BYTES) {
    const length = Math.min(HELPER_FILE_CHUNK_BYTES, entry.sizeBytes - offset);
    let raw: unknown;
    try {
      raw = await awsp.companion('downloads.fileChunk', { jobId: job.id, fileId: entry.id, offset, length });
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : 'The paired Companion could not send this file.', 'file-chunk');
    }
    const parsed = HelperFileChunk.safeParse(raw);
    if (!parsed.success || parsed.data.offset !== offset || parsed.data.totalBytes !== entry.sizeBytes) {
      throw new ToolError('The paired Companion returned a mismatched file chunk.', 'file-chunk');
    }
    const bytes = bytesFromBase64(parsed.data.dataBase64);
    if (bytes.byteLength !== length) throw new ToolError('The paired Companion returned a short file chunk.', 'file-chunk');
    chunks.push(bytes.buffer as ArrayBuffer);
  }
  return new File(chunks, entry.name, { type: entry.contentType });
}

/** Resolve only an existing, paired Companion; never scan local ports or expose helper credentials. */
export async function awspBackend(awsp: PairedCompanionTools | null | undefined): Promise<ToolBackend | null> {
  if (!awsp) return null;
  try {
    const initial = await awsp.status();
    if (!initial.paired) return null;
    if (initial.status !== 'connected') {
      const connected = await awsp.connect();
      if (!connected.ok) return null;
    }
    const health = HelperHealth.safeParse(await awsp.companion('tools.status'));
    if (!health.success || !protocolMatches(health.data)) return null;
    const connectionType = awsp.connectionType();
    const path = connectionType === 'relay' ? 'relay-carried' : connectionType;
    const label = `Paired Windows Companion${path ? ` (${path})` : ''}`;
    return {
      kind: 'awsp',
      label,
      health: health.data,
      origin: null,
      startFetch: async (request: HelperFetchRequest) => HelperJob.parse(await awsp.companion('downloads.start', request as unknown as Record<string, unknown>)),
      jobState: async (id: string) => HelperJob.parse(await awsp.companion('downloads.status', { jobId: id })),
      forget: async (id: string) => {
        await awsp.companion('downloads.forget', { jobId: id });
      },
      // Automatic verified setup runs in the Companion. If it failed, its local Settings pane owns retry.
      install: async (tool: HelperToolId): Promise<HelperInstallResult> => ({
        tool,
        installed: false,
        version: null,
        reason: 'The paired Companion sets downloaders up automatically. Check its Settings if setup failed.',
      }),
      fileOf: (job, entry) => fileOf(awsp, job, entry),
    };
  } catch {
    return null;
  }
}
