/**
 * A mockup at a real size, in a real viewport.
 *
 * The temptation is to draw a phone as a 390px-wide `div` and scale it. That looks right and is a
 * lie: a media query asks the *viewport*, not the box, so every `@media (max-width: 480px)` rule in
 * this system stays switched off and the mockup shows a desktop layout in a phone-shaped hole. The
 * one thing in a browser that has its own viewport is an iframe, so that is what a frame is here.
 *
 * The screen inside is not a copy. The parent's stylesheets are cloned in and the real component
 * tree is portalled into the iframe's body, so what you are looking at is the same React and the
 * same CSS the product ships — 1:1 because it is the same thing, not because somebody kept two
 * drawings in step.
 *
 * **Touch is emulated, and that is worth knowing.** An iframe inherits the host's pointer, so on a
 * desktop `@media (pointer: coarse)` never matches however narrow the frame is — and this system
 * keeps a whole touch layer behind exactly that query. So the frame reads those rules back out of
 * the real stylesheets and re-applies them with the pointer clause removed, leaving any width
 * clause intact. It is derived from the shipped CSS rather than written twice, which is the only
 * version of this worth having.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface DeviceSpec {
  id: string;
  label: string;
  width: number;
  height: number;
  /** Whether the touch layer should be emulated inside this frame. */
  touch: boolean;
  note?: string;
}

/** The sizes worth keeping an eye on, and why each one is on the list. */
export const DEVICES: readonly DeviceSpec[] = [
  { id: 'small-phone', label: 'Small phone', width: 320, height: 568, touch: true, note: 'The narrowest screen still in use. If anything is going to overflow, it overflows here.' },
  { id: 'phone', label: 'Phone', width: 390, height: 844, touch: true, note: 'What most people are holding.' },
  { id: 'tablet', label: 'Tablet', width: 768, height: 1024, touch: true, note: 'Touch, but wide enough that the phone layout would look empty.' },
  { id: 'laptop', label: 'Laptop', width: 1280, height: 800, touch: false, note: 'The density the window skin was drawn for.' },
  { id: 'desktop', label: 'Desktop', width: 1680, height: 1050, touch: false, note: 'Where a layout that only stretches starts to look thin.' },
];

export interface FitReport {
  /** How far the document scrolls past its own viewport. Anything above zero is something cut off. */
  overflowPx: number;
  smallestTextPx: number;
  smallestTargetPx: number;
  /** What is failing, in the words a person would use, worst first. */
  offenders: string[];
}

export const EMPTY_FIT: FitReport = { overflowPx: 0, smallestTextPx: Infinity, smallestTargetPx: Infinity, offenders: [] };

/**
 * Pull the touch layer out of the real stylesheets.
 *
 * A rule guarded by `(pointer: coarse) and (max-width: 480px)` keeps its width clause and loses the
 * pointer clause; one guarded by `(pointer: coarse)` alone becomes unconditional. Appended last, so
 * it lands in the cascade where the source put it — this system deliberately places its touch
 * overrides at the end of each stylesheet so they win at equal specificity.
 */
export function touchLayerCss(doc: Document): string {
  const out: string[] = [];
  /*
   * `rule instanceof CSSMediaRule` would be wrong here, and quietly: a frame is a second realm with
   * its own copy of every DOM constructor, so a media rule from inside the frame is not an instance
   * of the outer page's `CSSMediaRule` and the check comes back false for every rule. The symptom is
   * an empty touch layer and a phone mockup that silently shows the desktop sizes, which is exactly
   * the failure this whole frame exists to prevent. So the test is made against the rule's own realm.
   */
  const view = doc.defaultView ?? window;
  const MediaRule = view.CSSMediaRule;
  const visit = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if (typeof MediaRule !== 'undefined' && rule instanceof MediaRule) {
        const condition = rule.conditionText;
        if (/pointer\s*:\s*coarse|hover\s*:\s*none/.test(condition)) {
          const rest = condition
            .split(/\s+and\s+/i)
            .filter((clause) => !/pointer\s*:\s*coarse|hover\s*:\s*none/.test(clause))
            .join(' and ')
            .trim();
          const body = Array.from(rule.cssRules)
            .map((inner) => inner.cssText)
            .join('\n');
          out.push(rest ? `@media ${rest} {\n${body}\n}` : body);
        } else {
          visit(rule.cssRules);
        }
      }
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch {
      // A stylesheet from another origin cannot be read. There are none in this build, and a
      // missing touch layer is a worse thing to crash over than to skip.
    }
  }
  return out.join('\n');
}

const INTERACTIVE = 'button, a[href], input, select, textarea, summary, [role="button"], [role="option"], [role="tab"], [tabindex]:not([tabindex="-1"])';

/**
 * What edge is this element allowed to reach?
 *
 * "Sticks out past the right of the page" is only a defect when the page is what decides, and often
 * it is not. Three cases, and the differences between them are the whole value of this check:
 *
 *   **A scroller.** The section strip scrolls sideways on purpose, so a tab at x=540 in a 390px
 *   viewport is reachable rather than lost. Nothing to report; `null` says so.
 *
 *   **A marquee.** Also deliberate, and it announces itself: both marquees in this system fade
 *   their edge with a mask, which is a statement that the text carries on past there. A plain clip
 *   has no mask, so the mask is the signal rather than a class name this file would have to keep in
 *   step with two stylesheets.
 *
 *   **A clip.** A window clips what overflows it, which is exactly why overflowing it is serious:
 *   the content is not off the edge of the screen, it is *gone*, with nothing to scroll to reach
 *   it. That is how the hub's search field went missing at phone width. So the element is measured
 *   against the clipping box rather than waved through, and the page's own edge is only the answer
 *   when nothing in between has claimed it.
 */
function clipEdge(element: Element, root: Element, view: Window): number | null {
  for (let node = element.parentElement; node && node !== root; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (style.overflowX === 'visible') continue;
    if (style.overflowX === 'auto' || style.overflowX === 'scroll') return null;
    const mask = style.maskImage || style.webkitMaskImage;
    if (mask && mask !== 'none') return null;
    return node.getBoundingClientRect().right;
  }
  return root.clientWidth;
}

/**
 * Is this a glyph rather than words?
 *
 * `aria-hidden` text is ornament whose meaning is carried somewhere a person can actually get at —
 * the library's sort triangle is 8px and `aria-hidden`, and the sort it indicates is on the header
 * as `aria-sort`. Holding ornament to a reading size would be the wrong test; an icon is measured by
 * whether you can see it, and a word by whether you can read it.
 *
 * Text inside an `<svg>` is skipped for a duller reason: its `font-size` is in the SVG's own user
 * units, which the viewBox then scales by an arbitrary factor, so the number computed style reports
 * is not a size on screen at all.
 */
function isOrnament(element: Element, root: Element): boolean {
  for (let node: Element | null = element; node && node !== root; node = node.parentElement) {
    if (node.getAttribute('aria-hidden') === 'true') return true;
    if (node.tagName.toLowerCase() === 'svg') return true;
  }
  return false;
}

/**
 * What does not fit.
 *
 * Deliberately measured rather than eyeballed, and measured *inside* the frame where the real
 * viewport is. Two allowances, both of which exist so the report stays worth reading: a transparent
 * `::after` overlay counts towards a tap target, because several controls here keep their drawn size
 * on purpose and take their taps from one; and an element inside its own scroller or clip is not
 * blamed for the page's edge, because its own container is what decides where it ends.
 */
export function measureFit(doc: Document, touch: boolean): FitReport {
  const root = doc.documentElement;
  const minText = touch ? 12 : 10;
  const minTarget = touch ? 44 : 0;
  const offenders: string[] = [];
  let smallestTextPx = Infinity;
  let smallestTargetPx = Infinity;

  const overflowPx = Math.max(0, Math.round(root.scrollWidth - root.clientWidth));
  if (overflowPx > 0) offenders.push(`the page is ${overflowPx}px wider than the screen`);

  const view = doc.defaultView;
  if (!view) return { overflowPx, smallestTextPx, smallestTargetPx, offenders };

  for (const element of Array.from(doc.body.querySelectorAll<HTMLElement>('*'))) {
    const box = element.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    // Entirely off to the left is how this system hides things from sight but not from a screen
    // reader; it is not a layout that went wrong.
    if (box.right <= 0) continue;
    const style = view.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;

    // Text: only leaves, so a wrapper is not blamed for the size of what is inside it.
    const hasOwnText = element.children.length === 0 && (element.textContent ?? '').trim().length > 0;
    if (hasOwnText && !isOrnament(element, root)) {
      const size = parseFloat(style.fontSize);
      if (Number.isFinite(size)) {
        smallestTextPx = Math.min(smallestTextPx, size);
        if (size < minText) offenders.push(`${describe(element)} is ${size.toFixed(0)}px, under the ${minText}px floor`);
      }
    }

    const edge = clipEdge(element, root, view);
    if (edge !== null && box.right > edge + 1) {
      const past = Math.round(box.right - edge);
      offenders.push(edge === root.clientWidth ? `${describe(element)} runs ${past}px past the edge` : `${describe(element)} is cut off ${past}px short of its end`);
    }
  }

  if (minTarget > 0) {
    for (const element of Array.from(doc.body.querySelectorAll<HTMLElement>(INTERACTIVE))) {
      const style = view.getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      /*
       * A checkbox is the 1px transparent input the browser gives you and the label wrapped around
       * it; the label is what a finger lands on, and tapping it is what checks the box. So where a
       * control is inside a label, the label is the target — measuring the input would report every
       * checkbox in the system as 1px, which is true of the input and false of the control.
       */
      const target = element.closest('label') ?? element;
      const box = target.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (view.getComputedStyle(target).opacity === '0') continue;
      const overlay = view.getComputedStyle(target, '::after');
      const reach = Math.max(
        Math.min(box.width, box.height),
        Math.min(parseFloat(overlay.width) || 0, parseFloat(overlay.height) || 0),
      );
      if (!Number.isFinite(reach) || reach <= 0) continue;
      smallestTargetPx = Math.min(smallestTargetPx, reach);
      if (reach < minTarget) offenders.push(`${describe(target as HTMLElement)} is only ${Math.round(reach)}px to hit, under the ${minTarget}px floor`);
    }
  }

  return { overflowPx, smallestTextPx, smallestTargetPx, offenders: [...new Set(offenders)].slice(0, 12) };
}

function describe(element: HTMLElement): string {
  const text = (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);
  const name = element.getAttribute('aria-label') ?? text;
  const className = typeof element.className === 'string' ? element.className.split(/\s+/)[0] : '';
  return name ? `“${name}”` : className ? `.${className}` : element.tagName.toLowerCase();
}

export interface DeviceFrameProps {
  device: DeviceSpec;
  /** Display scale. The viewport stays the device's real width; only the picture is shrunk. */
  scale?: number;
  /** Custom property overrides to apply live, without rebuilding anything. */
  tokens?: Readonly<Record<string, string>>;
  /** The product's own stylesheet, verbatim — including the `body` rules that only make sense here. */
  css?: string;
  onFit?: (report: FitReport) => void;
  /** Bumped by the parent to ask for a fresh measurement; the content itself is not comparable. */
  revision?: number;
  children: ReactNode;
}

/**
 * Undo the styleguide page's own `body`, and nothing else.
 *
 * Every stylesheet on the host is cloned in, which is what makes the frame 1:1 — but that includes
 * the styleguide's own page styling, and inside a frame the body belongs to the product. So exactly
 * the properties `styleguide.css` sets on `html`/`body` are handed back to their defaults, and the
 * product's stylesheet, appended next, sets what it actually sets. Notably absent: `overflow-x:
 * hidden`. Hiding the overflow would have stopped the frame growing a scrollbar and destroyed the
 * only measurement on this page anybody cares about.
 */
const BODY_RESET = 'html,body{margin:0;padding:0;background:none;color:inherit;font:inherit;-webkit-font-smoothing:auto}';

export function DeviceFrame({ device, scale = 1, tokens, css, onFit, revision = 0, children }: DeviceFrameProps) {
  const [mount, setMount] = useState<HTMLElement | null>(null);

  /*
   * A callback ref rather than an effect. The iframe's document exists the moment the element does,
   * and doing this in an effect would mean setting state synchronously inside one — which cascades a
   * render for every frame on the page, and which this project's lint rules refuse for that reason.
   */
  const attach = useCallback((iframe: HTMLIFrameElement | null) => {
    if (!iframe) {
      setMount(null);
      return;
    }
    const doc = iframe.contentDocument;
    if (!doc) return;
    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    doc.close();
    for (const node of Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))) doc.head.appendChild(node.cloneNode(true));
    const reset = doc.createElement('style');
    reset.textContent = BODY_RESET;
    doc.head.appendChild(reset);
    // All three products mount into `<div id="root">`, and all three style it — the hub and the
    // companion give it the window's full height. Portalling straight into `body` would quietly drop
    // those rules and make the frame a worse copy for no reason.
    const root = doc.createElement('div');
    root.id = 'root';
    doc.body.appendChild(root);
    setMount(root);
  }, []);

  /*
   * Tokens and the touch layer are written into the live document rather than baked in at build
   * time, so editing a value repaints every frame at once instead of rebuilding any of them. This
   * touches the DOM and nothing else, which is what an effect is for.
   */
  useEffect(() => {
    if (!mount) return;
    const doc = mount.ownerDocument;
    const entries = Object.entries(tokens ?? {});
    for (const [name, value] of entries) doc.documentElement.style.setProperty(name, value);
    // Removed on the way out, not just overwritten: resetting one property in the editor has to put
    // the frame back to the stylesheet's value, and a property left set would never go back.
    return () => {
      for (const [name] of entries) doc.documentElement.style.removeProperty(name);
    };
  }, [mount, tokens]);

  /*
   * The product's own stylesheet, after everything cloned from the host. This is where `body` gets
   * the background and the height rules it has in the real app, and where the product-specific
   * classes come from — `now-playing.css` is the library's, not the player's.
   */
  useEffect(() => {
    if (!mount) return;
    const doc = mount.ownerDocument;
    const id = 'np-product-css';
    doc.getElementById(id)?.remove();
    if (!css) return;
    const style = doc.createElement('style');
    style.id = id;
    style.textContent = css;
    doc.head.appendChild(style);
  }, [mount, css]);

  /*
   * Read out of *this* document rather than the host's, so the product stylesheet appended above
   * contributes its own touch rules. Declared after that effect, and depending on the same input, so
   * it is re-appended last whenever the layer beneath it changes — the whole point of this system's
   * touch overrides is that they come last.
   */
  useEffect(() => {
    if (!mount) return;
    const doc = mount.ownerDocument;
    const id = 'np-touch-layer';
    doc.getElementById(id)?.remove();
    if (!device.touch) return;
    const style = doc.createElement('style');
    style.id = id;
    style.textContent = touchLayerCss(doc);
    doc.head.appendChild(style);
  }, [mount, device.touch, css]);

  /*
   * Measured after two frames rather than on load: the iframe's `load` fires for the blank document
   * written above, long before the portal has put anything in it. Two frames is one for the portal
   * to commit and one for layout to settle, and the call lands in a callback rather than in the
   * effect body, which keeps it out of the render that scheduled it.
   */
  useEffect(() => {
    if (!mount || !onFit) return;
    const view = mount.ownerDocument.defaultView ?? window;
    let second = 0;
    const first = view.requestAnimationFrame(() => {
      second = view.requestAnimationFrame(() => onFit(measureFit(mount.ownerDocument, device.touch)));
    });
    return () => {
      view.cancelAnimationFrame(first);
      if (second) view.cancelAnimationFrame(second);
    };
  }, [mount, onFit, device.touch, tokens, css, revision]);

  return (
    <div className="sg-frame" style={{ width: device.width * scale, height: device.height * scale }}>
      <iframe
        ref={attach}
        title={`${device.label}, ${device.width} by ${device.height}`}
        className="sg-frame__glass"
        style={{ width: device.width, height: device.height, transform: `scale(${scale})`, transformOrigin: 'top left' }}
      />
      {mount ? createPortal(children, mount) : null}
    </div>
  );
}
