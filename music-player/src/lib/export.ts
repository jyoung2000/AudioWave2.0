/**
 * Saving a copy of your own music.
 *
 * Two rules decide everything here.
 *
 * **Only what you own.** A file on this device, or one your own hub is
 * holding for you, is yours to copy. A provider's stream is not, and no
 * amount of wanting it changes that — a stream URL has never implied a right
 * to keep the bytes (docs/DOWNLOADS_AND_LEGAL.md). So a provider track offers
 * nothing here and says why.
 *
 * **Say what is possible, not what sounds good.** Every format is listed
 * whether or not it can be produced, each with the reason. MP3 is the case
 * that matters: encoding to MP3 needs an encoder this app does not carry, so
 * it is offered when the file is *already* an MP3 — where "convert" means
 * "copy" and is exact — and refused with its reason otherwise. Offering a
 * button that silently produced something else would be the dishonest
 * alternative.
 *
 * FLAC and WAV are ours: the encoders in audio-core turn what the browser
 * decoded into a lossless file, so a WAV or AIFF can become a FLAC at about
 * half the size without losing a sample.
 */
import type { Track } from '@now-playing/contracts';
import type { BitDepth } from '@now-playing/audio-core';
import EncoderWorker from '../workers/encoder.ts?worker&inline';
import { defaultDestination, ensureWritable, writeIntoFolder, type DownloadDestination } from './download-folder.js';

export type ExportFormat = 'original' | 'mp3' | 'flac' | 'wav';

export interface ExportOption {
  format: ExportFormat;
  label: string;
  available: boolean;
  /** Why it is offered, or why it is not. Shown either way. */
  reason: string;
  lossless: boolean;
}

/** What a file's name says it is. The tags are not consulted; the container is. */
export function containerOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

const LOSSLESS_CONTAINERS = new Set(['flac', 'wav', 'wave', 'aiff', 'aif', 'alac']);

/**
 * The formats this track can be saved as.
 *
 * `file` is the track's bytes when the player can reach them. Without it
 * nothing can be saved, and the list says so rather than being empty.
 */
export function exportOptionsFor(track: Track, file: File | null): ExportOption[] {
  const providerOnly = track.locators.length > 0 && track.locators.every((l) => l.kind === 'provider');
  if (providerOnly) {
    const reason = `${track.title} is played from a provider, which gives this player a stream and not a file to keep.`;
    return (['original', 'mp3', 'flac', 'wav'] as const).map((format) => ({ format, label: labelFor(format), available: false, reason, lossless: format !== 'mp3' }));
  }
  if (!file) {
    const reason = 'The file for this track cannot be reached from here, so there is nothing to copy.';
    return (['original', 'mp3', 'flac', 'wav'] as const).map((format) => ({ format, label: labelFor(format), available: false, reason, lossless: format !== 'mp3' }));
  }

  const container = containerOf(file.name);
  const isMp3 = container === 'mp3';
  const lossless = LOSSLESS_CONTAINERS.has(container);
  return [
    {
      format: 'original',
      label: `Original${container ? ` (.${container})` : ''}`,
      available: true,
      reason: 'A byte-for-byte copy of the file on this device. Nothing is decoded, so nothing can change.',
      lossless: true,
    },
    {
      format: 'mp3',
      label: 'MP3',
      available: isMp3,
      reason: isMp3
        ? 'This file is already an MP3, so saving it as one copies it exactly.'
        : 'Making an MP3 means encoding one, and this player carries no MP3 encoder — it would have to be downloaded, which the app never does. FLAC below is lossless and about half the size of WAV; a paired hub with FFmpeg can produce an MP3.',
      lossless: false,
    },
    {
      format: 'flac',
      label: 'FLAC',
      available: true,
      reason: lossless
        ? 'Lossless, and usually about half the size of a WAV. Every sample survives.'
        : `This file is ${container ? `an .${container}` : 'already compressed'}, so a FLAC of it is lossless from here on but cannot recover what that format discarded. It will also be larger than the file you have.`,
      lossless: true,
    },
    {
      format: 'wav',
      label: 'WAV',
      available: true,
      reason: 'Uncompressed, large, and readable by anything with a sound card.',
      lossless: true,
    },
  ];
}

function labelFor(format: ExportFormat): string {
  return format === 'original' ? 'Original' : format.toUpperCase();
}

/** A filename a person would recognise, with anything a filesystem dislikes removed. */
export function exportFilename(track: Track, extension: string): string {
  const clean = (text: string): string =>
    text
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  const base = `${clean(track.artistName)} - ${clean(track.title)}`.slice(0, 180);
  return `${base || 'track'}.${extension}`;
}

export interface ExportResult {
  blob: Blob;
  filename: string;
}

/**
 * Produce the bytes.
 *
 * `original` and a same-format `mp3` never decode: they hand back the file
 * itself, which is both instant and exactly right. The other two decode once
 * and encode in a worker.
 */
export async function exportTrack(track: Track, file: File, format: ExportFormat, depth: BitDepth = 24): Promise<ExportResult> {
  const container = containerOf(file.name);
  if (format === 'original' || (format === 'mp3' && container === 'mp3')) {
    return { blob: file.slice(), filename: exportFilename(track, container || 'audio') };
  }
  if (format === 'mp3') throw new Error('This player cannot encode an MP3.');

  const decoded = await decode(file);
  const channels: Float32Array[] = [];
  for (let c = 0; c < decoded.numberOfChannels; c += 1) {
    // Copied out of the AudioBuffer so the worker can take ownership of them.
    channels.push(new Float32Array(decoded.getChannelData(c)));
  }
  const bytes = await encodeInWorker({ format, channels, sampleRate: decoded.sampleRate, depth });
  return {
    blob: new Blob([bytes as BlobPart], { type: format === 'flac' ? 'audio/flac' : 'audio/wav' }),
    filename: exportFilename(track, format),
  };
}

async function decode(file: File): Promise<AudioBuffer> {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error('This browser has no audio decoder available to the page.');
  const context = new Ctor();
  try {
    return await context.decodeAudioData(await file.arrayBuffer());
  } catch (error) {
    throw new Error(`This browser could not decode ${file.name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    void context.close().catch(() => undefined);
  }
}

function encodeInWorker(request: { format: 'flac' | 'wav'; channels: Float32Array[]; sampleRate: number; depth: BitDepth }): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new EncoderWorker();
    worker.onmessage = (event: MessageEvent<{ ok: boolean; bytes?: Uint8Array; reason?: string }>) => {
      worker.terminate();
      if (event.data.ok && event.data.bytes) resolve(event.data.bytes);
      else reject(new Error(event.data.reason ?? 'The file could not be encoded.'));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'The encoder stopped unexpectedly.'));
    };
    worker.postMessage(
      request,
      request.channels.map((c) => c.buffer),
    );
  });
}

export interface SaveOutcome {
  /** cancelled: the person closed the dialog. Not a failure and not reported as one. */
  kind: 'saved' | 'downloaded' | 'cancelled';
  /** Where it went, when that can be said. A folder name, never a path. */
  where: string | null;
  /** Set when the chosen folder could not be used and the browser took over. */
  fellBackBecause: string | null;
}

export interface SaveOptions {
  destination?: DownloadDestination;
  organise?: boolean;
  artistName?: string;
  albumName?: string | null;
}

/**
 * Hand the file to the person, where they asked for it.
 *
 * A folder they chose is written into directly. Otherwise the system save
 * dialog asks, and where there is no dialog the browser takes it. A folder
 * that has become unusable — permission withdrawn, the disk unplugged — does
 * not lose the file: it falls back, and says which happened, because a
 * download that silently lands somewhere else is worse than one that
 * explains itself.
 */
export async function saveFile(result: ExportResult, options: SaveOptions = {}): Promise<SaveOutcome> {
  const destination = options.destination ?? defaultDestination();

  if (destination.kind === 'folder') {
    const permitted = await ensureWritable(destination.handle);
    if (permitted.ok) {
      try {
        const written = await writeIntoFolder(destination.handle, result.filename, result.blob, {
          organise: options.organise ?? false,
          artistName: options.artistName ?? 'Unknown Artist',
          albumName: options.albumName ?? null,
        });
        return { kind: 'saved', where: written.path, fellBackBecause: null };
      } catch (error) {
        return browserDownload(result, `“${destination.name}” could not be written to: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return browserDownload(result, permitted.reason);
  }

  if (destination.kind === 'ask') {
    const picker = (window as unknown as { showSaveFilePicker?: (options: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
    if (picker) {
      try {
        const handle = await picker.call(window, {
          suggestedName: result.filename,
          types: [{ description: 'Audio', accept: { [result.blob.type || 'application/octet-stream']: [`.${result.filename.split('.').pop()}`] } }],
        });
        const writable = await (handle as FileSystemFileHandle & { createWritable(): Promise<WritableStream<BlobPart>> }).createWritable();
        await result.blob.stream().pipeTo(writable);
        return { kind: 'saved', where: handle.name, fellBackBecause: null };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return { kind: 'cancelled', where: null, fellBackBecause: null };
        // A dialog that refused is not a reason to lose the file.
      }
    }
  }

  return browserDownload(result, null);
}

function browserDownload(result: ExportResult, fellBackBecause: string | null): SaveOutcome {
  const url = URL.createObjectURL(result.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = result.filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked late: revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { kind: 'downloaded', where: null, fellBackBecause };
}
