/**
 * Printing a snapshot (`capture.mjs`) as readable, stable HTML.
 *
 * One element per line, two spaces per level — but only where a line break cannot change what is
 * drawn. Whitespace renders as a space only between two pieces of inline content on the same line,
 * so the printer breaks a line:
 *
 * - anywhere inside a flex or grid container (whitespace there is never drawn),
 * - wherever the page already had whitespace (a newline and a space render the same),
 * - next to block-level boxes, and at the edges of a block container (where a space would be
 *   trimmed from the line),
 *
 * and nowhere else: two inline buttons that touch stay touching. Text inside elements whose
 * white-space preserves it is printed exactly as it is; other text has runs of whitespace written
 * as one space, which is how the browser draws them anyway.
 */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const INDENT = '  ';

export const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;');
export const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\u00a0/g, '&nbsp;');

export function printAttrs(list) {
  return list.map(([name, value]) => (value === '' ? ` ${name}` : ` ${name}="${escapeAttr(value)}"`)).join('');
}

function openTag(node) {
  const list = node.pic === undefined ? node.a : [...node.a, ['data-mock-picture', String(node.pic)]];
  return `<${node.e}${printAttrs(list)}`;
}

/** Everything verbatim on one line: white-space that preserves, or content nobody may reflow. */
function verbatim(node) {
  if (typeof node === 'string') return escapeText(node);
  if (node.raw !== undefined) return `${openTag(node)}>${node.e === 'style' ? node.raw : escapeText(node.raw)}</${node.e}>`;
  if (VOID.has(node.e)) return `${openTag(node)}>`;
  return `${openTag(node)}>${node.c.map(verbatim).join('')}</${node.e}>`;
}

const isWs = (s) => /^[ \t\n\r\f]*$/.test(s);

/**
 * Children as items with the whitespace between them lifted out into boundaries:
 * `items[i]` sits between `gaps[i]` and `gaps[i + 1]`; a gap is true when the page had whitespace there.
 */
function lift(children, mode) {
  const items = [];
  const gaps = [false];
  for (const child of children) {
    if (typeof child === 'string') {
      if (isWs(child)) {
        if (child.length) gaps[gaps.length - 1] = true;
        continue;
      }
      let text = child;
      if (mode !== 'P') {
        if (/^[ \t\n\r\f]/.test(text)) gaps[gaps.length - 1] = true;
        const trailing = /[ \t\n\r\f]$/.test(text);
        text = text.replace(/[ \t\n\r\f]+/g, ' ').trim();
        items.push(text);
        gaps.push(trailing);
        continue;
      }
      items.push(text);
      gaps.push(false);
      continue;
    }
    items.push(child);
    gaps.push(false);
  }
  return { items, gaps };
}

const flow = (item) => (typeof item === 'string' ? 'I' : item.f);

export function printNode(node, depth) {
  if (typeof node === 'string') return escapeText(node);
  if (node.raw !== undefined || node.m === 'P') return verbatim(node);
  const open = openTag(node);
  if (VOID.has(node.e)) return `${open}>`;
  if (!node.c.length) return node.s && node.e !== 'svg' ? `${open} />` : `${open}></${node.e}>`;
  return `${open}>${printInner(node, depth)}</${node.e}>`;
}

/** What goes between an element's tags: its children, broken onto lines where that is safe. */
export function printInner(node, depth) {
  const { items, gaps } = lift(node.c, node.m);
  if (!items.length) return '';
  const n = items.length;
  // Is there inline content between gap g and the nearest block box on the left / on the right?
  const contentLeft = (g) => {
    for (let i = g - 1; i >= 0; i -= 1) {
      const f = flow(items[i]);
      if (f === 'B') return false;
      if (f === 'I') return true;
    }
    return false;
  };
  const contentRight = (g) => {
    for (let i = g; i < n; i += 1) {
      const f = flow(items[i]);
      if (f === 'B') return false;
      if (f === 'I') return true;
    }
    return false;
  };
  const breakable = (g) => {
    if (node.m === 'F') return true;
    if (gaps[g]) return true;
    if (node.m === 'L' && (g === 0 || g === n)) return false;
    if (g === 0 || g === n) return true;
    return !(contentLeft(g) && contentRight(g));
  };

  const pad = INDENT.repeat(depth + 1);
  let out = '';
  for (let i = 0; i < n; i += 1) {
    const brk = breakable(i);
    if (brk) out += `\n${pad}`;
    else if (gaps[i]) out += ' ';
    out += printNode(items[i], depth + 1);
  }
  if (breakable(n)) out += `\n${INDENT.repeat(depth)}`;
  else if (gaps[n]) out += ' ';
  return out;
}
