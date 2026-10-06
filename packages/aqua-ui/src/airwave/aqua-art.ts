/**
 * AquaArt: the Airwave window's drawn controls — the Snow Leopard push button and the 10.4 pop-up
 * and checkbox.
 *
 * One port of the `AquaArt` script that `design/frontends/origin/airwave-hub.html` and
 * `airwave-companion.html` both carry, kept line for line with it: each control is drawn as an SVG
 * from colour profiles sampled row by row from the reference and handed to CSS as a `border-image`
 * source on `:root` (`--aq-btn-22`, `--aq-def-22`, `--aq-pop-22`, `--aq-cb-14` and their `-down`,
 * `-off` and `-on` forms). `airwave-window.css` only chooses which drawing a control wears, so
 * without this module every `.push`, `.pop` and `.box` is an empty rectangle.
 *
 * The hub admin GUI and the Windows companion each used to keep their own copy; the two drew the
 * same bytes, and both now import this one as `@now-playing/aqua-ui/airwave-art`. It is a subpath
 * and not part of the package index because the index loads the older Aqua stylesheet, which the
 * Airwave windows do not wear. (The player's shell carries the design's own script in its
 * generated `index.html`.)
 *
 * A material is its gradient, so the sampled rows travel together here rather than as tokens
 * (design/decisions.md NPD-021). The drawings are data: URIs, which both products' content security
 * policies allow for images.
 */
type Rgb = readonly [number, number, number];

const PROF: Record<'cancel' | 'save' | 'popup' | 'arrow', readonly Rgb[]> = {
  cancel: [[234, 234, 233], [211, 212, 210], [115, 115, 113], [167, 167, 167], [200, 200, 198], [209, 209, 207], [216, 216, 214], [220, 220, 220], [218, 218, 218], [206, 206, 206], [198, 198, 198], [200, 200, 200], [208, 208, 208], [210, 210, 210], [216, 216, 216], [225, 225, 225], [236, 236, 236], [247, 247, 247], [252, 252, 252], [253, 253, 253], [254, 254, 254], [254, 254, 254], [254, 254, 254], [248, 248, 248], [107, 107, 107], [119, 119, 119], [132, 132, 132], [168, 168, 168], [201, 200, 200]],
  save: [[231, 239, 248], [210, 228, 245], [57, 78, 100], [116, 143, 170], [154, 183, 212], [169, 198, 227], [175, 203, 234], [180, 207, 240], [172, 202, 233], [157, 188, 222], [144, 177, 215], [143, 179, 219], [152, 187, 227], [157, 190, 230], [166, 197, 234], [174, 207, 241], [185, 219, 247], [191, 227, 252], [198, 236, 255], [200, 241, 255], [205, 244, 255], [206, 243, 255], [208, 243, 255], [194, 224, 235], [96, 119, 131], [113, 129, 139], [139, 147, 155], [171, 175, 183], [211, 211, 215]],
  popup: [[231, 226, 223], [226, 222, 220], [167, 165, 161], [216, 216, 213], [234, 235, 234], [232, 233, 232], [230, 231, 230], [228, 229, 228], [229, 229, 229], [234, 234, 234], [239, 237, 238], [241, 240, 240], [243, 242, 242], [246, 245, 245], [247, 247, 247], [250, 250, 250], [253, 253, 253], [255, 255, 255], [255, 255, 255], [255, 255, 255], [255, 255, 253], [255, 255, 253], [245, 243, 242], [109, 108, 107], [178, 174, 172], [234, 229, 227], [228, 223, 221], [227, 220, 219]],
  arrow: [[235, 234, 229], [219, 235, 230], [60, 79, 114], [150, 179, 223], [183, 215, 248], [171, 206, 239], [153, 189, 233], [131, 167, 223], [115, 158, 215], [121, 165, 218], [133, 178, 216], [142, 187, 224], [147, 195, 241], [151, 199, 248], [157, 210, 250], [164, 213, 247], [168, 219, 249], [170, 224, 251], [175, 231, 255], [182, 238, 255], [188, 237, 253], [192, 233, 244], [181, 211, 217], [94, 113, 121], [166, 176, 183], [224, 226, 227], [230, 223, 224], [224, 217, 215]],
};

const P = {
  cancel: { rimW: 8.896, rimBlur: 3.201, rimOp: 0.501, rimExt: 1.193, rimBot: 0.446, olW: 0.267, olOp: 0.534, sh1dy: 1.842, sh1op: 0.432, sh1blur: 0.933, sh1in: 0.755, sh2dy: 5, sh2op: 0.291, sh2blur: 1.5 },
  save: { rimW: 11.848, rimBlur: 2.534, rimOp: 0.529, rimExt: 1.2, rimBot: 0.331, olW: 2.881, olOp: 0.557, sh1dy: 1.786, sh1op: 0.313, sh1blur: 0.933, sh1in: 0, sh2dy: 4.141, sh2op: 0.316, sh2blur: 1.5 },
  popup: { r: 4, shBlur: 0.8, shDy: 0.778, shOp: 0.371, segOp: 0.144, rimW: 0.5, rimOp: 0.315, apex: 5.1 },
} as const;

const DOWN: Record<'save' | 'cancel', Rgb> = { save: [0.62, 0.72, 0.86], cancel: [0.78, 0.78, 0.78] };

interface State {
  down?: boolean;
  off?: boolean;
  on?: boolean;
}

let uid = 0;

function rgb(c: readonly number[]): string {
  return `rgb(${c[0]! | 0},${c[1]! | 0},${c[2]! | 0})`;
}
function stops(rows: readonly (readonly number[])[]): string {
  return rows.map((c, i) => `<stop offset="${((i + 0.5) / rows.length).toFixed(4)}" stop-color="${rgb(c)}"/>`).join('');
}
function resample(rows: readonly (readonly number[])[], n: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) * rows.length) / n - 0.5;
    const a = Math.max(0, Math.floor(t));
    const b = Math.min(rows.length - 1, a + 1);
    const f = Math.min(1, Math.max(0, t - a));
    out.push(rows[a]!.map((v, j) => v * (1 - f) + rows[b]![j]! * f));
  }
  return out;
}
function tint(rows: readonly (readonly number[])[], k: readonly number[]): number[][] {
  return rows.map((c) => c.map((v, i) => v * k[i]!));
}
function pill(x: number, y: number, w: number, h: number, r: number): string {
  return `M${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w - r},${y + h}H${x + r}A${r},${r} 0 0 1 ${x + r},${y}Z`;
}
function rr(x: number, y: number, w: number, h: number, r: number): string {
  return `M${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x + r}Q${x},${y + h} ${x},${y + h - r}V${y + r}Q${x},${y} ${x + r},${y}Z`;
}
function svg(w: number, h: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
}
const WASH = (d: string): string => `<path d="${d}" fill="#fff" opacity=".45"/>`;

/** How far each drawing reaches past its control: CSS uses the same numbers for border-image-outset and -slice. */
export function geo(H: number): { M: number; T: number; B: number; slice: number; sw: number } {
  const B = Math.ceil((8 * H) / 22);
  return { M: 6, T: 2, B, slice: 6 + Math.ceil((H / 2) * 1.25) + 2, sw: Math.round(22 + (H - 22) / 2) };
}

type Metal = { face: readonly (readonly [number, string])[]; edge: readonly [string, string]; hi: number };
const METAL: Record<'cancel' | 'save' | 'down' | 'defdown', Metal> = {
  cancel: { face: [[0, '#fdfdfd'], [0.1, '#f5f5f5'], [0.46, '#e9e9e9'], [0.5, '#dfdfdf'], [0.82, '#e4e4e4'], [1, '#f0f0f0']], edge: ['#a3a3a3', '#6c6c6c'], hi: 0.9 },
  save: { face: [[0, '#e3f0fd'], [0.1, '#bcdaf8'], [0.46, '#8cbcef'], [0.5, '#6ea6e8'], [0.82, '#88bdf0'], [1, '#b5dcfa']], edge: ['#5a86bd', '#2c5184'], hi: 0.75 },
  down: { face: [[0, '#c5dcf5'], [0.1, '#9cc3ee'], [0.46, '#6a9fe0'], [0.5, '#4f8ad6'], [0.82, '#6aa2e2'], [1, '#93c4f0']], edge: ['#3f6aa3', '#1d3e6e'], hi: 0.45 },
  defdown: { face: [[0, '#a9c9ec'], [0.1, '#7fabe0'], [0.46, '#4f86d0'], [0.5, '#3a73c4'], [0.82, '#5089d2'], [1, '#7cb0e6']], edge: ['#2d5588', '#16325a'], hi: 0.35 },
};

/** kind 'cancel' is the ordinary button, 'save' the default one. */
export function button(kind: 'cancel' | 'save', H: number, st: State = {}): string {
  const m = METAL[st.down ? (kind === 'save' ? 'defdown' : 'down') : kind];
  const g = geo(H);
  const W = 60;
  const r = H / 2;
  const M = g.M;
  const id = `aq${uid++}`;
  const w = W + 2 * M;
  const h = 2 + H + g.B;
  const d = pill(M, 2, W, H, r);
  const inner = pill(M + 0.5, 2.5, W - 1, H - 1, r - 0.5);
  const hl = pill(M + 1, 3, W - 2, H - 2, r - 1);
  const face = m.face.map((s) => `<stop offset="${s[0]}" stop-color="${s[1]}"/>`).join('');
  return svg(
    w,
    h,
    `<defs><linearGradient id="${id}f" x1="0" y1="0" x2="0" y2="1">${face}</linearGradient>` +
      `<linearGradient id="${id}e" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${m.edge[0]}"/><stop offset="1" stop-color="${m.edge[1]}"/></linearGradient>` +
      `<linearGradient id="${id}h" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="${m.hi}"/><stop offset=".35" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
      // a faint brushed grain, lengthwise, so the face reads as metal not paint
      `<pattern id="${id}g" width="7" height="3" patternUnits="userSpaceOnUse"><rect width="7" height="1" fill="#fff" opacity=".22"/><rect y="2" width="7" height="1" fill="#000" opacity=".025"/></pattern>` +
      `<filter id="${id}s" x="-10%" y="-40%" width="120%" height="180%"><feGaussianBlur stdDeviation=".6"/></filter></defs>` +
      `<path d="${pill(M, 3, W, H, r)}" opacity=".22" filter="url(#${id}s)"/>` +
      `<path d="${d}" fill="url(#${id}f)"/>` +
      `<path d="${d}" fill="url(#${id}g)"/>` +
      `<path d="${hl}" fill="none" stroke="url(#${id}h)" stroke-width="1"/>` +
      `<path d="${inner}" fill="none" stroke="url(#${id}e)" stroke-width="1"/>` +
      (st.off ? WASH(d) : ''),
  );
}

export function popup(H: number, st: State = {}): string {
  const p = P.popup;
  const g = geo(H);
  const W = 80;
  const r = p.r;
  const M = g.M;
  const SW = g.sw;
  const id = `aq${uid++}`;
  let body = resample(PROF.popup.slice(2, 24), H);
  let arr = resample(PROF.arrow.slice(2, 24), H);
  if (st.down) {
    body = tint(body, [0.82, 0.82, 0.82]);
    arr = tint(arr, [0.62, 0.74, 0.9]);
  }
  const d = rr(M, 2, W, H, r);
  const ax = M + W - SW;
  const cy = 2 + H / 2;
  const cx = ax + SW / 2;
  const w = W + 2 * M;
  const h = 2 + H + g.B;
  return svg(
    w,
    h,
    `<defs><linearGradient id="${id}b" gradientUnits="userSpaceOnUse" x1="0" y1="2" x2="0" y2="${2 + H}">${stops(body)}</linearGradient>` +
      `<linearGradient id="${id}a" gradientUnits="userSpaceOnUse" x1="0" y1="2" x2="0" y2="${2 + H}">${stops(arr)}</linearGradient>` +
      `<clipPath id="${id}c"><path d="${d}"/></clipPath>` +
      `<filter id="${id}f" x="-10%" y="-50%" width="120%" height="200%"><feGaussianBlur stdDeviation="${p.shBlur}"/></filter></defs>` +
      `<path d="${rr(M, 2 + p.shDy, W, H, r)}" opacity="${p.shOp}" filter="url(#${id}f)"/>` +
      `<path d="${d}" fill="url(#${id}b)"/>` +
      `<g clip-path="url(#${id}c)"><rect x="${ax}" y="0" width="${SW + M}" height="${H + 4}" fill="url(#${id}a)"/>` +
      `<rect x="${ax}" y="2" width="1" height="${H}" fill="#2a4f86" opacity="${p.segOp}"/>` +
      `<path d="${rr(ax, 2, SW, H, r)}" fill="none" stroke="#062a66" stroke-width="${p.rimW}" opacity="${p.rimOp}"/></g>` +
      `<path d="M${cx - 3},${cy - 1}H${cx + 3}L${cx},${cy - 11 + p.apex}Z M${cx - 3},${cy + 1}H${cx + 3}L${cx},${cy + 11 - p.apex}Z"/>` +
      (st.off ? WASH(d) : ''),
  );
}

export function checkbox(S: number, st: State = {}): string {
  const on = !!st.on;
  const kind = on ? 'save' : 'cancel';
  const p = P[kind];
  const id = `aq${uid++}`;
  const M = 4;
  const r = 3.2;
  const k = S / 22;
  let body = resample(PROF[kind].slice(2, 24), S);
  if (st.down) body = tint(body, DOWN[kind]);
  const d = rr(M, 2, S, S, r);
  const rc = on ? '#06204a' : '#000';
  const w = S + 2 * M;
  const h = S + 8;
  const s = S / 14;
  const mark = on ? `<path transform="translate(${M},2) scale(${s})" d="M3.2,7.6 L6.2,11 L13.6,-0.6" fill="none" stroke="#000" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>` : '';
  return svg(
    w,
    h,
    `<defs><linearGradient id="${id}b" gradientUnits="userSpaceOnUse" x1="0" y1="2" x2="0" y2="${2 + S}">${stops(body)}</linearGradient>` +
      `<clipPath id="${id}c"><path d="${d}"/></clipPath>` +
      `<filter id="${id}f1" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${(p.sh1blur * k).toFixed(3)}"/></filter>` +
      `<filter id="${id}f2" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${(p.sh2blur * k).toFixed(3)}"/></filter>` +
      `<filter id="${id}fr" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${(p.rimBlur * k * 0.8).toFixed(3)}"/></filter>` +
      `<linearGradient id="${id}mv" gradientUnits="userSpaceOnUse" x1="0" y1="2" x2="0" y2="${2 + S}"><stop offset=".45" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="${p.rimBot}"/></linearGradient>` +
      `<mask id="${id}m" maskUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}"><rect width="100%" height="100%" fill="url(#${id}mv)"/></mask></defs>` +
      `<path d="${rr(M, 2 + p.sh2dy * k, S, S, r)}" opacity="${p.sh2op * 0.8}" filter="url(#${id}f2)"/>` +
      `<path d="${rr(M, 2 + p.sh1dy * k, S, S, r)}" opacity="${p.sh1op}" filter="url(#${id}f1)"/>` +
      `<path d="${d}" fill="url(#${id}b)"/>` +
      `<g clip-path="url(#${id}c)" mask="url(#${id}m)"><path d="${d}" fill="none" stroke="${rc}" stroke-width="${(p.rimW * k * 0.7).toFixed(2)}" opacity="${p.rimOp * 0.5}" filter="url(#${id}fr)"/>` +
      `<path d="${d}" fill="none" stroke="${rc}" stroke-width="1.1" opacity="${Math.max(0.45, p.olOp)}"/></g>` +
      mark +
      (st.off ? WASH(d) : ''),
  );
}

function uri(s: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(s)}")`;
}

/**
 * Publishes every drawing as a custom property on the root element, e.g. `--aq-btn-22`,
 * `--aq-btn-22-down`, `--aq-def-22-off`, `--aq-pop-22`, `--aq-cb-14-on-down`.
 */
export function installAquaArt(sizes: { btn?: number[]; pop?: number[]; cb?: number[] } = { btn: [22], pop: [22], cb: [14] }, root: HTMLElement = document.documentElement): void {
  const set = (name: string, drawing: string): void => root.style.setProperty(name, uri(drawing));
  for (const H of sizes.btn ?? []) {
    for (const [prefix, kind] of [['btn', 'cancel'], ['def', 'save']] as const) {
      set(`--aq-${prefix}-${H}`, button(kind, H));
      set(`--aq-${prefix}-${H}-down`, button(kind, H, { down: true }));
      set(`--aq-${prefix}-${H}-off`, button(kind, H, { off: true }));
    }
  }
  for (const H of sizes.pop ?? []) {
    set(`--aq-pop-${H}`, popup(H));
    set(`--aq-pop-${H}-down`, popup(H, { down: true }));
    set(`--aq-pop-${H}-off`, popup(H, { off: true }));
  }
  for (const S of sizes.cb ?? []) {
    for (const [suffix, on] of [['', false], ['-on', true]] as const) {
      set(`--aq-cb-${S}${suffix}`, checkbox(S, { on }));
      set(`--aq-cb-${S}${suffix}-down`, checkbox(S, { on, down: true }));
      set(`--aq-cb-${S}${suffix}-off`, checkbox(S, { on, off: true }));
    }
  }
}
