/**
 * The record, as an object you can pick up and turn over.
 *
 * This is `docs/reference/now-playing-header.html`'s 3D stage, ported rather than reinterpreted:
 * the same jewel case built from primitives, the same canvas-generated textures, the same
 * diffraction-grating shader on the disc, the same three staggered curves that open the case and
 * lift the disc out of it, the same drag with momentum and the same persisted pose. Every number
 * below is the reference's. Where a comment explains a decision, the decision is the reference's
 * too — they are kept because they say *why*, and a value without its reason is a value nobody can
 * safely change later.
 *
 * Three things are different, and all three are about the app rather than the object:
 *
 * - the album comes from the library instead of a demo constant, so the sleeve and the disc label
 *   are the track's real cover (which is what the reference's own comment tells you to swap in) and
 *   the tray card lists the album's real running order;
 * - playback state and album changes arrive through this module's API instead of DOM events;
 * - the pose is stored through a callback the player wires to its own settings, rather than the
 *   reference's page-global `window.kv`.
 *
 * Nothing is fetched: Three.js and its three addons are workspace dependencies, imported lazily so
 * the chunk is shared with the constellation and paid for only by people who see one of them.
 */
import type * as Three from 'three';

export interface JewelCaseAlbum {
  title: string;
  artist: string;
  album: string | null;
  /** Object URL for the real cover, when the file carried one. */
  coverUrl: string | null;
  /** The album's running order, for the tray card. */
  tracks: readonly string[];
  /** Tints the generated sleeve when there is no cover: warm alone, cool together. */
  mood: 'solo' | 'shared';
}

/** Where the person left the case and the disc pointing. */
export interface JewelCasePose {
  caseY: number;
  caseX: number;
  discY: number;
  discX: number;
}

export interface JewelCaseOptions {
  loadPose?: () => Promise<JewelCasePose | null>;
  savePose?: (pose: JewelCasePose) => void;
}

export interface JewelCaseHandle {
  setPlaying: (playing: boolean) => void;
  setAlbum: (album: JewelCaseAlbum) => void;
  dispose: () => void;
}

/* ------------------------------------------------------------------- device tier */

interface Tier {
  dpr: number;
  tex: number;
  aniso: number;
  seg: number;
}

function detectTier(): Tier {
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean }; deviceMemory?: number; connection?: { saveData?: boolean } };
  const mobile = nav.userAgentData?.mobile ?? /Android|iPhone|iPod|Mobile/i.test(navigator.userAgent);
  const tablet = /iPad|Tablet|Silk/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/i.test(navigator.userAgent));
  if (nav.connection?.saveData) return { dpr: 1.5, tex: 512, aniso: 2, seg: 2 };
  if (mobile && !tablet) return { dpr: 1.5, tex: 512, aniso: 2, seg: 2 };
  if (tablet || (nav.deviceMemory ?? 4) <= 4 || navigator.hardwareConcurrency <= 4) return { dpr: 2, tex: 512, aniso: 4, seg: 3 };
  return { dpr: 2, tex: 1024, aniso: 8, seg: 4 };
}

/* ------------------------------------------------------------------ sleeve art */

interface CoverRecipe {
  glowY: number;
  stops: Array<[number, string]>;
  wash: { rgb: string; a: number; from: 'top' | 'bottom'; span: number };
  rayAlpha: number;
}

interface BackRecipe {
  grad: [string, string, string];
  echo: string;
  echoAt: [number, number];
  spine: string;
  tracks: readonly string[];
  footer: string;
}

const SOLO_COVER: CoverRecipe = {
  glowY: 0.78,
  stops: [
    [0, '#ffe07a'],
    [0.16, '#ffc63a'],
    [0.4, '#f9911a'],
    [0.68, '#e5540f'],
    [1, '#a82407'],
  ],
  wash: { rgb: '104, 178, 219', a: 0.92, from: 'top', span: 0.42 },
  rayAlpha: 0.11,
};

const SHARED_COVER: CoverRecipe = {
  glowY: 0.3,
  stops: [
    [0, '#e8fbff'],
    [0.14, '#7fd8f7'],
    [0.38, '#2f8fdc'],
    [0.66, '#233f97'],
    [1, '#0d1338'],
  ],
  wash: { rgb: '18, 24, 66', a: 0.85, from: 'bottom', span: 0.46 },
  rayAlpha: 0.07,
};

/**
 * The generated sleeve, for a track whose file carried no picture.
 *
 * The reference's own: a radial glow, a wash from one edge, thirty overlay rays and a tile of film
 * grain. The grain matters more than it sounds — without it the gradient reads as a gradient rather
 * than as printed card.
 */
function makeCoverCanvas(size: number, recipe: CoverRecipe): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;

  const glow = g.createRadialGradient(size * 0.5, size * recipe.glowY, size * 0.015, size * 0.5, size * recipe.glowY, size * 0.95);
  for (const [at, colour] of recipe.stops) glow.addColorStop(at, colour);
  g.fillStyle = glow;
  g.fillRect(0, 0, size, size);

  const bottom = recipe.wash.from === 'bottom';
  const y0 = bottom ? size : 0;
  const y1 = bottom ? size * (1 - recipe.wash.span) : size * recipe.wash.span;
  const wash = g.createLinearGradient(0, y0, 0, y1);
  wash.addColorStop(0, `rgba(${recipe.wash.rgb}, ${recipe.wash.a})`);
  wash.addColorStop(1, `rgba(${recipe.wash.rgb}, 0)`);
  g.fillStyle = wash;
  g.fillRect(0, bottom ? y1 : 0, size, size * recipe.wash.span);

  g.save();
  g.translate(size * 0.5, size * recipe.glowY);
  g.globalCompositeOperation = 'overlay';
  for (let i = 0; i < 30; i += 1) {
    const angle = (i / 30) * Math.PI * 2 + 0.25;
    const width = 0.006 + Math.random() * 0.022;
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, size * 1.4, angle - width, angle + width);
    g.closePath();
    g.fillStyle = `rgba(255,255,255,${0.04 + Math.random() * recipe.rayAlpha})`;
    g.fill();
  }
  g.restore();

  // film grain, tiled from a small noise buffer
  const noiseCanvas = document.createElement('canvas');
  noiseCanvas.width = noiseCanvas.height = 256;
  const ng = noiseCanvas.getContext('2d')!;
  const noise = ng.createImageData(256, 256);
  for (let i = 0; i < noise.data.length; i += 4) {
    const v = 128 + (Math.random() - 0.5) * 70;
    noise.data[i] = v;
    noise.data[i + 1] = v;
    noise.data[i + 2] = v;
    noise.data[i + 3] = 255;
  }
  ng.putImageData(noise, 0, 0);
  g.globalCompositeOperation = 'overlay';
  g.globalAlpha = 0.07;
  g.drawImage(noiseCanvas, 0, 0, size, size);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  return canvas;
}

/** Back inlay card: track listing, spine text on both flaps, barcode. */
function makeBackCanvas(width: number, recipe: BackRecipe): HTMLCanvasElement {
  const height = Math.round(width / 1.139);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d')!;

  const bg = g.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, recipe.grad[0]);
  bg.addColorStop(0.55, recipe.grad[1]);
  bg.addColorStop(1, recipe.grad[2]);
  g.fillStyle = bg;
  g.fillRect(0, 0, width, height);

  const ex = width * recipe.echoAt[0];
  const ey = height * recipe.echoAt[1];
  const echo = g.createRadialGradient(ex, ey, 0, ex, ey, width * 0.6);
  echo.addColorStop(0, recipe.echo);
  echo.addColorStop(1, recipe.echo.replace(/[\d.]+\)$/, '0)'));
  g.fillStyle = echo;
  g.fillRect(0, 0, width, height);

  // Both edges of a tray card are spine flaps — they fold forward into the case's spines, so each
  // carries the same caption.
  const FLAP = 0.076;
  for (const side of [0, 1]) {
    const x0 = side ? width * (1 - FLAP) : 0;
    g.fillStyle = 'rgba(0,0,0,0.34)';
    g.fillRect(x0, 0, width * FLAP, height);
    g.fillStyle = 'rgba(255,255,255,0.10)'; // fold crease
    g.fillRect(side ? x0 : x0 + width * FLAP - 1.5, 0, 1.5, height);
    g.save();
    g.translate(x0 + width * FLAP * 0.5, height * 0.5);
    g.rotate(side ? Math.PI / 2 : -Math.PI / 2);
    g.fillStyle = 'rgba(255,236,214,0.88)';
    g.font = `600 ${Math.round(width * 0.025)}px system-ui, -apple-system, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(recipe.spine, 0, 0);
    g.restore();
  }

  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.font = `500 ${Math.round(width * 0.029)}px system-ui, -apple-system, sans-serif`;
  recipe.tracks.forEach((name, i) => {
    const y = height * 0.2 + i * height * 0.071;
    g.fillStyle = 'rgba(255,238,220,0.5)';
    g.fillText(String(i + 1).padStart(2, '0'), width * 0.115, y);
    g.fillStyle = 'rgba(255,247,238,0.92)';
    g.fillText(name, width * 0.185, y);
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
  g.fillText(recipe.footer, width * 0.115, height * 0.93);
  return canvas;
}

/**
 * Roughness map for the lid.
 *
 * Faint arcs and smudges are what stop the plastic reading as a perfect CG surface — real cases are
 * always slightly scuffed.
 */
function makeScuffCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#2e2e2e';
  g.fillRect(0, 0, size, size);
  g.lineCap = 'round';

  for (let i = 0; i < 80; i += 1) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = size * (0.25 + Math.random() * 0.9);
    const a0 = Math.random() * Math.PI * 2;
    g.beginPath();
    g.arc(x, y, r, a0, a0 + 0.08 + Math.random() * 0.45);
    g.strokeStyle = `rgba(215,215,215,${0.05 + Math.random() * 0.24})`;
    g.lineWidth = 0.5 + Math.random() * 1.7;
    g.stroke();
  }

  for (let i = 0; i < 16; i += 1) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = size * (0.05 + Math.random() * 0.15);
    const smudge = g.createRadialGradient(x, y, 0, x, y, r);
    smudge.addColorStop(0, 'rgba(160,160,160,0.22)');
    smudge.addColorStop(1, 'rgba(160,160,160,0)');
    g.fillStyle = smudge;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  return canvas;
}

function makeShadowCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const g = canvas.getContext('2d')!;
  const r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  r.addColorStop(0, 'rgba(0,0,0,0.55)');
  r.addColorStop(0.45, 'rgba(0,0,0,0.26)');
  r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 256, 256);
  return canvas;
}

/**
 * Label side: the sleeve art, printed on a silver base with a metallic ring around the hub — the
 * Y2K CD look.
 */
function makeLabelCanvas(cover: CanvasImageSource, size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const cx = size / 2;
  const R = size / 2;

  g.drawImage(cover, 0, 0, size, size);

  // silver print bleeding through at the edges
  const vignette = g.createRadialGradient(cx, cx, R * 0.55, cx, cx, R);
  vignette.addColorStop(0, 'rgba(200,204,210,0)');
  vignette.addColorStop(1, 'rgba(200,204,210,0.28)');
  g.fillStyle = vignette;
  g.fillRect(0, 0, size, size);

  // hub ring — printed metallic band with a fine dark keyline
  g.lineWidth = size * 0.028;
  g.strokeStyle = '#c9cdd3';
  g.beginPath();
  g.arc(cx, cx, R * 0.4, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = size * 0.006;
  g.strokeStyle = 'rgba(40,40,44,0.7)';
  g.beginPath();
  g.arc(cx, cx, R * 0.385, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.beginPath();
  g.arc(cx, cx, R * 0.415, 0, Math.PI * 2);
  g.stroke();

  // outer keyline
  g.lineWidth = size * 0.008;
  g.strokeStyle = 'rgba(30,30,34,0.55)';
  g.beginPath();
  g.arc(cx, cx, R * 0.985, 0, Math.PI * 2);
  g.stroke();
  return canvas;
}

/**
 * Anisotropy direction map. RG encode a tangent-space direction, B is strength.
 *
 * Direction is radial, so the specular lobe stretches into the spoke-like streaks a real disc
 * shows — the pits run in concentric tracks, so the surface is rough across them (radially) and
 * smooth along them.
 */
function makeAnisotropyCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const image = g.createImageData(size, size);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const dx = (2 * px) / size - 1;
      const dy = 1 - (2 * py) / size; // flipY: canvas row 0 is v = 1
      const len = Math.hypot(dx, dy) || 1;
      const i = (py * size + px) * 4;
      image.data[i] = Math.round(((dx / len) * 0.5 + 0.5) * 255);
      image.data[i + 1] = Math.round(((dy / len) * 0.5 + 0.5) * 255);
      image.data[i + 2] = 255;
      image.data[i + 3] = 255;
    }
  }
  g.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Thin-film thickness varies with radius, so iridescence resolves into concentric rainbow bands
 * that slide as the disc tilts.
 */
function makeThicknessCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const cx = size / 2;
  const grad = g.createRadialGradient(cx, cx, 0, cx, cx, cx);
  for (let i = 0; i <= 24; i += 1) {
    const s = i / 24;
    const v = Math.round(128 + Math.sin(s * Math.PI * 7.5) * 96 + (s - 0.5) * 40);
    grad.addColorStop(s, `rgb(${v},${v},${v})`);
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return canvas;
}

/**
 * Roughness for the data side: faint radial streaks and a few soft sectors.
 *
 * These are what flicker through the highlight as the disc spins — a perfectly uniform surface
 * would look frozen no matter how fast it turned.
 */
function makeGrooveCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const cx = size / 2;
  g.fillStyle = '#3a3a3a';
  g.fillRect(0, 0, size, size);

  g.save();
  g.translate(cx, cx);
  g.lineCap = 'round';
  for (let i = 0; i < 900; i += 1) {
    const a = Math.random() * Math.PI * 2;
    const r0 = cx * (0.35 + Math.random() * 0.6);
    const r1 = Math.min(cx, r0 + cx * (0.02 + Math.random() * 0.12));
    g.strokeStyle = `rgba(255,255,255,${0.02 + Math.random() * 0.07})`;
    g.lineWidth = 0.5 + Math.random() * 1.2;
    g.beginPath();
    g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    g.stroke();
  }
  for (let i = 0; i < 5; i += 1) {
    const a = Math.random() * Math.PI * 2;
    g.fillStyle = 'rgba(255,255,255,0.045)';
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, cx, a, a + 0.25 + Math.random() * 0.4);
    g.closePath();
    g.fill();
  }
  g.restore();
  return canvas;
}

/* ------------------------------------------------------------------------ mount */

export async function mountJewelCase(stage: HTMLElement, album: JewelCaseAlbum, options: JewelCaseOptions = {}): Promise<JewelCaseHandle | null> {
  const THREE = await import('three');
  const { RoundedBoxGeometry } = await import('three/examples/jsm/geometries/RoundedBoxGeometry.js');
  const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js');
  const { RectAreaLightUniformsLib } = await import('three/examples/jsm/lights/RectAreaLightUniformsLib.js');
  const BufferGeometryUtils = await import('three/examples/jsm/utils/BufferGeometryUtils.js');

  const P = detectTier();
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  /* ---------- renderer ---------- */

  let renderer: Three.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance', stencil: false });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, P.dpr));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  const el = renderer.domElement;
  stage.appendChild(el);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 40);
  camera.position.set(0, 0, 3.9);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.03);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.85;
  pmrem.dispose();

  /* ---------- lights ---------- */

  RectAreaLightUniformsLib.init();

  // Wide softbox upper-left: draws the long diagonal streak across the lid.
  const box1 = new THREE.RectAreaLight(0xffffff, 4.6, 3.2, 1.1);
  box1.position.set(-1.9, 1.9, 2.4);
  box1.lookAt(0, -0.1, 0);

  // Narrow vertical strip on the right: the second, tighter highlight.
  const box2 = new THREE.RectAreaLight(0xdce9ff, 3, 0.55, 3.4);
  box2.position.set(2.4, -0.5, 1.9);
  box2.lookAt(0, 0, 0);

  // Behind the case, so the back sleeve is lit once it spins around.
  const backLight = new THREE.RectAreaLight(0xffffff, 3.4, 2.8, 1.6);
  backLight.position.set(1.4, 1.2, -2.6);
  backLight.lookAt(0, 0, 0);

  const rim = new THREE.DirectionalLight(0xffffff, 1.3);
  rim.position.set(-2.6, 0.7, -2);

  const fill = new THREE.DirectionalLight(0xcfe0ff, 0.45);
  fill.position.set(1.4, -1.7, 2.6);

  scene.add(box1, box2, backLight, rim, fill);

  /* ---------- geometry ---------- */

  const W = 1.42;
  const H = 1.25; // a real jewel case is 142 × 125 × 10 mm
  const HINGE_W = 0.135;
  const SEG = P.seg;

  const junk: Array<{ dispose: () => void }> = [];
  const keep = <T extends { dispose: () => void }>(item: T): T => {
    junk.push(item);
    return item;
  };

  const dataTexture = (canvas: HTMLCanvasElement): Three.CanvasTexture => {
    const texture = keep(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.NoColorSpace; // data map — must stay linear
    return texture;
  };

  const scuffTex = dataTexture(makeScuffCanvas(Math.min(P.tex, 512)));

  /*
   * Clear polystyrene as two layers, the way product renderers fake glass: a faint tinted body that
   * lets the sleeve through, and an additive specular layer that carries the highlights at full
   * strength no matter how faint the body is. Cheaper than transmission, and it fades cleanly.
   */
  const glassBody = new THREE.MeshPhysicalMaterial({ color: 0xe6ebef, metalness: 0, roughness: 0.34, roughnessMap: scuffTex, specularIntensity: 0, transparent: true, opacity: 0.1, depthWrite: false });
  const glassSpec = new THREE.MeshPhysicalMaterial({
    color: 0x000000, // no diffuse — reflections only
    metalness: 0,
    roughness: 0.34,
    roughnessMap: scuffTex,
    ior: 1.585, // polystyrene
    clearcoat: 1,
    clearcoatRoughness: 0.035,
    envMapIntensity: 1.6,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  // Thin edges read denser than flat panels, and pick up a slight cool tint.
  const edgePlastic = new THREE.MeshPhysicalMaterial({ color: 0xd9e0e6, metalness: 0, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.4, transparent: true, opacity: 0.5, depthWrite: false });

  const caseGroup = new THREE.Group();
  scene.add(caseGroup);

  /*
   * Real hinge: the lid pivots on two pins at the spine, on the parting line where lid meets base —
   * not on the case's centre plane. The lid has lips on three sides only; its hinge edge is open so
   * it can rotate.
   *
   * Depth budget, front to back. Nothing may cross a neighbour:
   *   +0.050 .. +0.036  lid panel
   *   +0.038 .. +0.030  retention nubs, sleeve, booklet
   *   +0.021 .. -0.022  black tray and its ribbed spine  ] inside the case,
   *   -0.026 .. -0.032  tray card backing                ] in front of the card
   *   -0.034            tray card artwork
   *   -0.036 .. -0.050  clear back panel
   */
  const PARTING_Z = 0.012;
  const HINGE_X = -W / 2 + 0.008;
  const LID_H = H;

  const lidPivot = new THREE.Group();
  lidPivot.position.set(HINGE_X, 0, PARTING_Z);
  caseGroup.add(lidPivot);

  // Every material that belongs to the case, so it can fade as one. Materials flagged `solid` stay
  // opaque until a fade begins — opaque objects render first and write depth, which is what lets
  // the clear lid show them properly.
  const caseMats: Array<{ mat: Three.Material & { opacity: number }; base: number; solid: boolean }> = [];
  const caseMat = <T extends Three.Material & { opacity: number }>(mat: T, base = 1, solid = false): T => {
    mat.transparent = !solid;
    caseMats.push({ mat, base, solid });
    return keep(mat);
  };
  caseMat(glassBody, 0.1);
  caseMat(glassSpec, 1);
  caseMat(edgePlastic, 0.5);

  const glassPanel = (geo: Three.BufferGeometry): Three.Mesh => {
    keep(geo);
    const body = new THREE.Mesh(geo, glassBody);
    const spec = new THREE.Mesh(geo, glassSpec);
    spec.renderOrder = 2; // highlights go down after everything else
    body.add(spec);
    return body;
  };

  // front lid
  const lid = glassPanel(new RoundedBoxGeometry(W - 0.004, LID_H, 0.014, SEG, 0.007));
  lid.position.set(-HINGE_X - 0.002, 0, 0.043 - PARTING_Z);

  // back panel
  const tray = glassPanel(new RoundedBoxGeometry(W, H, 0.014, SEG, 0.007));
  tray.position.z = -0.043;

  // side walls
  const wallSet = (depth: number, z: number, dx: number, h: number, withHingeSide: boolean): Three.Mesh => {
    const geos = [
      new THREE.BoxGeometry(W, 0.012, depth).translate(dx, h / 2 - 0.006, z),
      new THREE.BoxGeometry(W, 0.012, depth).translate(dx, -h / 2 + 0.006, z),
      new THREE.BoxGeometry(0.012, h, depth).translate(dx + W / 2 - 0.006, 0, z),
    ];
    if (withHingeSide) geos.push(new THREE.BoxGeometry(0.012, h, depth).translate(dx - W / 2 + 0.006, 0, z));
    const merged = keep(BufferGeometryUtils.mergeGeometries(geos)!);
    for (const geo of geos) geo.dispose();
    return new THREE.Mesh(merged, edgePlastic);
  };
  const walls = wallSet(0.062, -0.019, 0, H, true);
  const lidWalls = wallSet(0.036, 0.032 - PARTING_Z, -HINGE_X - 0.002, LID_H, false);

  // hinge posts on the base (top-left, bottom-left) and the lid's pins
  const postGeos: Three.BufferGeometry[] = [];
  for (const sy of [1, -1]) postGeos.push(new THREE.BoxGeometry(0.03, 0.022, 0.022).translate(-W / 2 + 0.023, sy * (H / 2 - 0.026), PARTING_Z - 0.004));
  const posts = new THREE.Mesh(keep(BufferGeometryUtils.mergeGeometries(postGeos)!), edgePlastic);
  for (const geo of postGeos) geo.dispose();

  const pinGeos: Three.BufferGeometry[] = [];
  for (const sy of [1, -1]) pinGeos.push(new THREE.CylinderGeometry(0.006, 0.006, 0.02, 12).translate(0, sy * (LID_H / 2 + 0.008), 0));
  const pins = new THREE.Mesh(keep(BufferGeometryUtils.mergeGeometries(pinGeos)!), caseMat(new THREE.MeshPhysicalMaterial({ color: 0xd8dce2, roughness: 0.3, metalness: 0.1, clearcoat: 1 }), 1, true));
  for (const geo of pinGeos) geo.dispose();

  // sleeve art + its paper backing
  const artL = -W / 2 + HINGE_W + 0.024;
  const artR = W / 2 - 0.012;
  const artW = artR - artL;
  const artX = (artL + artR) / 2;
  const artH = H - 0.024;

  const artMat = caseMat(
    // colour multiplies the map — stands in for the light the lid absorbs, and keeps the sleeve
    // from blowing out under the softboxes
    new THREE.MeshStandardMaterial({ color: 0xb2b2b2, roughness: 0.68, metalness: 0, envMapIntensity: 0.7 }),
    1,
    true,
  );
  const art = new THREE.Mesh(keep(new THREE.PlaneGeometry(artW, artH)), artMat);
  art.position.set(artX - HINGE_X, 0, 0.03 - PARTING_Z);

  const paper = new THREE.Mesh(keep(new THREE.BoxGeometry(artW, artH, 0.006)), caseMat(new THREE.MeshStandardMaterial({ color: 0xf2f0ec, roughness: 0.85 }), 1, true));
  paper.position.set(artX - HINGE_X, 0, 0.026 - PARTING_Z);

  // back inlay card, facing -Z
  const backW = W - 0.03;
  const backH = H - 0.03;
  const backArtMat = caseMat(new THREE.MeshStandardMaterial({ color: 0xbcbcbc, roughness: 0.72, metalness: 0, envMapIntensity: 0.7 }), 1, true);
  const backArt = new THREE.Mesh(keep(new THREE.PlaneGeometry(backW, backH)), backArtMat);
  backArt.position.z = -0.034;
  backArt.rotation.y = Math.PI;

  const backBoard = new THREE.Mesh(keep(new THREE.BoxGeometry(backW, backH, 0.006)), caseMat(new THREE.MeshStandardMaterial({ color: 0x17171a, roughness: 0.82 }), 1, true));
  backBoard.position.z = -0.029;

  /*
   * The black tray: a full plate with a recessed disc well, and the ribbed spine beside it. It
   * lives *in front of* the tray card, the way it does in a real case — running it past the card is
   * what made the back look wrong.
   *
   * The disc lies on the face of the tray plate, not inside it. Everything here is measured off
   * DOCK_Z so the well, the hub and the disc stay consistent.
   */
  const hingeX = -W / 2 + HINGE_W / 2 + 0.012;
  const TRAY_Z = -0.002;
  const DOCK_Z = 0.003;
  const hingeGeos: Three.BufferGeometry[] = [
    new THREE.BoxGeometry(HINGE_W, H - 0.05, 0.04).translate(hingeX, 0, TRAY_Z),
    new THREE.BoxGeometry(W - HINGE_W - 0.06, H - 0.05, 0.012).translate(hingeX + HINGE_W / 2 + (W - HINGE_W - 0.06) / 2 + 0.004, 0, TRAY_Z - 0.008),
    new THREE.TorusGeometry(0.606, 0.0045, 8, 72).translate(artX, 0, DOCK_Z),
    new THREE.CylinderGeometry(0.058, 0.058, 0.019, 28).rotateX(Math.PI / 2).translate(artX, 0, DOCK_Z + 0.0025),
    new THREE.TorusGeometry(0.066, 0.005, 8, 32).translate(artX, 0, DOCK_Z + 0.009),
  ];
  for (let i = 0; i < 8; i += 1) {
    const x = hingeX - HINGE_W / 2 + 0.014 + i * ((HINGE_W - 0.028) / 7);
    hingeGeos.push(new THREE.BoxGeometry(0.009, H - 0.09, 0.018).translate(x, 0, TRAY_Z + 0.014));
  }
  const hinge = new THREE.Mesh(keep(BufferGeometryUtils.mergeGeometries(hingeGeos)!), caseMat(new THREE.MeshPhysicalMaterial({ color: 0x101014, roughness: 0.42, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.3 }), 1, true));
  for (const geo of hingeGeos) geo.dispose();

  // retention nubs on the inside of the lid
  const bossGeos: Three.BufferGeometry[] = [];
  for (const [sx, sy] of [
    [-1, 1],
    [1, 1],
    [-1, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
  ] as Array<[number, number]>) {
    const geo = new THREE.CylinderGeometry(0.032, 0.032, 0.008, 16);
    geo.rotateX(Math.PI / 2);
    geo.translate(artX - HINGE_X + sx * (artW / 2 - 0.062), sy * (artH / 2 - 0.055), 0.034 - PARTING_Z);
    bossGeos.push(geo);
  }
  const bosses = new THREE.Mesh(keep(BufferGeometryUtils.mergeGeometries(bossGeos)!), caseMat(new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, roughness: 0.25, metalness: 0, clearcoat: 1 }), 0.16));
  for (const geo of bossGeos) geo.dispose();

  lidPivot.add(lid, lidWalls, pins, art, paper, bosses);
  caseGroup.add(tray, walls, posts, backArt, backBoard, hinge);

  // where the disc sits when it's in the tray
  const dockSlot = new THREE.Object3D();
  dockSlot.position.set(artX, 0, DOCK_Z);
  caseGroup.add(dockSlot);

  /* ---------- the disc ---------- */

  // 120 mm disc, 15 mm hole, clear hub out to ~46 mm, 1.2 mm thick
  const DISC_R = 0.6;
  const HOLE_R = 0.075;
  const HUB_R = 0.23;
  const DISC_T = 0.012;

  const anisoTex = dataTexture(makeAnisotropyCanvas(512));
  const thickTex = dataTexture(makeThicknessCanvas(512));
  const grooveTex = dataTexture(makeGrooveCanvas(Math.min(P.tex, 512)));

  /*
   * Data side. The base is a bright silver mirror with radial anisotropy; the rainbow comes from a
   * diffraction-grating term patched into the shader below, because a pressed disc *is* a grating
   * (1.6 µm track pitch), not a thin film.
   */
  const dataMat = keep(
    new THREE.MeshPhysicalMaterial({
      color: 0xf1f3f6,
      metalness: 1,
      roughness: 0.3,
      roughnessMap: grooveTex,
      envMapIntensity: 1.1,
      iridescence: 0.25, // a whisper of film colour in the flats
      iridescenceIOR: 1.6,
      iridescenceThicknessRange: [200, 600],
      iridescenceThicknessMap: thickTex,
      anisotropy: 0.9,
      anisotropyMap: anisoTex,
      clearcoat: 0.4,
      clearcoatRoughness: 0.06,
    }),
  );

  // Directions toward the lights that produce spectral fans. Each one gives a symmetric set of
  // spokes; three of them give the multi-fan look of a real disc.
  const gratingUniforms = {
    uGratingDirs: { value: [box1.position.clone().normalize(), box2.position.clone().normalize(), backLight.position.clone().normalize()] },
    uGratingStrength: { value: 1.15 },
  };

  dataMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, gratingUniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
      varying vec3 vGWorld;
      varying vec3 vGRadial;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
      vGWorld  = (modelMatrix * vec4(position, 1.0)).xyz;
      vGRadial = normalize(mat3(modelMatrix) * vec3(normalize(position.xy), 0.0));`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
      varying vec3 vGWorld;
      varying vec3 vGRadial;
      uniform vec3 uGratingDirs[3];
      uniform float uGratingStrength;

      // wavelength (nm) -> linear rgb, gaussian bumps per channel
      vec3 spectrum(float nm) {
        float x = (nm - 380.0) / 400.0;
        float r = exp(-pow((x - 0.66) * 4.2, 2.0)) + 0.32 * exp(-pow((x - 0.06) * 7.0, 2.0));
        float g = exp(-pow((x - 0.40) * 4.6, 2.0));
        float b = exp(-pow((x - 0.17) * 4.8, 2.0));
        return clamp(vec3(r, g, b), 0.0, 1.0);
      }`,
      )
      .replace(
        '#include <opaque_fragment>',
        `
      {
        // Grating equation: sin(out) - sin(in) = m*lambda / d, with the grating vector radial.
        // Project the half-vector onto it; each order m returns the wavelength that reflects
        // toward the eye here, if any is visible. Everything in view space: the shader's normal
        // already is, and viewMatrix is a fragment uniform, so no inverse is needed.
        vec3 V = normalize(vViewPosition);
        vec3 radial = normalize(mat3(viewMatrix) * vGRadial);
        vec3 grating = normalize(radial - normal * dot(radial, normal));
        const float d = 1600.0;
        vec3 rainbow = vec3(0.0);
        for (int i = 0; i < 3; i++) {
          vec3 L = normalize(mat3(viewMatrix) * uGratingDirs[i]);
          vec3 Hv = L + V;
          float u = abs(dot(Hv, grating));
          float facing = max(dot(normal, L), 0.0) * max(dot(normal, V), 0.0);
          for (int m = 1; m <= 2; m++) {
            float lam = d * u / float(m);
            float vis = smoothstep(380.0, 420.0, lam) * (1.0 - smoothstep(700.0, 780.0, lam));
            rainbow += spectrum(lam) * vis * facing / float(m);
          }
        }
        float clean = 1.0 - roughnessFactor * 0.9;      // scratches kill diffraction
        outgoingLight += rainbow * uGratingStrength * clean * metalnessFactor;
      }
      #include <opaque_fragment>`,
      );
  };
  dataMat.customProgramCacheKey = () => 'cd-grating';

  // Label side: printed on a silver base, so it keeps a little metal in it.
  const labelMat = keep(new THREE.MeshPhysicalMaterial({ color: 0xd6d6d6, metalness: 0.28, roughness: 0.34, clearcoat: 0.7, clearcoatRoughness: 0.12, envMapIntensity: 0.9 }));

  const clearPoly = keep(new THREE.MeshPhysicalMaterial({ color: 0xe9ecf0, transparent: true, opacity: 0.32, roughness: 0.08, metalness: 0, ior: 1.58, clearcoat: 1, clearcoatRoughness: 0.04, side: THREE.DoubleSide, depthWrite: false }));

  const discPivot = new THREE.Group(); // placed and tilted by the animation
  const disc = new THREE.Group(); // spins about its own normal (+Z)
  discPivot.add(disc);
  scene.add(discPivot);

  const labelFace = new THREE.Mesh(keep(new THREE.RingGeometry(HUB_R, DISC_R, 128, 1)), labelMat);
  labelFace.position.z = DISC_T / 2;
  const dataFace = new THREE.Mesh(keep(new THREE.RingGeometry(HUB_R, DISC_R, 128, 1)), dataMat);
  dataFace.rotation.y = Math.PI; // faces -Z
  dataFace.position.z = -DISC_T / 2;
  const hub = new THREE.Mesh(keep(new THREE.RingGeometry(HOLE_R, HUB_R, 64, 1)), clearPoly);

  // mirror band just inside the data area, and the dark stacking ring — the two things your eye
  // uses to read "CD" at the centre
  const mirrorBand = new THREE.Mesh(keep(new THREE.RingGeometry(0.186, 0.232, 96, 1)), keep(new THREE.MeshPhysicalMaterial({ color: 0xf6f7f9, metalness: 1, roughness: 0.05, side: THREE.DoubleSide, envMapIntensity: 1.3 })));
  const stackRing = new THREE.Mesh(keep(new THREE.RingGeometry(0.162, 0.176, 64, 1)), keep(new THREE.MeshStandardMaterial({ color: 0x2b2c31, roughness: 0.5, metalness: 0.2, side: THREE.DoubleSide })));

  const rimGeos = [new THREE.CylinderGeometry(DISC_R, DISC_R, DISC_T, 128, 1, true).rotateX(Math.PI / 2), new THREE.CylinderGeometry(HOLE_R, HOLE_R, DISC_T, 48, 1, true).rotateX(Math.PI / 2)];
  const rims = new THREE.Mesh(
    keep(BufferGeometryUtils.mergeGeometries(rimGeos)!),
    keep(new THREE.MeshPhysicalMaterial({ color: 0xf2f5f8, transparent: true, opacity: 0.62, roughness: 0.12, metalness: 0.15, ior: 1.58, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.6, side: THREE.DoubleSide, depthWrite: false })),
  );
  for (const geo of rimGeos) geo.dispose();

  disc.add(labelFace, dataFace, hub, mirrorBand, stackRing, rims);

  // Soft contact shadow. Kept small enough that its gradient reaches zero alpha well inside the
  // frustum — otherwise it clips into a hard square at the canvas edge.
  const shadowTex = dataTexture(makeShadowCanvas());
  const shadow = new THREE.Mesh(keep(new THREE.PlaneGeometry(2, 1.85)), keep(new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.4 })));
  shadow.position.set(0.1, -0.1, -0.5);
  scene.add(shadow);

  /* ---------- artwork ---------- */

  const loadImage = (url: string): Promise<HTMLImageElement | null> =>
    new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = url;
    });

  /**
   * Swapping the sleeve, tray card and disc label together. The swap is held until the case is
   * fully shut (see `pendingAlbum` in tick), so the change is never seen mid-animation — the case
   * closes on one album and opens on the other.
   */
  let liveTextures: Three.Texture[] = [];

  const applyAlbum = async (next: JewelCaseAlbum): Promise<void> => {
    // The reference generates its sleeve; its own comment says to swap in real artwork, which is
    // what a real library has. The generated wash is the fallback, not the intent.
    const real = next.coverUrl ? await loadImage(next.coverUrl) : null;
    const coverCanvas = makeCoverCanvas(P.tex, next.mood === 'shared' ? SHARED_COVER : SOLO_COVER);
    if (real) coverCanvas.getContext('2d')!.drawImage(real, 0, 0, P.tex, P.tex);

    const spine = `${next.artist} — ${next.album ?? next.title}`.toUpperCase();
    const backCanvas = makeBackCanvas(P.tex, {
      grad: next.mood === 'shared' ? ['#070d26', '#152a63', '#2f6aa8'] : ['#25100a', '#6d2a0c', '#ad4a12'],
      echo: next.mood === 'shared' ? 'rgba(126,216,247,0.34)' : 'rgba(255,186,86,0.4)',
      echoAt: next.mood === 'shared' ? [0.24, 0.2] : [0.8, 0.16],
      spine,
      tracks: next.tracks.slice(0, 10).map((name) => name.slice(0, 42)),
      footer: next.album ?? next.title,
    });
    const labelCanvas = makeLabelCanvas(coverCanvas, Math.min(P.tex, 512));

    const cover = new THREE.CanvasTexture(coverCanvas);
    const back = new THREE.CanvasTexture(backCanvas);
    const label = new THREE.CanvasTexture(labelCanvas);
    for (const texture of [cover, back, label]) {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = P.aniso;
    }

    artMat.map = cover;
    backArtMat.map = back;
    labelMat.map = label;
    artMat.needsUpdate = true;
    backArtMat.needsUpdate = true;
    labelMat.needsUpdate = true;

    for (const texture of liveTextures) texture.dispose();
    liveTextures = [cover, back, label];
  };

  await applyAlbum(album);

  /* ---------- interaction ---------- */

  const SPIN = 0.34; // case idle spin, rad/s
  const DISPLAY_RY = 0.3; // case angle while opening: hinge a little nearer
  const LID_OPEN = 2.62; // ~150° — a jewel case falls open well past 90°, and it keeps the lid clear of the disc's path
  const DISC_SPIN = reduceMotion ? 1 : 8; // about its own axis
  const DISC_TURN = reduceMotion ? 0 : 0.42; // turntable, so the rim and data side come round
  const DISC_TILT = -0.7; // tipped back, like a disc held up to the light
  const OPEN_DUR = 2.3; // seconds for the whole open or close sequence
  const TWO_PI = Math.PI * 2;

  let playing = false;
  let idleT = 0;
  let baseRY = 0.35;
  let curRY = 0.35;
  let curRX = 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let openT = 0; // 0 closed, 1 playing
  let spinSpeed = 0;
  let turn = 0;
  let wasPlaying: boolean | null = null;
  let albumNow = album;
  let pendingAlbum: JewelCaseAlbum | null = null;

  // Drag routes to whichever object is out: the disc while it's playing, the case otherwise. A
  // flick on release carries momentum that decays.
  let dragTarget: 'case' | 'disc' | null = null;
  let lastDiscT = 0;
  let velY = 0;
  let lastMoveT = 0;
  let flickY = 0;
  let flickTarget: 'case' | 'disc' | null = null;

  // Pose the person has dragged the models into. Nothing here decays or snaps back — it holds
  // until they move it again, and is written to storage.
  let caseYOffset = 0;
  let caseTilt = 0;
  let discTilt = 0;

  const clampv = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
  const wrapPi = (a: number): number => {
    const t = (a + Math.PI) % TWO_PI;
    return (t < 0 ? t + TWO_PI : t) - Math.PI;
  };

  let saveTimer = 0;
  const savePose = (immediate?: boolean): void => {
    if (!options.savePose) return;
    window.clearTimeout(saveTimer);
    const write = (): void => options.savePose?.({ caseY: wrapPi(caseYOffset), caseX: caseTilt, discY: wrapPi(turn), discX: discTilt });
    if (immediate) write();
    else saveTimer = window.setTimeout(write, 300);
  };

  void options.loadPose?.().then((pose) => {
    if (!pose) return;
    caseYOffset = pose.caseY || 0;
    caseTilt = pose.caseX || 0;
    discTilt = pose.discX || 0;
    turn = pose.discY || 0;
    baseRY = DISPLAY_RY + caseYOffset;
    curRY = baseRY;
  });

  const onPointerDown = (e: PointerEvent): void => {
    dragging = true;
    dragTarget = lastDiscT > 0.5 ? 'disc' : 'case';
    flickY = 0;
    velY = 0;
    lastX = e.clientX;
    lastY = e.clientY;
    lastMoveT = performance.now();
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('is-dragging');
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    const now = performance.now();
    const dtm = Math.max((now - lastMoveT) / 1000, 0.004);
    const scale = dragTarget === 'disc' ? 0.011 : 0.009;

    if (dragTarget === 'disc') {
      turn += dx * scale;
      discTilt = clampv(discTilt + dy * 0.006, -0.55, 0.55);
    } else {
      baseRY += dx * scale;
      // only meaningful while the case holds its display angle; when paused it free-spins, so
      // there is no fixed angle to be offset from
      if (playing) caseYOffset = wrapPi(caseYOffset + dx * scale);
      caseTilt = clampv(caseTilt + dy * 0.005, -0.45, 0.45);
    }

    velY = velY * 0.55 + ((dx * scale) / dtm) * 0.45; // smoothed, rad/s
    lastX = e.clientX;
    lastY = e.clientY;
    lastMoveT = now;
  };

  const endDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    stage.classList.remove('is-dragging');
    // released while still moving → carry the momentum
    if (performance.now() - lastMoveT < 90) {
      flickY = clampv(velY, -14, 14);
      flickTarget = dragTarget;
    }
    dragTarget = null;
    savePose();
  };

  // double-click / double-tap puts everything back to the default pose
  const onDoubleClick = (): void => {
    caseYOffset = 0;
    caseTilt = 0;
    discTilt = 0;
    turn = Math.round(turn / TWO_PI) * TWO_PI;
    if (playing) baseRY = DISPLAY_RY + Math.round((curRY - DISPLAY_RY) / TWO_PI) * TWO_PI;
    savePose();
  };

  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('dblclick', onDoubleClick);

  /* ---------- resize, visibility, loop ---------- */

  const BLEED = 0.48;
  const FILL = 0.9;
  const room = stage.closest('.np-hero__inner');

  const resize = (): void => {
    const stageW = Math.max(1, Math.round(stage.getBoundingClientRect().width));
    // Never wider than the content box: the bleed exists to give the shadow room to fade, not to
    // widen the page. The camera framing below reads canvasPx, so clamping here rescales the scene
    // rather than cropping it.
    const available = room ? room.clientWidth : Infinity;
    const canvasPx = Math.min(Math.round(stageW * (1 + 2 * BLEED)), Math.floor(available));

    renderer.setSize(canvasPx, canvasPx, false);
    el.style.width = `${canvasPx}px`;
    el.style.height = `${canvasPx}px`;

    const visibleW = (W * canvasPx) / (FILL * stageW);
    camera.aspect = 1;
    camera.position.z = visibleW / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    camera.updateProjectionMatrix();
  };
  resize();
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);

  let onScreen = true;
  const updateLoop = (): void => renderer.setAnimationLoop(onScreen && !document.hidden ? tick : null);
  const intersection = new IntersectionObserver((entries) => {
    onScreen = entries[0]?.isIntersecting ?? true;
    updateLoop();
  }, { threshold: 0 });
  intersection.observe(stage);
  document.addEventListener('visibilitychange', updateLoop);

  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
  const remap = (a: number, b: number, v: number): number => clamp01((v - a) / (b - a));
  const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

  const dockPos = new THREE.Vector3();
  const dockQuat = new THREE.Quaternion();
  const hoverPos = new THREE.Vector3(0, 0.02, 1.6); // centred, close: the disc becomes the hero
  const hoverQuat = new THREE.Quaternion();
  const hoverEuler = new THREE.Euler();
  const caseShadowPos = new THREE.Vector3();
  const discShadowPos = new THREE.Vector3(0.06, -0.16, 0.25);

  let painted = false;
  const clock = new THREE.Clock();

  function tick(): void {
    const dt = Math.min(clock.getDelta(), 0.05);
    if (!reduceMotion) idleT += dt;

    /* --- state edges --- */
    if (playing !== wasPlaying) {
      if (playing) {
        const home = DISPLAY_RY + caseYOffset; // the angle they left it at
        baseRY = home + Math.round((curRY - home) / TWO_PI) * TWO_PI;
      } else {
        baseRY = curRY;
      }
      wasPlaying = playing;
    }

    /*
     * Sequence. Three staggered curves off one progress value, so the reverse (pause) plays the
     * same beats in the opposite order:
     *   open:  lid swings → disc lifts out → case fades away
     *   close: case fades in → disc settles back → lid closes
     */
    // A pending album swap forces the case shut first, exactly like a pause.
    const wantOpen = playing && pendingAlbum === null;
    openT = clamp01(openT + ((wantOpen ? 1 : -1) * dt) / OPEN_DUR);
    if (pendingAlbum !== null && openT <= 0.001) {
      albumNow = pendingAlbum;
      pendingAlbum = null;
      void applyAlbum(albumNow);
    }
    const lidT = easeInOut(remap(0, 0.32, openT));
    const discT = easeInOut(remap(0.46, 0.84, openT)); // rests in the tray first
    const fadeT = easeInOut(remap(0.66, 1, openT));
    const caseAlpha = 1 - fadeT;

    /* --- case rotation --- */
    if (playing) {
      baseRY += Math.sin(idleT * 0.5) * 0.0004;
    } else if (!dragging && !reduceMotion) {
      baseRY += SPIN * dt;
    }
    // momentum from a flick, on whichever object was thrown
    if (flickY !== 0) {
      const step = flickY * dt;
      if (flickTarget === 'disc') {
        turn += step;
      } else {
        baseRY += step;
        if (playing) caseYOffset = wrapPi(caseYOffset + step);
      }
      flickY *= 0.12 ** dt;
      if (Math.abs(flickY) < 0.02) {
        flickY = 0;
        savePose();
      }
    }

    const targetRX = -0.05 + (reduceMotion ? 0 : Math.sin(idleT * 0.27) * 0.06) + caseTilt;
    const kY = 1 - (playing ? 0.06 : 0.002) ** dt;
    const kX = 1 - 0.002 ** dt;
    curRY += (baseRY - curRY) * kY;
    curRX += (targetRX - curRX) * kX;

    caseGroup.rotation.y = curRY;
    caseGroup.rotation.x = curRX;
    lidPivot.rotation.y = -LID_OPEN * lidT;

    /* --- case fade: opacity down, drift back and shrink a touch --- */
    for (const { mat, base, solid } of caseMats) {
      mat.opacity = base * caseAlpha;
      if (solid) mat.transparent = caseAlpha < 0.999;
    }
    caseGroup.position.z = -0.35 * fadeT;
    caseGroup.scale.setScalar(1 - 0.08 * fadeT);
    caseGroup.visible = caseAlpha > 0.002; // don't draw it at all once gone

    /* --- disc: dock ↔ hover --- */
    caseGroup.updateMatrixWorld();
    dockSlot.getWorldPosition(dockPos);
    dockSlot.getWorldQuaternion(dockQuat);

    // Turntable only while playing and not being held; when paused the disc keeps whatever angle
    // it was left at. Docking is unaffected — the pose slerps to the tray's own orientation as
    // discT falls to zero.
    const holdingDisc = dragging && dragTarget === 'disc';
    if (playing && !holdingDisc) turn += DISC_TURN * dt;
    lastDiscT = discT;

    const wob = reduceMotion || holdingDisc ? 0 : discT; // no wobble in the hand
    hoverEuler.set(DISC_TILT + discTilt + Math.sin(idleT * 1.7) * 0.05 * wob, turn + Math.sin(idleT * 1.3 + 1) * 0.06 * wob, 0);
    hoverQuat.setFromEuler(hoverEuler);

    discPivot.position.lerpVectors(dockPos, hoverPos, discT);
    const arc = Math.sin(discT * Math.PI);
    discPivot.position.y += arc * 0.34;
    discPivot.position.x += arc * 0.06;
    discPivot.quaternion.slerpQuaternions(dockQuat, hoverQuat, discT);
    // Always rendered: while the case is shut the booklet hides it, and as the lid swings the disc
    // is already sitting in the tray where it belongs.
    discPivot.visible = true;

    const spinTarget = playing ? DISC_SPIN : 0;
    spinSpeed += (spinTarget - spinSpeed) * (1 - (playing ? 0.15 : 0.02) ** dt);
    disc.rotation.z += spinSpeed * dt;

    /* --- shadow: under the case while it's here, under the disc once it's gone --- */
    caseShadowPos.set(0.1 + Math.sin(curRY) * 0.18, -0.1, -0.5);
    shadow.position.lerpVectors(caseShadowPos, discShadowPos, discT);
    shadow.scale.set(THREE.MathUtils.lerp(0.55 + 0.45 * Math.abs(Math.cos(curRY)), 0.78, discT), THREE.MathUtils.lerp(1, 0.78, discT), 1);
    shadow.material.opacity = THREE.MathUtils.lerp(0.4, 0.32, discT);

    renderer.render(scene, camera);

    if (!painted) {
      painted = true;
      stage.classList.add('is-3d');
    }
  }

  updateLoop();

  return {
    setPlaying: (next) => {
      playing = next;
    },
    setAlbum: (next) => {
      if (next.title === albumNow.title && next.album === albumNow.album && next.coverUrl === albumNow.coverUrl) return;
      pendingAlbum = next; // taken once the case is shut
    },
    dispose: () => {
      savePose(true);
      renderer.setAnimationLoop(null);
      resizeObserver.disconnect();
      intersection.disconnect();
      document.removeEventListener('visibilitychange', updateLoop);
      stage.removeEventListener('pointerdown', onPointerDown);
      stage.removeEventListener('pointermove', onPointerMove);
      stage.removeEventListener('pointerup', endDrag);
      stage.removeEventListener('pointercancel', endDrag);
      stage.removeEventListener('dblclick', onDoubleClick);
      window.clearTimeout(saveTimer);
      for (const texture of liveTextures) texture.dispose();
      for (const item of junk) item.dispose();
      envRT.texture.dispose();
      envRT.dispose();
      renderer.dispose();
      el.remove();
      stage.classList.remove('is-3d', 'is-dragging');
    },
  };
}
