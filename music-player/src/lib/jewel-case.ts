/**
 * The record, as an object you can turn over.
 *
 * `docs/reference/now-playing-header.html` puts a CD jewel case on the player's stage: it sits
 * shut and turning slowly while nothing is playing, falls open when playback starts, and lets the
 * disc rise out of the tray and spin. Dragging turns whichever of the two is out, and a flick
 * carries momentum. That is the reference's centrepiece, and this is it — built from primitives,
 * textured on a canvas, with no model to load and nothing fetched.
 *
 * Three things differ from the reference, each for a reason:
 *
 * - the sleeve and the disc label are the **real** cover art when the track has one, and the back
 *   inlay lists the album's **real** tracks, because there is an actual album here rather than two
 *   demo records;
 * - the disc's rainbow comes from the material's own iridescence and anisotropy rather than from a
 *   hand-written diffraction-grating shader. The reference's is more physically argued; this is a
 *   hundred lines of GLSL less to be wrong about, and at 232 px it reads the same;
 * - it is imported lazily and shares the Three.js chunk with the constellation, so nobody who never
 *   looks at it pays for it.
 *
 * Everything here is disposed on unmount: geometries, materials, textures, the environment target
 * and the renderer. Three.js frees none of that on garbage collection.
 */
import type * as Three from 'three';

export interface JewelCaseAlbum {
  title: string;
  artist: string;
  album: string | null;
  /** Object URL for the real cover, when the file carried one. */
  coverUrl: string | null;
  /** The album's other tracks, for the back inlay. */
  tracks: readonly string[];
  /** Tints the generated sleeve when there is no cover: warm alone, cool together. */
  mood: 'solo' | 'shared';
}

export interface JewelCaseHandle {
  setPlaying: (playing: boolean) => void;
  setAlbum: (album: JewelCaseAlbum) => void;
  dispose: () => void;
}

/** What this device can afford. The reference's tiers, and its reasoning. */
function detectTier(): { dpr: number; tex: number; aniso: number; seg: number } {
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean }; deviceMemory?: number; connection?: { saveData?: boolean } };
  if (nav.connection?.saveData) return { dpr: 1.5, tex: 512, aniso: 2, seg: 2 };
  const mobile = nav.userAgentData?.mobile ?? /Android|iPhone|iPod|Mobile/i.test(navigator.userAgent);
  const tablet = /iPad|Tablet|Silk/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/i.test(navigator.userAgent));
  if (mobile && !tablet) return { dpr: 1.5, tex: 512, aniso: 2, seg: 2 };
  if (tablet || (nav.deviceMemory ?? 4) <= 4 || navigator.hardwareConcurrency <= 4) return { dpr: 2, tex: 512, aniso: 4, seg: 3 };
  return { dpr: 2, tex: 1024, aniso: 8, seg: 4 };
}

function reduceMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** The sleeve, when the file brought no picture: the reference's own wash, per mood. */
function paintSleeve(size: number, mood: 'solo' | 'shared'): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const stops: Array<[number, string]> = mood === 'shared' ? [[0, '#e8fbff'], [0.14, '#7fd8f7'], [0.38, '#2f8fdc'], [0.66, '#233f97'], [1, '#0d1338']] : [[0, '#ffe07a'], [0.16, '#ffc63a'], [0.4, '#f9911a'], [0.68, '#e5540f'], [1, '#a82407']];
  const glowY = mood === 'shared' ? 0.3 : 0.78;
  const glow = g.createRadialGradient(size * 0.5, size * glowY, size * 0.015, size * 0.5, size * glowY, size * 0.95);
  for (const [at, colour] of stops) glow.addColorStop(at, colour);
  g.fillStyle = glow;
  g.fillRect(0, 0, size, size);

  // Rays, then film grain: the two things that stop a gradient reading as a gradient.
  g.save();
  g.translate(size * 0.5, size * glowY);
  g.globalCompositeOperation = 'overlay';
  for (let i = 0; i < 30; i += 1) {
    const angle = (i / 30) * Math.PI * 2 + 0.25;
    const width = 0.006 + Math.random() * 0.022;
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, size * 1.4, angle - width, angle + width);
    g.closePath();
    g.fillStyle = `rgba(255,255,255,${0.04 + Math.random() * 0.1})`;
    g.fill();
  }
  g.restore();
  return canvas;
}

/** The tray card: spine, the album's real running order, a barcode block and a footer. */
function paintBackInlay(width: number, album: JewelCaseAlbum): HTMLCanvasElement {
  const height = Math.round(width / 1.139);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d')!;

  const wash = g.createLinearGradient(0, 0, width, height);
  const shades = album.mood === 'shared' ? ['#070d26', '#152a63', '#2f6aa8'] : ['#25100a', '#6d2a0c', '#ad4a12'];
  wash.addColorStop(0, shades[0]!);
  wash.addColorStop(0.55, shades[1]!);
  wash.addColorStop(1, shades[2]!);
  g.fillStyle = wash;
  g.fillRect(0, 0, width, height);

  g.save();
  g.translate(width * 0.055, height / 2);
  g.rotate(-Math.PI / 2);
  g.textAlign = 'center';
  g.fillStyle = 'rgba(255,246,236,0.78)';
  g.font = `600 ${Math.round(width * 0.026)}px system-ui, -apple-system, sans-serif`;
  g.fillText(`${album.artist} — ${album.album ?? album.title}`.toUpperCase(), 0, 0);
  g.restore();

  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.font = `500 ${Math.round(width * 0.029)}px system-ui, -apple-system, sans-serif`;
  album.tracks.slice(0, 10).forEach((name, index) => {
    const y = height * 0.2 + index * height * 0.071;
    g.fillStyle = 'rgba(255,238,220,0.5)';
    g.fillText(String(index + 1).padStart(2, '0'), width * 0.115, y);
    g.fillStyle = 'rgba(255,247,238,0.92)';
    g.fillText(name.slice(0, 42), width * 0.185, y);
  });

  const bx = width * 0.68;
  const by = height * 0.75;
  const bw = width * 0.2;
  const bh = height * 0.14;
  g.fillStyle = '#f2ede6';
  g.fillRect(bx, by, bw, bh);
  g.fillStyle = '#131313';
  for (let x = bx + bw * 0.06; x < bx + bw * 0.94; ) {
    const lw = 1 + Math.random() * 3;
    g.fillRect(x, by + bh * 0.14, lw, bh * 0.6);
    x += lw + 1 + Math.random() * 3;
  }

  g.fillStyle = 'rgba(255,240,225,0.45)';
  g.font = `400 ${Math.round(width * 0.021)}px system-ui, -apple-system, sans-serif`;
  g.fillText(album.album ?? album.title, width * 0.115, height * 0.93);
  return canvas;
}

/** The label side of the disc: the sleeve, cropped to the ring and dimmed under a hub. */
function paintLabel(source: CanvasImageSource, size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#d8d8d8';
  g.fillRect(0, 0, size, size);
  g.save();
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  g.clip();
  g.drawImage(source, 0, 0, size, size);
  g.restore();
  const vignette = g.createRadialGradient(size / 2, size / 2, size * 0.28, size / 2, size / 2, size / 2);
  vignette.addColorStop(0, 'rgba(255,255,255,0.35)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.2)');
  g.fillStyle = vignette;
  g.fillRect(0, 0, size, size);
  return canvas;
}

/** A soft contact shadow, small enough that its gradient reaches zero well inside the frustum. */
function paintShadow(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const g = canvas.getContext('2d')!;
  const radial = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  radial.addColorStop(0, 'rgba(0,0,0,0.55)');
  radial.addColorStop(0.55, 'rgba(0,0,0,0.22)');
  radial.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = radial;
  g.fillRect(0, 0, 256, 256);
  return canvas;
}

const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * Build the stage. Returns null when WebGL is unavailable, so the caller can keep the CSS sleeve
 * rather than showing an empty box.
 */
export async function mountJewelCase(container: HTMLElement, album: JewelCaseAlbum): Promise<JewelCaseHandle | null> {
  const three = await import('three');
  const { RoundedBoxGeometry } = await import('three/examples/jsm/geometries/RoundedBoxGeometry.js');
  const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js');
  const { RectAreaLightUniformsLib } = await import('three/examples/jsm/lights/RectAreaLightUniformsLib.js');
  const BufferGeometryUtils = await import('three/examples/jsm/utils/BufferGeometryUtils.js');

  const tier = detectTier();
  const reduce = reduceMotion();

  let renderer: Three.WebGLRenderer;
  try {
    renderer = new three.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch {
    return null;
  }
  /*
   * The canvas is deliberately larger than the tile it sits in — the reference does the same — so
   * the case's shadow fades into the page instead of being clipped square at the canvas edge. The
   * third argument must be `true`: with `false` Three leaves the element's CSS size alone, and it
   * then falls back to the backing-store size, which is the canvas multiplied by the device pixel
   * ratio. On a 2× screen that drew the case at twice its intended size, over the title beside it.
   */
  const OVERSCAN = 1.45;
  const edge = (): number => Math.max(160, Math.min(container.clientWidth || 232, 420)) * OVERSCAN;
  const size = edge();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, tier.dpr));
  renderer.setSize(size, size, true);
  renderer.toneMapping = three.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  container.appendChild(renderer.domElement);

  const scene = new three.Scene();
  const camera = new three.PerspectiveCamera(28, 1, 0.1, 40);
  camera.position.set(0, 0, 3.9);

  const pmrem = new three.PMREMGenerator(renderer);
  const envTarget = pmrem.fromScene(new RoomEnvironment(), 0.03);
  scene.environment = envTarget.texture;
  scene.environmentIntensity = 0.85;
  pmrem.dispose();

  // Two softboxes and a back light: the diagonal streak across the lid, the tighter highlight on
  // the right, and enough behind to read the inlay once it comes round.
  RectAreaLightUniformsLib.init();
  const key = new three.RectAreaLight(0xffffff, 4.6, 3.2, 1.1);
  key.position.set(-1.9, 1.9, 2.4);
  key.lookAt(0, -0.1, 0);
  const sideBox = new three.RectAreaLight(0xdce9ff, 3, 0.55, 3.4);
  sideBox.position.set(2.4, -0.5, 1.9);
  sideBox.lookAt(0, 0, 0);
  const behind = new three.RectAreaLight(0xffffff, 3.4, 2.8, 1.6);
  behind.position.set(1.4, 1.2, -2.6);
  behind.lookAt(0, 0, 0);
  const rim = new three.DirectionalLight(0xffffff, 1.3);
  rim.position.set(-2.6, 0.7, -2);
  const fill = new three.DirectionalLight(0xcfe0ff, 0.45);
  fill.position.set(1.4, -1.7, 2.6);
  scene.add(key, sideBox, behind, rim, fill);

  /* ---------------------------------------------------------------- the case */

  // A real jewel case is 142 × 125 × 10 mm; these are those numbers.
  const W = 1.42;
  const H = 1.25;
  const HINGE_W = 0.135;
  const PARTING_Z = 0.012;
  const HINGE_X = -W / 2 + 0.008;

  const disposables: Array<{ dispose: () => void }> = [];
  const keep = <T extends { dispose: () => void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  // Clear polystyrene as two layers, the way product renderers fake glass: a faint tinted body that
  // lets the sleeve through, and an additive specular layer carrying the highlights at full
  // strength however faint the body is. Cheaper than transmission, and it fades cleanly.
  const glassBody = keep(new three.MeshPhysicalMaterial({ color: 0xe6ebef, metalness: 0, roughness: 0.34, transparent: true, opacity: 0.1, depthWrite: false }));
  const glassSpec = keep(new three.MeshPhysicalMaterial({ color: 0x000000, metalness: 0, roughness: 0.34, ior: 1.585, clearcoat: 1, clearcoatRoughness: 0.035, envMapIntensity: 1.6, transparent: true, blending: three.AdditiveBlending, depthWrite: false }));
  const edgePlastic = keep(new three.MeshPhysicalMaterial({ color: 0xd9e0e6, metalness: 0, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.4, transparent: true, opacity: 0.5, depthWrite: false }));

  const fading: Array<{ mat: Three.Material & { opacity: number }; base: number; solid: boolean }> = [
    { mat: glassBody, base: 0.1, solid: false },
    { mat: glassSpec, base: 1, solid: false },
    { mat: edgePlastic, base: 0.5, solid: false },
  ];
  const fades = <T extends Three.Material & { opacity: number }>(mat: T, base = 1, solid = false): T => {
    mat.transparent = !solid;
    fading.push({ mat, base, solid });
    return keep(mat);
  };

  const caseGroup = new three.Group();
  scene.add(caseGroup);
  const lidPivot = new three.Group();
  lidPivot.position.set(HINGE_X, 0, PARTING_Z);
  caseGroup.add(lidPivot);

  const glassPanel = (geometry: Three.BufferGeometry): Three.Mesh => {
    keep(geometry);
    const body = new three.Mesh(geometry, glassBody);
    const spec = new three.Mesh(geometry, glassSpec);
    spec.renderOrder = 2; // highlights go down after everything else
    body.add(spec);
    return body;
  };

  const lid = glassPanel(new RoundedBoxGeometry(W - 0.004, H, 0.014, tier.seg, 0.007));
  lid.position.set(-HINGE_X - 0.002, 0, 0.043 - PARTING_Z);
  const back = glassPanel(new RoundedBoxGeometry(W, H, 0.014, tier.seg, 0.007));
  back.position.z = -0.043;

  const wallSet = (depth: number, z: number, dx: number, withHinge: boolean): Three.Mesh => {
    const parts = [
      new three.BoxGeometry(W, 0.012, depth).translate(dx, H / 2 - 0.006, z),
      new three.BoxGeometry(W, 0.012, depth).translate(dx, -H / 2 + 0.006, z),
      new three.BoxGeometry(0.012, H, depth).translate(dx + W / 2 - 0.006, 0, z),
    ];
    if (withHinge) parts.push(new three.BoxGeometry(0.012, H, depth).translate(dx - W / 2 + 0.006, 0, z));
    const merged = keep(BufferGeometryUtils.mergeGeometries(parts)!);
    for (const part of parts) part.dispose();
    return new three.Mesh(merged, edgePlastic);
  };
  const walls = wallSet(0.062, -0.019, 0, true);
  const lidWalls = wallSet(0.036, 0.032 - PARTING_Z, -HINGE_X - 0.002, false);

  const artLeft = -W / 2 + HINGE_W + 0.024;
  const artRight = W / 2 - 0.012;
  const artW = artRight - artLeft;
  const artX = (artLeft + artRight) / 2;
  const artH = H - 0.024;

  // The sleeve's colour multiplies its map: it stands in for the light the lid absorbs, and keeps
  // the artwork from blowing out under the softboxes.
  const sleeveMat = fades(new three.MeshStandardMaterial({ color: 0xb2b2b2, roughness: 0.68, metalness: 0, envMapIntensity: 0.7 }), 1, true);
  const sleeve = new three.Mesh(keep(new three.PlaneGeometry(artW, artH)), sleeveMat);
  sleeve.position.set(artX - HINGE_X, 0, 0.03 - PARTING_Z);
  const paper = new three.Mesh(keep(new three.BoxGeometry(artW, artH, 0.006)), fades(new three.MeshStandardMaterial({ color: 0xf2f0ec, roughness: 0.85 }), 1, true));
  paper.position.set(artX - HINGE_X, 0, 0.026 - PARTING_Z);

  const inlayMat = fades(new three.MeshStandardMaterial({ color: 0xbcbcbc, roughness: 0.72, metalness: 0, envMapIntensity: 0.7 }), 1, true);
  const inlay = new three.Mesh(keep(new three.PlaneGeometry(W - 0.03, H - 0.03)), inlayMat);
  inlay.position.z = -0.034;
  inlay.rotation.y = Math.PI;
  const board = new three.Mesh(keep(new three.BoxGeometry(W - 0.03, H - 0.03, 0.006)), fades(new three.MeshStandardMaterial({ color: 0x17171a, roughness: 0.82 }), 1, true));
  board.position.z = -0.029;

  // The black tray: a plate with a recessed disc well and the ribbed spine beside it, in *front* of
  // the tray card the way a real case has it.
  const hingeX = -W / 2 + HINGE_W / 2 + 0.012;
  const DOCK_Z = 0.003;
  const trayParts: Three.BufferGeometry[] = [
    new three.BoxGeometry(HINGE_W, H - 0.05, 0.04).translate(hingeX, 0, -0.002),
    new three.BoxGeometry(W - HINGE_W - 0.06, H - 0.05, 0.012).translate(hingeX + HINGE_W / 2 + (W - HINGE_W - 0.06) / 2 + 0.004, 0, -0.01),
    new three.TorusGeometry(0.606, 0.0045, 8, 72).translate(artX, 0, DOCK_Z),
    new three.CylinderGeometry(0.058, 0.058, 0.019, 28).rotateX(Math.PI / 2).translate(artX, 0, DOCK_Z + 0.0025),
    new three.TorusGeometry(0.066, 0.005, 8, 32).translate(artX, 0, DOCK_Z + 0.009),
  ];
  for (let i = 0; i < 8; i += 1) {
    const x = hingeX - HINGE_W / 2 + 0.014 + i * ((HINGE_W - 0.028) / 7);
    trayParts.push(new three.BoxGeometry(0.009, H - 0.09, 0.018).translate(x, 0, 0.012));
  }
  const trayGeo = keep(BufferGeometryUtils.mergeGeometries(trayParts)!);
  for (const part of trayParts) part.dispose();
  const tray = new three.Mesh(trayGeo, fades(new three.MeshPhysicalMaterial({ color: 0x101014, roughness: 0.42, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.3 }), 1, true));

  lidPivot.add(lid, lidWalls, sleeve, paper);
  caseGroup.add(back, walls, inlay, board, tray);

  const dock = new three.Object3D();
  dock.position.set(artX, 0, DOCK_Z);
  caseGroup.add(dock);

  /* ---------------------------------------------------------------- the disc */

  // 120 mm disc, 15 mm hole, clear hub to ~46 mm, 1.2 mm thick.
  const DISC_R = 0.6;
  const HOLE_R = 0.075;
  const HUB_R = 0.23;
  const DISC_T = 0.012;

  const discPivot = new three.Group();
  const disc = new three.Group();
  discPivot.add(disc);
  scene.add(discPivot);

  const labelMat = keep(new three.MeshPhysicalMaterial({ color: 0xd6d6d6, metalness: 0.28, roughness: 0.34, clearcoat: 0.7, clearcoatRoughness: 0.12, envMapIntensity: 0.9 }));
  // The data side is a silver mirror with radial anisotropy and a film of iridescence: a pressed
  // disc is a diffraction grating, and this is that read at the size the stage actually shows.
  const dataMat = keep(
    new three.MeshPhysicalMaterial({
      color: 0xf1f3f6,
      metalness: 1,
      roughness: 0.24,
      envMapIntensity: 1.2,
      iridescence: 1,
      iridescenceIOR: 1.6,
      iridescenceThicknessRange: [180, 700],
      anisotropy: 0.9,
      anisotropyRotation: Math.PI / 2,
      clearcoat: 0.4,
      clearcoatRoughness: 0.06,
    }),
  );
  const clearPoly = keep(new three.MeshPhysicalMaterial({ color: 0xe9ecf0, transparent: true, opacity: 0.32, roughness: 0.08, metalness: 0, ior: 1.58, clearcoat: 1, clearcoatRoughness: 0.04, side: three.DoubleSide, depthWrite: false }));

  const labelFace = new three.Mesh(keep(new three.RingGeometry(HUB_R, DISC_R, 128, 1)), labelMat);
  labelFace.position.z = DISC_T / 2;
  const dataFace = new three.Mesh(keep(new three.RingGeometry(HUB_R, DISC_R, 128, 1)), dataMat);
  dataFace.rotation.y = Math.PI;
  dataFace.position.z = -DISC_T / 2;
  const hub = new three.Mesh(keep(new three.RingGeometry(HOLE_R, HUB_R, 64, 1)), clearPoly);
  // The mirror band and the dark stacking ring are the two things the eye reads as "CD".
  const mirror = new three.Mesh(keep(new three.RingGeometry(0.186, 0.232, 96, 1)), keep(new three.MeshPhysicalMaterial({ color: 0xf6f7f9, metalness: 1, roughness: 0.05, side: three.DoubleSide, envMapIntensity: 1.3 })));
  const stack = new three.Mesh(keep(new three.RingGeometry(0.162, 0.176, 64, 1)), keep(new three.MeshStandardMaterial({ color: 0x2b2c31, roughness: 0.5, metalness: 0.2, side: three.DoubleSide })));
  const rimParts = [new three.CylinderGeometry(DISC_R, DISC_R, DISC_T, 128, 1, true).rotateX(Math.PI / 2), new three.CylinderGeometry(HOLE_R, HOLE_R, DISC_T, 48, 1, true).rotateX(Math.PI / 2)];
  const rimGeo = keep(BufferGeometryUtils.mergeGeometries(rimParts)!);
  for (const part of rimParts) part.dispose();
  const rims = new three.Mesh(rimGeo, keep(new three.MeshPhysicalMaterial({ color: 0xf2f5f8, transparent: true, opacity: 0.62, roughness: 0.12, metalness: 0.15, ior: 1.58, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.6, side: three.DoubleSide, depthWrite: false })));
  disc.add(labelFace, dataFace, hub, mirror, stack, rims);

  const shadowTex = keep(new three.CanvasTexture(paintShadow()));
  const shadow = new three.Mesh(keep(new three.PlaneGeometry(2, 1.85)), keep(new three.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.4 })));
  shadow.position.set(0.1, -0.1, -0.5);
  scene.add(shadow);

  /* ------------------------------------------------------------------ artwork */

  let live: Three.Texture[] = [];
  const loadImage = (url: string): Promise<HTMLImageElement | null> =>
    new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = url;
    });

  const applyAlbum = async (next: JewelCaseAlbum): Promise<void> => {
    const cover = next.coverUrl ? await loadImage(next.coverUrl) : null;
    const face: CanvasImageSource = cover ?? paintSleeve(tier.tex, next.mood);
    const sleeveTex = new three.CanvasTexture(face instanceof HTMLCanvasElement ? face : drawToCanvas(face, tier.tex));
    const inlayTex = new three.CanvasTexture(paintBackInlay(tier.tex, next));
    const labelTex = new three.CanvasTexture(paintLabel(face, Math.min(tier.tex, 512)));
    for (const texture of [sleeveTex, inlayTex, labelTex]) {
      texture.colorSpace = three.SRGBColorSpace;
      texture.anisotropy = tier.aniso;
    }
    sleeveMat.map = sleeveTex;
    inlayMat.map = inlayTex;
    labelMat.map = labelTex;
    sleeveMat.needsUpdate = true;
    inlayMat.needsUpdate = true;
    labelMat.needsUpdate = true;
    for (const texture of live) texture.dispose();
    live = [sleeveTex, inlayTex, labelTex];
  };

  const drawToCanvas = (source: CanvasImageSource, edgeSize: number): HTMLCanvasElement => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = edgeSize;
    canvas.getContext('2d')!.drawImage(source, 0, 0, edgeSize, edgeSize);
    return canvas;
  };

  await applyAlbum(album);

  /* -------------------------------------------------------------- animation */

  const SPIN = 0.34; // idle turn, rad/s
  const LID_OPEN = 2.62; // ~150°: a jewel case falls well past 90°, and it keeps the lid clear
  const DISC_SPIN = reduce ? 1 : 8;
  const DISC_TURN = reduce ? 0 : 0.42;
  const DISC_TILT = -0.7;
  const OPEN_SECONDS = 2.3;

  let playing = false;
  let openT = 0;
  let idleT = 0;
  let baseRY = 0.35;
  let curRY = 0.35;
  let curRX = 0;
  let turn = 0;
  let spin = 0;
  let last = performance.now();
  let dragging = false;
  let dragTarget: 'case' | 'disc' = 'case';
  let lastX = 0;
  let lastY = 0;
  let velocity = 0;
  let flick = 0;
  let caseTilt = 0;
  let discTilt = 0;
  let painted = false;

  const dockPos = new three.Vector3();
  const dockQuat = new three.Quaternion();
  const hoverPos = new three.Vector3(0, 0, 0.55);
  const hoverEuler = new three.Euler();
  const hoverQuat = new three.Quaternion();
  const caseShadow = new three.Vector3();
  const discShadow = new three.Vector3(0.05, -0.62, -0.4);

  const remap = (from: number, to: number, t: number): number => Math.max(0, Math.min(1, (t - from) / (to - from)));

  const tick = (): void => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    idleT += dt;

    // The case opens as playback starts and shuts when it stops; nothing snaps.
    openT = Math.max(0, Math.min(1, openT + (playing ? dt : -dt) / OPEN_SECONDS));
    const lidT = easeInOut(remap(0, 0.32, openT));
    const discT = easeInOut(remap(0.46, 0.84, openT));
    const fadeT = easeInOut(remap(0.66, 1, openT));
    const alpha = 1 - fadeT;

    if (playing) baseRY += Math.sin(idleT * 0.5) * 0.0004;
    else if (!dragging && !reduce) baseRY += SPIN * dt;

    if (flick !== 0) {
      const step = flick * dt;
      if (dragTarget === 'disc') turn += step;
      else baseRY += step;
      flick *= 0.12 ** dt;
      if (Math.abs(flick) < 0.02) flick = 0;
    }

    const targetRX = -0.05 + (reduce ? 0 : Math.sin(idleT * 0.27) * 0.06) + caseTilt;
    curRY += (baseRY - curRY) * (1 - (playing ? 0.06 : 0.002) ** dt);
    curRX += (targetRX - curRX) * (1 - 0.002 ** dt);
    caseGroup.rotation.y = curRY;
    caseGroup.rotation.x = curRX;
    lidPivot.rotation.y = -LID_OPEN * lidT;

    for (const { mat, base, solid } of fading) {
      mat.opacity = base * alpha;
      if (solid) mat.transparent = alpha < 0.999;
    }
    caseGroup.position.z = -0.35 * fadeT;
    caseGroup.scale.setScalar(1 - 0.08 * fadeT);
    caseGroup.visible = alpha > 0.002;

    caseGroup.updateMatrixWorld();
    dock.getWorldPosition(dockPos);
    dock.getWorldQuaternion(dockQuat);

    const holding = dragging && dragTarget === 'disc';
    if (playing && !holding) turn += DISC_TURN * dt;
    const wobble = reduce || holding ? 0 : discT;
    hoverEuler.set(DISC_TILT + discTilt + Math.sin(idleT * 1.7) * 0.05 * wobble, turn + Math.sin(idleT * 1.3 + 1) * 0.06 * wobble, 0);
    hoverQuat.setFromEuler(hoverEuler);
    discPivot.position.lerpVectors(dockPos, hoverPos, discT);
    const arc = Math.sin(discT * Math.PI);
    discPivot.position.y += arc * 0.34;
    discPivot.position.x += arc * 0.06;
    discPivot.quaternion.slerpQuaternions(dockQuat, hoverQuat, discT);

    spin += ((playing ? DISC_SPIN : 0) - spin) * (1 - (playing ? 0.15 : 0.02) ** dt);
    disc.rotation.z += spin * dt;

    caseShadow.set(0.1 + Math.sin(curRY) * 0.18, -0.1, -0.5);
    shadow.position.lerpVectors(caseShadow, discShadow, discT);
    shadow.scale.set(0.55 + 0.45 * Math.abs(Math.cos(curRY)) + (0.78 - (0.55 + 0.45 * Math.abs(Math.cos(curRY)))) * discT, 1 + (0.78 - 1) * discT, 1);

    renderer.render(scene, camera);
    if (!painted) {
      painted = true;
      container.classList.add('is-3d');
    }
  };
  renderer.setAnimationLoop(tick);

  /* ------------------------------------------------------------ interaction */

  const element = renderer.domElement;
  const onDown = (event: PointerEvent): void => {
    dragging = true;
    // Whichever object is out takes the drag: the disc once it has risen, the case before that.
    dragTarget = openT > 0.6 ? 'disc' : 'case';
    lastX = event.clientX;
    lastY = event.clientY;
    velocity = 0;
    flick = 0;
    element.setPointerCapture(event.pointerId);
    container.classList.add('is-dragging');
  };
  const onMove = (event: PointerEvent): void => {
    if (!dragging) return;
    const dx = (event.clientX - lastX) / 120;
    const dy = (event.clientY - lastY) / 200;
    lastX = event.clientX;
    lastY = event.clientY;
    velocity = dx * 60;
    if (dragTarget === 'disc') {
      turn += dx;
      discTilt = Math.max(-1.2, Math.min(1.2, discTilt + dy));
    } else {
      baseRY += dx;
      caseTilt = Math.max(-0.6, Math.min(0.6, caseTilt + dy));
    }
  };
  const onUp = (): void => {
    if (!dragging) return;
    dragging = false;
    flick = Math.max(-14, Math.min(14, velocity));
    container.classList.remove('is-dragging');
  };
  element.addEventListener('pointerdown', onDown);
  element.addEventListener('pointermove', onMove);
  element.addEventListener('pointerup', onUp);
  element.addEventListener('pointercancel', onUp);

  const onResize = (): void => {
    const next = edge();
    renderer.setSize(next, next, true);
  };
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize);
  observer?.observe(container);

  return {
    setPlaying: (next) => {
      playing = next;
    },
    setAlbum: (next) => {
      void applyAlbum(next);
    },
    dispose: () => {
      renderer.setAnimationLoop(null);
      observer?.disconnect();
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
      for (const texture of live) texture.dispose();
      for (const item of disposables) item.dispose();
      envTarget.texture.dispose();
      envTarget.dispose();
      renderer.dispose();
      element.remove();
      container.classList.remove('is-3d');
    },
  };
}
