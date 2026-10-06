/**
 * A line diff (Myers' O(ND) algorithm) and unified hunks, without a dependency.
 */

/** The edit script between two arrays of lines: [{ op: ' ' | '-' | '+', line, a, b }]. */
export function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = false;
  for (let d = 0; d <= max && !found; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  // Walk the trace back from the end.
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ op: ' ', line: a[x], a: x, b: y });
    }
    if (d > 0) {
      if (x === prevX) {
        y -= 1;
        ops.push({ op: '+', line: b[y], a: x, b: y });
      } else {
        x -= 1;
        ops.push({ op: '-', line: a[x], a: x, b: y });
      }
    }
  }
  return ops.reverse();
}

/** Group an edit script into hunks with `context` unchanged lines around each change. */
export function hunks(ops, context = 3) {
  const out = [];
  let current = null;
  let lastChange = -Infinity;
  ops.forEach((op, i) => {
    if (op.op === ' ') return;
    if (current && i - lastChange <= context * 2 + 1) {
      current.end = i;
    } else {
      if (current) out.push(current);
      current = { start: i, end: i };
    }
    lastChange = i;
  });
  if (current) out.push(current);
  return out.map(({ start, end }) => {
    const from = Math.max(0, start - context);
    const to = Math.min(ops.length - 1, end + context);
    const lines = ops.slice(from, to + 1);
    const first = lines[0];
    return { aStart: first.a + 1, bStart: first.b + 1, lines, changed: lines.filter((l) => l.op !== ' ') };
  });
}
