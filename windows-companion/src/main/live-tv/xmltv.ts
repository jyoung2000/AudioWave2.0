/**
 * Reading a programme guide (XMLTV), a piece at a time.
 *
 * A guide for a few thousand channels over a week is hundreds of megabytes of XML. Nothing here
 * holds the document: text is fed in as it arrives, each finished `<channel>` or `<programme>`
 * element is handed to the caller and forgotten, and the only thing kept between pieces is the
 * element still being received — capped, so one malformed element cannot grow without limit.
 *
 * This is not a general XML parser and does not try to be. XMLTV's two elements are flat, their
 * children are text, and that is all it reads: attributes on the element, `display-name` and `icon`
 * in a channel, `title` and `desc` in a programme. Everything else in the file passes through
 * unread.
 */

export interface XmltvChannel {
  id: string;
  name: string | null;
  icon: string | null;
}

export interface XmltvProgramme {
  channel: string;
  startMs: number;
  stopMs: number;
  title: string;
  description: string | null;
}

export interface XmltvHandlers {
  channel?: (channel: XmltvChannel) => void;
  programme?: (programme: XmltvProgramme) => void;
}

/** The longest single element kept while waiting for its end. Real ones are a few hundred bytes. */
const MAX_ELEMENT_CHARS = 256 * 1024;
/** How far into the file `<tv>` must appear for this to be called XMLTV. */
const ROOT_WINDOW_CHARS = 64 * 1024;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXmlText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_all, inner: string) => inner.replace(/&/g, '&amp;').replace(/</g, '&lt;'))
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (all, name: string) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      }
      return ENTITIES[name] ?? all;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A channel's name as two lists can agree on it, for matching a playlist channel that has no
 * `tvg-id` to the guide's channel of the same name: case, accents, punctuation and spacing are
 * dropped, and so are the labels IPTV lists add to the same channel — a country prefix (`UK:`,
 * `US |`) and a picture-quality suffix (HD, FHD, UHD, 4K, SD). What makes two channels different
 * stays: `BBC One` and `BBC One +1` do not match. Returns '' for a name with nothing left.
 */
export function normalizeChannelName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^\s*[a-z]{2,3}\s*[:|]\s*/, '')
    .replace(/[([]\s*(?:hd|fhd|uhd|sd|4k|hevc|h\.?265)\s*[)\]]/g, ' ')
    .replace(/(?:\s+(?:hd|fhd|uhd|sd|4k|hevc|h\.?265))+\s*$/, '')
    .replace(/\+/g, ' plus ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * XMLTV time: `YYYYMMDDhhmmss ±hhmm`, with the seconds, the minutes and the offset each optional.
 * No offset means UTC, as the format says. Returns null for anything that is not a date.
 */
export function parseXmltvTime(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^\s*(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*(?:([+-])(\d{2}):?(\d{2}))?\s*$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, sign, oh, om] = match;
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0));
  if (!Number.isFinite(utc)) return null;
  const offsetMs = sign ? (Number(oh) * 60 + Number(om)) * 60_000 * (sign === '-' ? -1 : 1) : 0;
  return utc - offsetMs;
}

function attributes(openTag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of openTag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[match[1]!] = decodeXmlText(match[2] ?? match[3] ?? '');
  return out;
}

function childText(body: string, name: string): string | null {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(body);
  if (!match) return null;
  const text = decodeXmlText(match[1]!);
  return text || null;
}

export class XmltvScanner {
  private buffer = '';
  private seen = 0;
  /** Whether a `<tv>` root appeared near the top: what makes this an XMLTV file at all. */
  sawRoot = false;
  channels = 0;
  programmes = 0;

  constructor(private readonly handlers: XmltvHandlers) {}

  write(text: string): void {
    if (!this.sawRoot && this.seen < ROOT_WINDOW_CHARS) {
      // Checked on the joined text so a root split across two pieces is still found.
      if (/<tv[\s>]/.test(this.buffer.slice(-8) + text)) this.sawRoot = true;
    }
    this.seen += text.length;
    this.buffer += text;
    this.drain(false);
  }

  end(): void {
    this.drain(true);
    this.buffer = '';
  }

  private drain(final: boolean): void {
    let buffer = this.buffer;
    let from = 0;
    for (;;) {
      const start = nextElement(buffer, from);
      if (!start) {
        // Nothing left to read: keep only a tail short enough to hold a tag name cut in two.
        buffer = final ? '' : buffer.slice(Math.max(from, buffer.length - 16));
        break;
      }
      const consumedTo = this.readElement(buffer, start);
      if (consumedTo >= 0) {
        from = consumedTo;
        continue;
      }
      // The element's end has not arrived.
      if (final) {
        buffer = '';
        break;
      }
      if (buffer.length - start.index > MAX_ELEMENT_CHARS) {
        // Longer than any real one: step past its opening so the rest of the file is still read.
        from = start.index + 1;
        continue;
      }
      buffer = buffer.slice(start.index);
      break;
    }
    this.buffer = buffer;
  }

  /** Emits one whole element and returns where it ends, or -1 when its end is not in the buffer yet. */
  private readElement(buffer: string, start: { index: number; name: 'channel' | 'programme' }): number {
    const openEnd = buffer.indexOf('>', start.index);
    if (openEnd < 0) return -1;
    const openTag = buffer.slice(start.index, openEnd + 1);
    if (openTag.endsWith('/>')) {
      this.emit(start.name, openTag, '');
      return openEnd + 1;
    }
    const close = `</${start.name}>`;
    const closeAt = buffer.indexOf(close, openEnd + 1);
    if (closeAt < 0) return -1;
    this.emit(start.name, openTag, buffer.slice(openEnd + 1, closeAt));
    return closeAt + close.length;
  }

  private emit(name: 'channel' | 'programme', openTag: string, body: string): void {
    const attrs = attributes(openTag);
    if (name === 'channel') {
      const id = attrs['id']?.trim();
      if (!id) return;
      this.channels += 1;
      const icon = /<icon\s[^>]*>/.exec(body);
      this.handlers.channel?.({ id: id.slice(0, 200), name: childText(body, 'display-name')?.slice(0, 200) ?? null, icon: icon ? (attributes(icon[0])['src'] ?? null) : null });
      return;
    }
    const channel = attrs['channel']?.trim();
    const startMs = parseXmltvTime(attrs['start']);
    const stopMs = parseXmltvTime(attrs['stop']);
    const title = childText(body, 'title');
    // A programme with no end, no channel or no name cannot be shown as now or next.
    if (!channel || startMs === null || stopMs === null || stopMs <= startMs || !title) return;
    this.programmes += 1;
    this.handlers.programme?.({ channel: channel.slice(0, 200), startMs, stopMs, title: title.slice(0, 300), description: childText(body, 'desc')?.slice(0, 600) ?? null });
  }
}

/** The next `<channel` or `<programme` that is really that element, not a longer name. */
function nextElement(buffer: string, from: number): { index: number; name: 'channel' | 'programme' } | null {
  const pattern = /<(channel|programme)(?=[\s>/])/g;
  pattern.lastIndex = from;
  const match = pattern.exec(buffer);
  return match ? { index: match.index, name: match[1] as 'channel' | 'programme' } : null;
}
