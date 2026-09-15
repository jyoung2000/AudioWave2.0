import { describe, expect, it } from 'vitest';
import { describeDestination, freeName, safeSegment, writeIntoFolder } from '../../src/lib/download-folder.js';

interface FakeFile {
  name: string;
  written: BlobPart[];
}

/**
 * A directory that behaves like the real one for the parts this code touches.
 * The type is spelled out because the handle holds child directories of its
 * own kind, and TypeScript cannot infer a shape that refers to itself.
 */
interface FakeDirectory {
  name: string;
  files: Map<string, FakeFile>;
  children: Map<string, FakeDirectory>;
  getFileHandle(filename: string, options?: { create?: boolean }): Promise<{ name: string; createWritable(): Promise<WritableStream<BlobPart>> }>;
  getDirectoryHandle(dirname: string, options?: { create?: boolean }): Promise<FakeDirectory>;
}

function fakeDirectory(name: string, existing: readonly string[] = []): FakeDirectory {
  const files = new Map<string, FakeFile>();
  for (const f of existing) files.set(f, { name: f, written: [] });
  const children = new Map<string, FakeDirectory>();
  const handle: FakeDirectory = {
    name,
    files,
    children,
    async getFileHandle(filename: string, options?: { create?: boolean }) {
      const found = files.get(filename);
      if (found) {
        return {
          name: filename,
          async createWritable() {
            const chunks: BlobPart[] = [];
            return new WritableStream<BlobPart>({
              write(chunk) {
                chunks.push(chunk);
              },
              close() {
                found.written = chunks;
              },
            });
          },
        };
      }
      if (!options?.create) throw new DOMException('not found', 'NotFoundError');
      const made = { name: filename, written: [] as BlobPart[] };
      files.set(filename, made);
      return {
        name: filename,
        async createWritable() {
          const chunks: BlobPart[] = [];
          return new WritableStream<BlobPart>({
            write(chunk) {
              chunks.push(chunk);
            },
            close() {
              made.written = chunks;
            },
          });
        },
      };
    },
    async getDirectoryHandle(dirname: string, options?: { create?: boolean }) {
      const found = children.get(dirname);
      if (found) return found;
      if (!options?.create) throw new DOMException('not found', 'NotFoundError');
      const made = fakeDirectory(dirname);
      children.set(dirname, made);
      return made;
    },
  };
  return handle;
}

describe('folder and file names', () => {
  it('strips what a filesystem will not take', () => {
    expect(safeSegment('AC/DC')).toBe('AC-DC');
    expect(safeSegment('What?: A Question*')).toBe('What-- A Question-');
    expect(safeSegment('  spaced   out  ')).toBe('spaced out');
    // A trailing dot or space is legal on one platform and refused on another.
    expect(safeSegment('Album.')).toBe('Album');
    expect(safeSegment('Album ')).toBe('Album');
  });

  it('never returns an empty name', () => {
    expect(safeSegment('')).toBe('Unknown');
    expect(safeSegment('   ')).toBe('Unknown');
    // A name made entirely of characters a filesystem refuses keeps its shape
    // as dashes rather than becoming "Unknown": something was there, and the
    // folder should still say so.
    expect(safeSegment('///')).toBe('---');
  });

  it('keeps a name short enough for a filesystem to accept', () => {
    expect(safeSegment('x'.repeat(400)).length).toBeLessThanOrEqual(120);
  });
});

describe('not overwriting what is already there', () => {
  it('uses the name as given when nothing holds it', async () => {
    const dir = fakeDirectory('Music');
    expect(await freeName(dir as unknown as FileSystemDirectoryHandle, 'Song.flac')).toBe('Song.flac');
  });

  it('numbers around a name that is taken, keeping the extension', async () => {
    const dir = fakeDirectory('Music', ['Song.flac', 'Song (2).flac']);
    expect(await freeName(dir as unknown as FileSystemDirectoryHandle, 'Song.flac')).toBe('Song (3).flac');
  });

  it('handles a name with no extension at all', async () => {
    const dir = fakeDirectory('Music', ['Song']);
    expect(await freeName(dir as unknown as FileSystemDirectoryHandle, 'Song')).toBe('Song (2)');
  });
});

describe('writing into a chosen folder', () => {
  it('puts the file at the top of the folder and reports where it went', async () => {
    const dir = fakeDirectory('My Music');
    const result = await writeIntoFolder(dir as unknown as FileSystemDirectoryHandle, 'Artist - Song.flac', new Blob(['audio']));
    expect(result.path).toBe('My Music/Artist - Song.flac');
    expect([...dir.files.keys()]).toEqual(['Artist - Song.flac']);
  });

  it('files it under artist and album when asked, creating both', async () => {
    const dir = fakeDirectory('My Music');
    const result = await writeIntoFolder(dir as unknown as FileSystemDirectoryHandle, 'Song.flac', new Blob(['audio']), {
      organise: true,
      artistName: 'Marlow & the Tidewater',
      albumName: 'Quiet Arithmetic',
    });
    expect(result.path).toBe('My Music/Marlow & the Tidewater/Quiet Arithmetic/Song.flac');
    const artist = dir.children.get('Marlow & the Tidewater')!;
    expect([...artist.children.get('Quiet Arithmetic')!.files.keys()]).toEqual(['Song.flac']);
  });

  it('substitutes a name for a track with no album rather than failing', async () => {
    const dir = fakeDirectory('My Music');
    const result = await writeIntoFolder(dir as unknown as FileSystemDirectoryHandle, 'Song.wav', new Blob(['a']), { organise: true, artistName: 'Someone', albumName: null });
    expect(result.path).toBe('My Music/Someone/Unknown Album/Song.wav');
  });

  it('does not overwrite a file already in the folder', async () => {
    const dir = fakeDirectory('My Music', ['Song.flac']);
    const result = await writeIntoFolder(dir as unknown as FileSystemDirectoryHandle, 'Song.flac', new Blob(['new']));
    expect(result.path).toBe('My Music/Song (2).flac');
    expect(dir.files.get('Song.flac')!.written, 'the one already there is untouched').toEqual([]);
  });
});

describe('what the settings panel says', () => {
  it('names the folder, or explains the alternative', () => {
    expect(describeDestination({ kind: 'folder', handle: {} as FileSystemDirectoryHandle, name: 'My Music' })).toContain('My Music');
    expect(describeDestination({ kind: 'ask' })).toMatch(/asked where/i);
    expect(describeDestination({ kind: 'browser' })).toMatch(/browser/i);
  });
});
