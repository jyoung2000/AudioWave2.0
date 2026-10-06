/**
 * The living mockup as a file: how it is written, and how it is read back into sections.
 *
 *   <style data-mock-source="path">   one per stylesheet the app wears, copied verbatim from that
 *                                     source file, so a line here is the same line there
 *   <template data-mock-state="id">   one per screen or state, the app's markup as it was drawn
 *   <script data-mock-runtime>        the mockup's own small navigator (not the app's code)
 *   <script data-mock-behaviour>      optional: a small script that makes a captured part respond on
 *                                     stock data (the player's search), its data beside it
 *
 * `sections()` splits a mockup file back into those parts; `pnpm mockups:diff` compares two files
 * section by section.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { escapeAttr, printAttrs, printInner } from './format.mjs';

const RUNTIME = readFileSync(join(import.meta.dirname, 'runtime.js'), 'utf8').replace(/\r\n/g, '\n').trim();
const behaviourScript = (file) => readFileSync(join(import.meta.dirname, '..', 'behaviours', file), 'utf8').replace(/\r\n/g, '\n').trim();

const attrMap = (list) => new Map(list);

/** The attributes of <html> or <body> that differ from the base, as data-mock-<where>-<name>. */
function overrides(where, base, now) {
  const out = [];
  const removed = [];
  const b = attrMap(base);
  const n = attrMap(now);
  for (const [name, value] of n) if (b.get(name) !== value) out.push([`data-mock-${where}-${name}`, value]);
  for (const name of b.keys()) if (!n.has(name)) removed.push(name);
  if (removed.length) out.push([`data-mock-${where}-remove`, removed.join(' ')]);
  return out;
}

/** A style attribute's declarations, one per line, so a long list of properties reads as one. */
function styleAttr(list) {
  return list.map(([name, value]) => {
    if (name !== 'style' || value.length < 120) return [name, value];
    const decls = value.split(/;(?![^(]*\))/).map((d) => d.trim()).filter(Boolean);
    return [name, `\n    ${decls.join(';\n    ')};\n  `];
  });
}

/**
 * @param {object} doc
 * @param {string} doc.app            player | hub | companion
 * @param {string} doc.title          the page title
 * @param {string} doc.banner         the comment at the top, without comment markers
 * @param {string} doc.inputs         the inputs hash (`<meta name="mockup-inputs">`)
 * @param {Array<{source: string, css: string}>} doc.stylesheets
 * @param {Array<{id: string, title: string, group: string, note: string, dismiss?: string, html: string[][], body: object, pictures: Array<string|null>}>} doc.states
 */
export function writeMockup(doc) {
  const [first] = doc.states;
  const baseBody = first.body.a;
  const lines = [];
  lines.push('<!doctype html>');
  lines.push(`<!--\n${doc.banner.trim()}\n-->`);
  lines.push(`<html${printAttrs(styleAttr(first.html))}>`);
  lines.push('<head>');
  lines.push('<meta charset="utf-8">');
  lines.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  lines.push(`<meta name="mockup-of" content="${doc.app}">`);
  lines.push(`<meta name="mockup-inputs" content="${doc.inputs}">`);
  lines.push(`<title>${doc.title}</title>`);
  for (const sheet of doc.stylesheets) {
    const css = sheet.css.replace(/\r\n/g, '\n').replace(/\n+$/, '');
    lines.push(`<style data-mock-source="${escapeAttr(sheet.source)}">\n${css}\n</style>`);
  }
  lines.push('</head>');
  lines.push(`<body${printAttrs(baseBody)}>`);
  for (const state of doc.states) {
    const meta = [
      ['data-mock-state', state.id],
      ['data-mock-title', state.title],
      ['data-mock-group', state.group],
      ...(state.dismiss ? [['data-mock-dismiss', state.dismiss]] : []),
      ...(state.dismissOutside ? [['data-mock-dismiss-outside', state.dismissOutside]] : []),
      ['data-mock-note', state.note],
      ...overrides('html', first.html, state.html),
      ...overrides('body', baseBody, state.body.a),
    ];
    let inner = printInner(state.body, 0);
    const pictures = state.pictures
      .map((uri, i) => (uri ? `[data-mock-picture="${i}"] { background: url("${uri}") 0 0 / 100% 100% no-repeat; }` : null))
      .filter(Boolean);
    if (pictures.length) inner += `<style data-mock-pictures>\n/* Pictures of what the app drew on its canvases in this state (generated; not markup to edit). */\n${pictures.join('\n')}\n</style>\n`;
    lines.push(`<template${printAttrs(meta)}>${inner.replace(/\n$/, '')}\n</template>`);
  }
  lines.push(`<script data-mock-runtime>\n${RUNTIME}\n</script>`);
  for (const b of doc.behaviours || []) {
    const data = JSON.stringify(b.data, null, 1).replace(/<\//g, '<\\/');
    lines.push(`<script type="application/json" data-mock-data="${escapeAttr(b.name)}">\n${data}\n</script>`);
    lines.push(`<script data-mock-behaviour="${escapeAttr(b.name)}">\n${behaviourScript(b.file)}\n</script>`);
  }
  lines.push('</body>');
  lines.push('</html>');
  return `${lines.join('\n')}\n`;
}

/**
 * A mockup file split into named sections, for comparing two of them. Each section's text is
 * compared line by line; `start` is the line in the file where its text begins.
 */
export function sections(text) {
  text = text.replace(/\r\n/g, '\n');
  const out = [];
  const lineAt = (index) => text.slice(0, index).split('\n').length;
  const taken = [];
  for (const m of text.matchAll(/<style data-mock-source="([^"]*)"[^>]*>\n?([\s\S]*?)\n?<\/style>/g)) {
    out.push({ key: `stylesheet ${m[1]}`, kind: 'stylesheet', source: m[1], title: m[1], text: m[2], start: lineAt(m.index + m[0].indexOf('>') + 2) });
    taken.push([m.index, m.index + m[0].length]);
  }
  for (const m of text.matchAll(/<template data-mock-state="([^"]*)"([^>]*)>([\s\S]*?)\n<\/template>/g)) {
    const title = /data-mock-title="([^"]*)"/.exec(m[2])?.[1] ?? m[1];
    const pictures = /<style data-mock-pictures>[\s\S]*?<\/style>/.exec(m[3]);
    const body = pictures ? m[3].replace(pictures[0], '') : m[3];
    // The first line is the template's own attributes (title, note, <body> overrides); the rest is the markup.
    out.push({ key: `state ${m[1]}`, kind: 'state', id: m[1], title, text: `${m[2].trim()}${body}`, pictures: pictures?.[0] ?? '', start: lineAt(m.index) });
    taken.push([m.index, m.index + m[0].length]);
  }
  const runtime = /<script data-mock-runtime>[\s\S]*?<\/script>/.exec(text);
  if (runtime) taken.push([runtime.index, runtime.index + runtime[0].length]);
  // Behaviours and their stock data are the mockup's tooling, not the app's markup.
  for (const m of text.matchAll(/<script (?:type="application\/json" data-mock-data|data-mock-behaviour)="[^"]*">[\s\S]*?<\/script>/g)) {
    taken.push([m.index, m.index + m[0].length]);
  }
  taken.sort((a, b) => a[0] - b[0]);
  let rest = '';
  let at = 0;
  for (const [from, to] of taken) {
    rest += text.slice(at, from);
    at = to;
  }
  rest += text.slice(at);
  out.unshift({ key: 'document', kind: 'document', title: 'the page around the states (head, <html> and <body> attributes)', text: rest.replace(/<meta name="mockup-inputs" content="[^"]*">\n?/, ''), start: 1 });
  return out;
}
