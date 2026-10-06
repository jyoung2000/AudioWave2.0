/*
 * The mockup's navigator — this is not the app's code, and none of the app's code runs here.
 *
 * Each <template data-mock-state> above is one screen or state of the real app, as it drew it.
 * This script shows one at a time: it copies the template into <body>, applies the <html> and
 * <body> attributes the state had (data-mock-html-* / data-mock-body-*), and follows the clicks
 * the generator wired up (data-mock-go="<state>", and data-mock-context for a right-click), so tabs, menus and sheets lead where they led in
 * the app. Escape, or a click away from an open menu or sheet, goes back (data-mock-dismiss).
 * Typing, ticking and choosing in form controls work as the browser does them. The panel in the
 * corner lists every state; the address keeps the one on show (#state=<id>).
 */
(function () {
  'use strict';
  var store = new Map();
  var order = [];
  document.querySelectorAll('template[data-mock-state]').forEach(function (t) {
    store.set(t.getAttribute('data-mock-state'), t);
    order.push(t.getAttribute('data-mock-state'));
    t.remove();
  });
  var self = document.currentScript;
  if (self) self.remove();
  var base = {
    html: Array.from(document.documentElement.attributes).map(function (a) { return [a.name, a.value]; }),
    body: Array.from(document.body.attributes).map(function (a) { return [a.name, a.value]; }),
  };
  var current = null;

  function applyAttrs(el, where, list, template) {
    Array.from(el.attributes).forEach(function (a) { el.removeAttribute(a.name); });
    list.forEach(function (a) { el.setAttribute(a[0], a[1]); });
    var prefix = 'data-mock-' + where + '-';
    Array.from(template.attributes).forEach(function (a) {
      if (a.name === prefix + 'remove') a.value.split(' ').forEach(function (n) { el.removeAttribute(n); });
      else if (a.name.indexOf(prefix) === 0) el.setAttribute(a.name.slice(prefix.length), a.value);
    });
  }

  function show(id, fromHash) {
    var t = store.get(id) || store.get(order[0]);
    current = t;
    applyAttrs(document.documentElement, 'html', base.html, t);
    applyAttrs(document.body, 'body', base.body, t);
    document.body.replaceChildren(t.content.cloneNode(true));
    // What the app opened in the top layer (a modal sheet, a popover) is opened the same way here.
    document.body.querySelectorAll('dialog[data-mock-modal]').forEach(function (d) {
      if (d.open) d.close();
      try { d.showModal(); } catch (_e) { d.setAttribute('open', ''); }
    });
    document.body.querySelectorAll('[data-mock-popover-open]').forEach(function (p) {
      try { p.showPopover(); } catch (_e) { /* already open, or no popover support */ }
    });
    document.body.querySelectorAll('[data-mock-scroll-top]').forEach(function (el) {
      el.scrollTop = Number(el.getAttribute('data-mock-scroll-top'));
    });
    var focus = document.body.querySelector('[autofocus]');
    if (focus) focus.focus({ preventScroll: true });
    if (!fromHash) history.replaceState(null, '', '#state=' + t.getAttribute('data-mock-state'));
    panel.update();
  }

  var FORM = 'input, select, textarea, option, label, summary, [contenteditable=""], [contenteditable="true"]';
  document.addEventListener('click', function (event) {
    var target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest('[data-mock-panel]')) return;
    var link = target.closest('[data-mock-go]');
    if (link && store.has(link.getAttribute('data-mock-go'))) {
      event.preventDefault();
      event.stopPropagation();
      show(link.getAttribute('data-mock-go'));
      return;
    }
    if (target.closest('a[href]')) event.preventDefault();
    if (target.closest(FORM)) return;
    var dismiss = current && current.getAttribute('data-mock-dismiss');
    if (!dismiss) return;
    var inside = current.getAttribute('data-mock-dismiss-outside');
    if (inside && target.closest(inside)) return;
    event.preventDefault();
    show(dismiss);
  }, true);
  document.addEventListener('contextmenu', function (event) {
    var target = event.target instanceof Element ? event.target.closest('[data-mock-context]') : null;
    if (!target || !store.has(target.getAttribute('data-mock-context'))) return;
    event.preventDefault();
    show(target.getAttribute('data-mock-context'));
  }, true);
  document.addEventListener('submit', function (event) { event.preventDefault(); }, true);
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || !current) return;
    var dismiss = current.getAttribute('data-mock-dismiss');
    if (dismiss) show(dismiss);
  });
  window.addEventListener('hashchange', function () {
    var m = /#state=([^&]+)/.exec(location.hash);
    if (m && store.has(decodeURIComponent(m[1]))) show(decodeURIComponent(m[1]), true);
  });

  var panel = (function () {
    var host = document.createElement('div');
    host.setAttribute('data-mock-panel', '');
    host.style.cssText = 'all: initial; position: fixed; right: 12px; bottom: 12px; z-index: 2147483647;';
    var root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>' +
      ':host { font: 12px/1.4 -apple-system, "Segoe UI", "Lucida Grande", Helvetica, Arial, sans-serif; color: #222; }' +
      '.bar { display: flex; gap: 4px; align-items: center; background: rgba(250,250,250,.94); border: 1px solid #9a9a9a; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,.25); padding: 3px; opacity: .45; transition: opacity .15s; }' +
      ':host(:hover) .bar, .bar:focus-within, .list:not([hidden]) + .bar { opacity: 1; }' +
      'button { font: inherit; border: 1px solid #aaa; border-radius: 5px; background: linear-gradient(#fff, #e6e6e6); padding: 3px 8px; cursor: pointer; }' +
      'button.title { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }' +
      '.list { position: absolute; right: 0; bottom: 40px; width: 300px; max-height: 70vh; overflow: auto; background: #fff; border: 1px solid #9a9a9a; border-radius: 8px; box-shadow: 0 4px 18px rgba(0,0,0,.3); padding: 6px 0; }' +
      '.list[hidden] { display: none; }' +
      'h4 { margin: 8px 12px 2px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #777; }' +
      'a { display: block; padding: 3px 12px; color: inherit; text-decoration: none; cursor: pointer; }' +
      'a:hover { background: #e8f0fe; } a[aria-current] { background: #3875d7; color: #fff; }' +
      'p { margin: 4px 12px 8px; color: #666; font-size: 11px; }' +
      '</style>' +
      '<div class="list" hidden></div>' +
      '<div class="bar"><button class="prev" title="Previous state">‹</button><button class="title" title="All states"></button><button class="next" title="Next state">›</button></div>';
    var list = root.querySelector('.list');
    var title = root.querySelector('.title');
    title.addEventListener('click', function () { list.hidden = !list.hidden; });
    var step = function (by) {
      var at = order.indexOf(current.getAttribute('data-mock-state'));
      show(order[(at + by + order.length) % order.length]);
    };
    root.querySelector('.prev').addEventListener('click', function () { step(-1); });
    root.querySelector('.next').addEventListener('click', function () { step(1); });
    var group = null;
    order.forEach(function (id) {
      var t = store.get(id);
      if (t.getAttribute('data-mock-group') !== group) {
        group = t.getAttribute('data-mock-group');
        var h = document.createElement('h4');
        h.textContent = group;
        list.appendChild(h);
      }
      var a = document.createElement('a');
      a.textContent = t.getAttribute('data-mock-title');
      a.title = t.getAttribute('data-mock-note') || '';
      a.setAttribute('data-id', id);
      a.addEventListener('click', function () { list.hidden = true; show(id); });
      list.appendChild(a);
    });
    var note = document.createElement('p');
    note.textContent = 'A living mockup: each entry is a state of the real app, regenerated by pnpm mockups:build.';
    list.appendChild(note);
    document.documentElement.appendChild(host);
    return {
      update: function () {
        var id = current.getAttribute('data-mock-state');
        title.textContent = 'Mockup · ' + current.getAttribute('data-mock-title');
        title.title = current.getAttribute('data-mock-note') || '';
        root.querySelectorAll('a').forEach(function (a) {
          if (a.getAttribute('data-id') === id) a.setAttribute('aria-current', 'true');
          else a.removeAttribute('aria-current');
        });
      },
    };
  })();

  window.mockup = { show: show, states: order.slice() };
  var start = /#state=([^&]+)/.exec(location.hash);
  show(start && store.has(decodeURIComponent(start[1])) ? decodeURIComponent(start[1]) : order[0], Boolean(start));
})();
