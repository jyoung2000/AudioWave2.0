/**
 * The hero's stage: the jewel case, mounted lazily over the flat artwork.
 *
 * The flat cover renders first and stays until the 3D stage has actually painted a frame, so the
 * page is never waiting on WebGL to show you what is playing. If Three.js will not load, if the
 * browser has no WebGL, or if the album has nothing to show, the flat cover simply stays — there is
 * no error state here because there is nothing lost.
 *
 * Mounting waits for an idle moment. The case is the nicest thing on the page and the least urgent.
 */
import { useEffect, useRef } from 'react';
import type { JewelCaseAlbum, JewelCaseHandle, JewelCasePose } from '../lib/jewel-case.js';

export interface JewelStageProps {
  stageRef: React.RefObject<HTMLDivElement | null>;
  album: JewelCaseAlbum | null;
  playing: boolean;
  /** Where the person left the case and the disc pointing, kept between visits. */
  loadPose: () => Promise<JewelCasePose | null>;
  savePose: (pose: JewelCasePose) => void;
}

export function JewelStage({ stageRef, album, playing, loadPose, savePose }: JewelStageProps) {
  const handle = useRef<JewelCaseHandle | null>(null);
  // The mount is asynchronous, so it reads the latest album and playing state when it lands rather
  // than the ones that were current when it started. Written from an effect, not during render.
  const wanted = useRef<{ album: JewelCaseAlbum | null; playing: boolean }>({ album: null, playing: false });
  // The pose callbacks go the same way: the scene reads them once at mount, and listing them as
  // dependencies would tear the whole thing down and rebuild it on every store render.
  const pose = useRef({ loadPose, savePose });

  useEffect(() => {
    wanted.current = { album, playing };
    pose.current = { loadPose, savePose };
  }, [album, playing, loadPose, savePose]);

  /*
   * Mounting waits for there to be something to show.
   *
   * The stage is on screen from the first paint, but until a track is playing there is no sleeve,
   * no track list and no disc label — so this holds off until the first album arrives and then
   * mounts once. Without the guard the idle callback fired against an empty player and gave up.
   */
  const hasAlbum = album !== null;

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !hasAlbum) return;
    let cancelled = false;
    let idle = 0;

    const start = (): void => {
      const first = wanted.current.album;
      if (!first) return;
      void (async () => {
        try {
          const { mountJewelCase } = await import('../lib/jewel-case.js');
          if (cancelled) return;
          const mounted = await mountJewelCase(stage, first, { loadPose: () => pose.current.loadPose(), savePose: (next) => pose.current.savePose(next) });
          if (cancelled) {
            mounted?.dispose();
            return;
          }
          handle.current = mounted;
          mounted?.setPlaying(wanted.current.playing);
        } catch {
          // No WebGL, or the chunk would not load. The flat cover is already on screen, so there is
          // nothing to report and nothing to fall back to — this *is* the fallback.
        }
      })();
    };

    const schedule = window.requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 400));
    idle = schedule(start) as unknown as number;

    return () => {
      cancelled = true;
      (window.cancelIdleCallback ?? window.clearTimeout)(idle);
      handle.current?.dispose();
      handle.current = null;
    };
  }, [stageRef, hasAlbum]);

  useEffect(() => {
    handle.current?.setPlaying(playing);
  }, [playing]);

  useEffect(() => {
    if (album) handle.current?.setAlbum(album);
  }, [album]);

  return null;
}
