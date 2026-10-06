/**
 * Reading one state of a running app out of the page: its markup, as the DOM holds it right now.
 *
 * `snapshotInPage` runs inside the page (it is passed to `page.evaluate`, so it may use nothing from
 * this module's scope). It walks the live DOM and returns a plain tree that `format.mjs` prints:
 *
 * - every element with its attributes, in DOM order, and what the user has set on form controls
 *   (a typed value, a ticked box, a chosen option) written back as attributes, so the state shows;
 * - for each element, how whitespace around and inside it renders (from its computed display,
 *   position, float and white-space), so the printer can indent without moving a pixel;
 * - a display:none element is kept (selectors such as :nth-child still count it) but its contents
 *   are left out — they are on screen in the state where they show. SVG, and anything something
 *   else points at by id (a gradient, a symbol), is kept whole;
 * - scripts and comments are dropped (the mockup runs none of the app's code); `blob:` images are
 *   turned into `data:` URIs; anything that would reach the network loses its address;
 * - canvases are listed so their pictures can be taken.
 */

export function snapshotInPage(options) {
  var markLinks = options.links || [];
  var go = new Map();
  for (var i = 0; i < markLinks.length; i += 1) {
    var attr = markLinks[i].on === 'contextmenu' ? 'data-mock-context' : 'data-mock-go';
    var found = Array.prototype.slice.call(document.querySelectorAll(markLinks[i].selector));
    if (markLinks[i].text) found = found.filter(function (el) { return (el.textContent || '').indexOf(markLinks[i].text) >= 0; });
    for (var j = 0; j < found.length; j += 1) {
      var marks = go.get(found[j]) || {};
      if (!marks[attr]) marks[attr] = markLinks[i].to;
      go.set(found[j], marks);
    }
  }

  var referenced = new Set();
  var addRefs = function (text) {
    var re = /url\(\s*['"]?#([^'")\s]+)/g;
    var m;
    while ((m = re.exec(text))) referenced.add(m[1]);
  };
  document.querySelectorAll('style').forEach(function (s) {
    addRefs(s.textContent || '');
  });
  document.querySelectorAll('*').forEach(function (el) {
    for (var k = 0; k < el.attributes.length; k += 1) {
      var a = el.attributes[k];
      if ((a.name === 'href' || a.name === 'xlink:href') && a.value.charAt(0) === '#') referenced.add(a.value.slice(1));
      else if (a.value.indexOf('url(') >= 0) addRefs(a.value);
    }
  });
  var holdsReference = function (el) {
    if (!referenced.size) return false;
    if (el.id && referenced.has(el.id)) return true;
    var inner = el.querySelectorAll('[id]');
    for (var n = 0; n < inner.length; n += 1) if (referenced.has(inner[n].id)) return true;
    return false;
  };

  var BLOCK = /^(block|list-item|table|flex|grid|flow-root|table-.*|-webkit-box|ruby-base-container|ruby-text-container)$/;
  var SKIP_TAGS = { SCRIPT: 1, NOSCRIPT: 1 };
  var netUrl = /^(?:https?:)?\/\//i;
  var canvases = [];

  function flowOf(el, cs) {
    if (cs.display === 'none') return 'S';
    if (cs.position === 'absolute' || cs.position === 'fixed' || (cs.float && cs.float !== 'none')) return 'S';
    if (cs.display === 'contents') return 'I';
    return BLOCK.test(cs.display) ? 'B' : 'I';
  }
  function modeOf(el, cs) {
    if (/^(pre|pre-wrap|pre-line|break-spaces)$/.test(cs.whiteSpace) || cs.whiteSpaceCollapse === 'preserve' || cs.whiteSpaceCollapse === 'break-spaces') return 'P';
    if (/(^|-)(flex|grid)$/.test(cs.display) || cs.display === '-webkit-box' || cs.display === '-webkit-inline-box') return 'F';
    if (cs.display === 'inline' || cs.display === 'contents' || /^ruby/.test(cs.display)) return 'L';
    return 'N';
  }

  function attrs(el) {
    var out = [];
    var tag = el.tagName;
    for (var k = 0; k < el.attributes.length; k += 1) {
      var a = el.attributes[k];
      var v = a.value;
      if ((a.name === 'src' || a.name === 'poster' || a.name === 'srcset' || a.name === 'data') && (netUrl.test(v) || /^blob:/.test(v))) {
        if (/^blob:/.test(v) && options.blobs && options.blobs[v]) v = options.blobs[v];
        else continue;
      }
      if ((tag === 'VIDEO' || tag === 'AUDIO' || tag === 'SOURCE') && a.name === 'src') continue;
      if (tag === 'LINK' && a.name === 'href' && netUrl.test(v)) continue;
      if (a.name === 'style' && /url\(\s*['"]?(blob:|https?:)/i.test(v)) v = v.replace(/url\(\s*(['"]?)(blob:[^'")]+)\1\s*\)/gi, function (all, q, b) { return options.blobs && options.blobs[b] ? 'url("' + options.blobs[b] + '")' : 'none'; }).replace(/url\(\s*['"]?https?:[^)]*\)/gi, 'none');
      if (tag === 'INPUT' && (a.name === 'value' || a.name === 'checked')) continue;
      if (tag === 'OPTION' && a.name === 'selected') continue;
      out.push([a.name, v]);
    }
    if (tag === 'INPUT') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        if (el.checked) out.push(['checked', '']);
        if (el.hasAttribute('value')) out.push(['value', el.getAttribute('value')]);
      } else if (type !== 'file' && type !== 'password' && el.value !== '') {
        out.push(['value', el.value]);
      } else if (type === 'password' && el.value !== '') {
        out.push(['value', el.value.replace(/./g, 'x')]);
      }
    }
    if (tag === 'OPTION' && el.selected) out.push(['selected', '']);
    // Scrolled by the app or the walk-through: the navigator scrolls it back there.
    if (el.scrollTop > 0 && el !== document.documentElement && el !== document.body) out.push(['data-mock-scroll-top', String(Math.round(el.scrollTop))]);
    // Shown in the top layer by script (showModal, showPopover): the navigator does the same.
    try {
      if (tag === 'DIALOG' && el.matches(':modal')) out.push(['data-mock-modal', '']);
      if (el.hasAttribute('popover') && el.matches(':popover-open')) out.push(['data-mock-popover-open', '']);
    } catch {
      // an older engine without :modal or :popover-open
    }
    if (go.has(el)) {
      var m = go.get(el);
      if (m['data-mock-go']) out.push(['data-mock-go', m['data-mock-go']]);
      if (m['data-mock-context']) out.push(['data-mock-context', m['data-mock-context']]);
    }
    return out;
  }

  function walk(node, inSvg) {
    if (node.nodeType === 3) return node.data;
    if (node.nodeType !== 1) return null;
    var el = node;
    if (SKIP_TAGS[el.tagName]) return null;
    if (el.tagName === 'LINK' && /stylesheet|preload|modulepreload|manifest|icon/i.test(el.getAttribute('rel') || '')) return null;
    var svg = inSvg || el.namespaceURI === 'http://www.w3.org/2000/svg';
    var cs = getComputedStyle(el);
    var name = svg ? el.localName : el.tagName.toLowerCase();
    var out = { e: name, a: attrs(el), f: svg ? 'B' : flowOf(el, cs), m: svg ? (name === 'text' || name === 'tspan' || name === 'textPath' ? 'P' : 'F') : modeOf(el, cs), c: [] };
    if (svg) out.s = 1;
    if (el.namespaceURI === 'http://www.w3.org/1998/Math/MathML') out.m = 'P';
    if (name === 'canvas') {
      var r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none') {
        out.pic = canvases.length;
        canvases.push(canvases.length);
        el.setAttribute('data-mock-picture-at', String(out.pic));
      }
      return out;
    }
    if (name === 'style') {
      out.raw = el.textContent || '';
      return out;
    }
    if (name === 'textarea') {
      out.raw = el.value;
      out.m = 'P';
      return out;
    }
    if (name === 'template') return out;
    if (!svg && cs.display === 'none' && !holdsReference(el) && !el.querySelector('svg symbol, svg defs')) {
      out.pruned = true;
      return out;
    }
    for (var c = el.firstChild; c; c = c.nextSibling) {
      var w = walk(c, svg);
      if (w === null) continue;
      var last = out.c[out.c.length - 1];
      if (typeof w === 'string' && typeof last === 'string') out.c[out.c.length - 1] = last + w;
      else out.c.push(w);
    }
    return out;
  }

  var list = function (el) {
    var o = [];
    for (var k = 0; k < el.attributes.length; k += 1) o.push([el.attributes[k].name, el.attributes[k].value]);
    return o;
  };
  var body = walk(document.body, false);
  var styles = [];
  document.querySelectorAll('style').forEach(function (s) {
    if (!s.closest('body')) styles.push({ attrs: list(s), text: s.textContent || '' });
  });
  return { html: list(document.documentElement), body: body, styles: styles, pictures: canvases.length, title: document.title };
}

/** Every `blob:` address the page shows, read back as `data:` URIs (artwork from IndexedDB, avatars). */
export async function readBlobs(page) {
  return page.evaluate(async () => {
    const urls = new Set();
    for (const el of document.querySelectorAll('[src^="blob:"], [poster^="blob:"]')) urls.add(el.getAttribute('src') ?? el.getAttribute('poster'));
    for (const el of document.querySelectorAll('[style*="blob:"]')) for (const m of el.getAttribute('style').matchAll(/blob:[^'")\s]+/g)) urls.add(m[0]);
    const out = {};
    for (const url of urls) {
      try {
        const blob = await (await fetch(url)).blob();
        if (/^(video|audio)\//.test(blob.type)) continue;
        out[url] = await new Promise((done) => {
          const reader = new FileReader();
          reader.onload = () => done(String(reader.result));
          reader.readAsDataURL(blob);
        });
      } catch {
        // gone already
      }
    }
    return out;
  });
}

/**
 * The pictures of the canvases a snapshot found, as PNG `data:` URIs. Only the canvas is drawn for
 * the photograph (everything else is made invisible, which moves nothing), so the overlays over
 * a canvas are not baked into its picture.
 */
export async function photographCanvases(page, count) {
  const shots = [];
  if (!count) return shots;
  const handle = await page.addStyleTag({ content: '* { visibility: hidden !important; transition: none !important; } canvas[data-mock-picture-at] { visibility: visible !important; }' });
  // Straight through the DevTools protocol: Playwright's own screenshot waits for an animation
  // frame, and the page's frames are held by the installed clock.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  try {
    for (let i = 0; i < count; i += 1) {
      try {
        const box = await page.evaluate((at) => {
          const r = document.querySelector(`canvas[data-mock-picture-at="${at}"]`).getBoundingClientRect();
          return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
        }, i);
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 }, captureBeyondViewport: false });
        shots.push(`data:image/png;base64,${data}`);
      } catch (error) {
        console.warn(`    no picture of canvas ${i}: ${String(error).split('\n')[0]}`);
        shots.push(null);
      }
    }
  } finally {
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', {}).catch(() => undefined);
    await cdp.detach().catch(() => undefined);
    await handle.evaluate((node) => node.remove());
    await page.evaluate(() => document.querySelectorAll('[data-mock-picture-at]').forEach((el) => el.removeAttribute('data-mock-picture-at')));
  }
  return shots;
}
