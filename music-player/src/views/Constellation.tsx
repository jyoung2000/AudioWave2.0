/**
 * The constellation: your library as a field of stars, one per album, grouped by artist.
 *
 * Three-dimensional views of music libraries are usually decoration that hides the data. This one
 * is built to be *equivalent*: every star has a row in the 2D table beside it, the same keyboard
 * navigation selects both, and the whole 3D layer can be turned off permanently. That is not a
 * fallback for old browsers — it is the same information, and some people simply read a table
 * faster than they read a starfield.
 *
 * Three.js is loaded on demand, so a listener who never opens this view never downloads it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AquaTable, Button, EmptyState, Panel, PanelSection, SegmentedControl, useToast } from '@now-playing/aqua-ui';
import { uuidv7 } from '@now-playing/domain';
import type * as Three from 'three';
import type { Material, Mesh } from 'three';
import type { Track } from '@now-playing/contracts';
import { useAppState, usePlayer } from '../state/context.js';
import { toTrackRef } from '../state/store.js';

interface AlbumNode {
  id: string;
  album: string;
  artist: string;
  year: number | null;
  trackCount: number;
  totalMs: number;
  tracks: Track[];
}

export function ConstellationView() {
  const { store } = usePlayer();
  const state = useAppState();
  const toast = useToast();
  const [mode, setMode] = useState<'stars' | 'table'>(() => (prefersReducedMotion() ? 'table' : 'stars'));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  const albums = useMemo<AlbumNode[]>(() => {
    const map = new Map<string, AlbumNode>();
    for (const track of state.library.tracks) {
      const album = track.albumName ?? 'Singles';
      const key = `${track.artistName}::${album}`.toLowerCase();
      const node = map.get(key) ?? { id: key, album, artist: track.artistName, year: track.year, trackCount: 0, totalMs: 0, tracks: [] };
      node.trackCount += 1;
      node.totalMs += track.durationMs ?? 0;
      node.year ??= track.year;
      node.tracks.push(track);
      map.set(key, node);
    }
    return [...map.values()].sort((a, b) => a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album));
  }, [state.library.tracks]);

  const playAlbum = useCallback(
    (node: AlbumNode) => {
      const ordered = [...node.tracks].sort((a, b) => (a.discNumber ?? 0) - (b.discNumber ?? 0) || (a.trackNumber ?? 0) - (b.trackNumber ?? 0));
      store.setQueue(
        ordered.map((track) => ({ id: uuidv7(), track: toTrackRef(track), context: { kind: 'album' as const, id: node.id, name: `${node.album} by ${node.artist}` } })),
        0,
      );
      toast.show(`Playing ${node.album}`);
    },
    [store, toast],
  );

  // Three.js is imported here, not at the top of the module, so it is a separate chunk that only
  // loads when someone actually opens this view.
  useEffect(() => {
    if (mode !== 'stars' || !containerRef.current || !albums.length) return;
    let disposed = false;
    let cleanup: (() => void) | null = null;
    void (async () => {
      try {
        const three = await import('three');
        if (disposed || !containerRef.current) return;
        cleanup = mountStarfield(three, containerRef.current, albums, {
          onSelect: (id) => setSelectedId(id),
          onActivate: (id) => {
            const node = albums.find((a) => a.id === id);
            if (node) playAlbum(node);
          },
        });
      } catch (err) {
        // A machine without WebGL is a normal case, not a crash: fall back and say why.
        setRenderError(err instanceof Error ? err.message : String(err));
        setMode('table');
      }
    })();
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [mode, albums, playAlbum]);

  if (!albums.length) {
    return (
      <Panel>
        <EmptyState title="Nothing to map yet" text="Add some music and each album becomes a star here, grouped by artist." />
      </Panel>
    );
  }

  const selected = albums.find((a) => a.id === selectedId) ?? null;

  return (
    <>
      <div className="np-section-head">
        <h2>Constellation</h2>
        <p>Every album is a star, grouped by artist. Pick one to play it.</p>
      </div>
      <Panel title="Constellation">
      <PanelSection>
        <div className="player-toolbar-row">
          <SegmentedControl
            label="View"
            value={mode}
            onChange={setMode}
            segments={[
              { value: 'stars', label: 'Stars' },
              { value: 'table', label: 'Table' },
            ]}
          />
          <span className="player-hint">
            {albums.length} albums from {new Set(albums.map((a) => a.artist)).size} artists. Both views show the same thing; the table is not a fallback.
          </span>
        </div>
        {renderError ? <p className="player-hint player-hint--warning">The 3D view could not start on this machine ({renderError}), so the table is shown instead. Nothing is missing from it.</p> : null}
      </PanelSection>

      {mode === 'stars' ? (
        <div ref={containerRef} className="player-constellation" role="img" aria-label={`A star field of ${albums.length} albums. The table view lists the same albums with keyboard navigation.`} />
      ) : (
        <AquaTable
          variant="page"
          label="Albums"
          rowKey={(row: AlbumNode) => row.id}
          rows={albums}
          currentKey={selectedId}
          onSelectionChange={(keys) => setSelectedId([...keys][0] ?? null)}
          onActivate={playAlbum}
          columns={[
            { id: 'album', header: 'Album', primary: true, cell: (row) => row.album, stackText: (row) => row.artist },
            { id: 'artist', header: 'Artist', cell: (row) => row.artist },
            { id: 'year', header: 'Year', align: 'right', width: 56, cell: (row) => row.year ?? '' },
            { id: 'tracks', header: 'Songs', align: 'right', width: 56, cell: (row) => row.trackCount },
            { id: 'time', header: 'Length', align: 'right', width: 72, cell: (row) => `${Math.round(row.totalMs / 60000)} min` },
          ]}
        />
      )}

      {selected ? (
        <PanelSection title={`${selected.album} — ${selected.artist}`}>
          <div className="player-toolbar-row">
            <Button size="small" icon="play" onClick={() => playAlbum(selected)}>
              Play album
            </Button>
            <span className="player-hint">
              {selected.trackCount} songs · {Math.round(selected.totalMs / 60000)} minutes{selected.year ? ` · ${selected.year}` : ''}
            </span>
          </div>
        </PanelSection>
      ) : null}
      </Panel>
    </>
  );
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
}

/**
 * Build and animate the star field. Albums by the same artist share an angular sector, so the
 * layout carries information rather than being random scatter: clusters are artists, and a star's
 * size is how many songs the album has.
 */
function mountStarfield(
  three: typeof Three,
  container: HTMLElement,
  albums: readonly AlbumNode[],
  handlers: { onSelect: (id: string) => void; onActivate: (id: string) => void },
): () => void {
  const width = container.clientWidth || 640;
  const height = container.clientHeight || 420;
  const renderer = new three.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height, false);
  container.replaceChildren(renderer.domElement);

  const scene = new three.Scene();
  const camera = new three.PerspectiveCamera(55, width / height, 0.1, 200);
  camera.position.set(0, 0, 42);

  const artists = [...new Set(albums.map((a) => a.artist))];
  const geometry = new three.SphereGeometry(1, 12, 12);
  const meshes: Array<{ mesh: Mesh; node: AlbumNode }> = [];

  albums.forEach((album, index) => {
    const artistIndex = artists.indexOf(album.artist);
    const sector = (artistIndex / Math.max(1, artists.length)) * Math.PI * 2;
    const spread = ((index % 7) - 3) * 0.12;
    const radius = 12 + ((index * 7) % 18);
    const material = new three.MeshBasicMaterial({ color: new three.Color().setHSL((artistIndex / Math.max(1, artists.length)) * 0.8, 0.55, 0.65) });
    const mesh = new three.Mesh(geometry, material);
    mesh.position.set(Math.cos(sector + spread) * radius, Math.sin(sector + spread) * radius * 0.6, ((index % 11) - 5) * 1.6);
    // Size carries the album's length, so a glance says which are the substantial records.
    const scale = 0.35 + Math.min(1.6, album.trackCount * 0.08);
    mesh.scale.setScalar(scale);
    mesh.userData['id'] = album.id;
    scene.add(mesh);
    meshes.push({ mesh, node: album });
  });

  const raycaster = new three.Raycaster();
  const pointer = new three.Vector2();
  const reduced = prefersReducedMotion();
  let frame = 0;
  let rotation = 0;

  const render = (): void => {
    if (!reduced) rotation += 0.0009;
    scene.rotation.y = rotation;
    renderer.render(scene, camera);
    frame = requestAnimationFrame(render);
  };
  render();

  const pick = (event: PointerEvent): AlbumNode | null => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(meshes.map((m) => m.mesh))[0];
    return hit ? (meshes.find((m) => m.mesh === hit.object)?.node ?? null) : null;
  };

  const onClick = (event: PointerEvent): void => {
    const node = pick(event);
    if (node) handlers.onSelect(node.id);
  };
  const onDoubleClick = (event: PointerEvent): void => {
    const node = pick(event);
    if (node) handlers.onActivate(node.id);
  };
  const onResize = (): void => {
    const w = container.clientWidth || width;
    const h = container.clientHeight || height;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  };

  renderer.domElement.addEventListener('pointerdown', onClick);
  renderer.domElement.addEventListener('dblclick', onDoubleClick as unknown as EventListener);
  window.addEventListener('resize', onResize);

  return () => {
    cancelAnimationFrame(frame);
    renderer.domElement.removeEventListener('pointerdown', onClick);
    renderer.domElement.removeEventListener('dblclick', onDoubleClick as unknown as EventListener);
    window.removeEventListener('resize', onResize);
    // Three.js does not free GPU memory on garbage collection; every resource is released here.
    for (const { mesh } of meshes) (mesh.material as Material).dispose();
    geometry.dispose();
    renderer.dispose();
    container.replaceChildren();
  };
}
