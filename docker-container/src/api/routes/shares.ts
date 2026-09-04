/**
 * Shareable links, including the public HTML page a recipient opens.
 *
 * Everything a stranger can reach lives here: `/api/v1/shares/resolve/:token`,
 * `/api/v1/shares/stream/:token/:trackId` and the page at `/s/:token`. All three are rate-limited
 * as search traffic, none of them require or accept a session, and none of them reveal whether a
 * token merely expired or never existed.
 *
 * The page is rendered server-side with a per-response CSP nonce and no external requests at all —
 * no CDN font, no analytics, no remote image. Everything a visitor loads comes from this hub.
 */
import type { FastifyInstance } from 'fastify';
import type { SharePayload } from '@now-playing/contracts';
import { routes } from '@now-playing/contracts';
import { DomainError } from '@now-playing/domain';
import type { HubContext } from '../../context.js';
import { actorDisplayName, actorId } from '../../auth/principal.js';
import { escapeHtml } from '../../util.js';
import { RAW, registerRoute } from '../register.js';

export function registerShareRoutes(app: FastifyInstance, ctx: HubContext): void {
  registerRoute(app, ctx, routes.sharesCreate, ({ body, principal, ip, userAgent, correlationId, reply }) => {
    const result = ctx.shares.create(
      {
        kind: body.kind,
        targetId: body.targetId,
        title: body.title,
        allowStream: body.allowStream,
        allowDownload: body.allowDownload,
        expiresInSeconds: body.expiresInSeconds,
        maxAccesses: body.maxAccesses,
        ...(body.items ? { items: body.items } : {}),
      },
      { id: actorId(principal), displayName: actorDisplayName(principal) },
      { ip, userAgent, correlationId },
    );
    reply.status(201);
    // The token is in this response and nowhere else — the hub stores only its hash.
    return result;
  });

  registerRoute(app, ctx, routes.sharesList, ({ principal }) => ({ items: ctx.shares.list(principal.kind === 'admin' ? undefined : actorId(principal)) }));

  registerRoute(app, ctx, routes.sharesRevoke, ({ params, principal, ip, userAgent, correlationId }) => {
    ctx.shares.revoke(params.shareId, { id: actorId(principal), displayName: actorDisplayName(principal), isAdmin: principal.kind === 'admin' }, { ip, userAgent, correlationId });
    return { ok: true as const };
  });

  registerRoute(app, ctx, routes.shareResolve, ({ params, baseUrl }) => ctx.shares.resolve(params.token, baseUrl).payload);

  registerRoute(app, ctx, routes.shareStream, ({ params, req, reply }) => {
    const { hubTrackId } = ctx.shares.authorizeStream(params.token, params.trackId);
    const stream = ctx.library.openRange(hubTrackId, req.headers.range);
    reply
      .status(req.headers.range ? 206 : 200)
      .header('Content-Type', stream.mime)
      .header('Accept-Ranges', 'bytes')
      .header('Content-Length', String(stream.end - stream.start + 1))
      // A shared stream is not a download: no attachment disposition, and the page offers no save
      // button unless the link's creator enabled downloads on hub-hosted content.
      .header('Content-Disposition', 'inline')
      .header('Cache-Control', 'private, max-age=0, must-revalidate');
    if (req.headers.range) reply.header('Content-Range', `bytes ${stream.start}-${stream.end}/${stream.size}`);
    reply.send(stream.stream);
    return RAW;
  });

  registerRoute(app, ctx, routes.sharePage, ({ params, baseUrl, reply }) => {
    let payload: SharePayload;
    try {
      payload = ctx.shares.resolve(params.token, baseUrl).payload;
    } catch (err) {
      const message = err instanceof DomainError ? err.message : 'That link is not available.';
      const nonce = nonceFor(ctx);
      reply.status(404).header('Content-Type', 'text/html; charset=utf-8').header('Content-Security-Policy', pageCsp(nonce)).send(errorPage(message, nonce));
      return RAW;
    }
    const nonce = nonceFor(ctx);
    reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Content-Security-Policy', pageCsp(nonce))
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Robots-Tag', 'noindex, nofollow')
      .send(sharePage(payload, params.token, nonce));
    return RAW;
  });
}

function nonceFor(ctx: HubContext): string {
  return [...ctx.random.bytes(16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `media-src 'self'` allows the shared audio; everything else is denied outright. */
function pageCsp(nonce: string): string {
  return `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; media-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

const PAGE_STYLE = `
:root{color-scheme:light}
body{margin:0;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Lucida Grande","Segoe UI",sans-serif;background:linear-gradient(#eef1f5,#dfe4ea);color:#1b1b1b;min-height:100vh}
.wrap{max-width:52rem;margin:0 auto;padding:32px 20px 64px}
header{display:flex;gap:16px;align-items:flex-start;margin-bottom:20px}
.art{width:96px;height:96px;border-radius:6px;background:#c9d0d8;border:1px solid #a8b0ba;flex:none;object-fit:cover}
h1{font-size:20px;margin:0 0 4px}
.meta{color:#5a6472;margin:0 0 2px}
.panel{background:#fff;border:1px solid #b9c0c9;border-radius:8px;box-shadow:0 1px 2px rgba(0,0,0,.12);overflow:hidden}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #e6e9ed;vertical-align:middle}
th{background:linear-gradient(#f7f8fa,#e9ecf1);font-weight:600;font-size:12px;color:#41495a}
tr:last-child td{border-bottom:none}
td.num{width:2.5rem;color:#7b8494;text-align:right}
td.dur{width:5rem;color:#5a6472;font-variant-numeric:tabular-nums}
audio{width:100%;margin-top:16px}
.note{color:#7b8494;font-size:12px}
a{color:#1a5fb4}
footer{margin-top:24px;color:#7b8494;font-size:12px}
button{font:inherit;padding:3px 12px;border-radius:12px;border:1px solid #9aa3ae;background:linear-gradient(#fff,#e9ecf1);cursor:pointer}
button[disabled]{opacity:.5;cursor:not-allowed}
`;

function formatDuration(ms: number | null): string {
  if (!ms || ms <= 0) return '—';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function sharePage(payload: SharePayload, token: string, nonce: string): string {
  const rows = payload.items
    .map((item, i) => {
      const action = item.streamable
        ? `<button type="button" data-src="/api/v1/shares/stream/${encodeURIComponent(token)}/${encodeURIComponent(item.trackId)}" data-title="${escapeHtml(item.title)}">Play</button>`
        : item.openAtSourceUrl
          ? `<a href="${escapeHtml(item.openAtSourceUrl)}" rel="noreferrer noopener nofollow">Open at source</a>`
          : `<span class="note">${escapeHtml(item.availabilityNote ?? 'Not available here')}</span>`;
      return `<tr><td class="num">${i + 1}</td><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.artistName)}</td><td>${escapeHtml(item.albumName ?? '')}</td><td class="dur">${formatDuration(item.durationMs)}</td><td>${action}</td></tr>`;
    })
    .join('');

  const streamableCount = payload.items.filter((i) => i.streamable).length;
  const honesty =
    streamableCount === payload.items.length
      ? ''
      : `<p class="note">${payload.items.length - streamableCount} of ${payload.items.length} items are not hosted by this hub, so they cannot be played here — those rows link to the original source instead.</p>`;
  const expiry = payload.expiresAt ? `<p class="note">This link expires on ${escapeHtml(new Date(payload.expiresAt).toUTCString())}.</p>` : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(payload.title)}</title><style nonce="${nonce}">${PAGE_STYLE}</style></head><body><div class="wrap">
<header>${payload.artworkUrl ? `<img class="art" src="${escapeHtml(payload.artworkUrl)}" alt="">` : '<div class="art"></div>'}<div><h1>${escapeHtml(payload.title)}</h1><p class="meta">${escapeHtml(payload.kind)} shared by ${escapeHtml(payload.ownerDisplayName)} · ${payload.totalItems} item${payload.totalItems === 1 ? '' : 's'}</p><p class="meta">${escapeHtml(payload.hubName)}</p></div></header>
<div class="panel"><table><thead><tr><th class="num">#</th><th>Title</th><th>Artist</th><th>Album</th><th>Time</th><th>Play</th></tr></thead><tbody>${rows}</tbody></table></div>
<audio id="player" controls preload="none"></audio>
${honesty}${expiry}
<footer>Served by a self-hosted Now Playing hub. Nothing on this page is loaded from anywhere else.</footer>
</div><script nonce="${nonce}">
(function(){
  var player=document.getElementById('player');
  document.addEventListener('click',function(e){
    var button=e.target.closest('button[data-src]');
    if(!button)return;
    player.src=button.getAttribute('data-src');
    player.play().catch(function(){/* a browser that blocks autoplay still shows the controls */});
    document.title=button.getAttribute('data-title');
  });
})();
</script></body></html>`;
}

function errorPage(message: string, nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Link unavailable</title><style nonce="${nonce}">${PAGE_STYLE}</style></head><body><div class="wrap"><div class="panel" style="padding:24px"><h1>Link unavailable</h1><p>${escapeHtml(message)}</p></div></div></body></html>`;
}
