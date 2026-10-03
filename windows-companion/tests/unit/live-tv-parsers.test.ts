/**
 * The two readers behind the Live TV tab, on text alone: no network, no files.
 *
 * A playlist is a convention more than a format, so what is pinned here is what real playlists
 * carry and what must never count as a channel. The guide reader is fed in awkward pieces on
 * purpose — the whole point of it is that it never needs the document in one piece.
 */
import { describe, expect, it } from 'vitest';
import { channelFromStream, parseM3u } from '../../src/main/live-tv/m3u.js';
import { XmltvScanner, decodeXmlText, normalizeChannelName, parseXmltvTime, type XmltvChannel, type XmltvProgramme } from '../../src/main/live-tv/xmltv.js';

describe('a channel name, as a playlist and a guide can agree on it', () => {
  it('drops case, accents, spacing, punctuation, a country prefix and a quality label', () => {
    for (const name of ['BBC One', 'bbc one', 'UK: BBC One HD', 'US | BBC ONE', 'BBC-One FHD', 'BBC One (HD)', ' BBC  One 4K ']) {
      expect(normalizeChannelName(name), name).toBe('bbcone');
    }
    expect(normalizeChannelName('Télé Québec')).toBe(normalizeChannelName('Tele Quebec'));
    expect(normalizeChannelName('Arts & Culture')).toBe(normalizeChannelName('Arts and Culture'));
  });

  it('keeps what makes two channels different', () => {
    expect(normalizeChannelName('BBC One +1')).not.toBe(normalizeChannelName('BBC One'));
    expect(normalizeChannelName('Channel 4')).not.toBe(normalizeChannelName('Channel 5'));
    expect(normalizeChannelName('HD')).toBe('hd');
    expect(normalizeChannelName('---')).toBe('');
  });
});

const PLAYLIST = [
  '#EXTM3U url-tvg="https://guide.example.com/guide.xml"',
  '#EXTINF:-1 tvg-id="one.example" tvg-name="One HD" tvg-logo="https://img.example.com/one.png" tvg-chno="101" group-title="News, Local",One, the First',
  '#EXTVLCOPT:http-user-agent=Something',
  'https://tv.example.com/one/index.m3u8',
  '#EXTINF:-1,Two',
  '#EXTGRP:Sport',
  'http://tv.example.com/two.ts',
  '#EXTINF:-1 tvg-id="" tvg-logo="javascript:alert(1)",Three',
  'https://tv.example.com/three.m3u8',
  '#EXTINF:-1,Radio over RTMP',
  'rtmp://tv.example.com/live',
  'https://tv.example.com/bare.m3u8',
].join('\r\n');

describe('reading a channel playlist', () => {
  it('reads the name, the stream and the attributes real playlists carry', () => {
    const { kind, channels } = parseM3u(PLAYLIST);
    expect(kind).toBe('channels');
    expect(channels[0]).toEqual({ name: 'One, the First', url: 'https://tv.example.com/one/index.m3u8', tvgId: 'one.example', logo: 'https://img.example.com/one.png', group: 'News, Local', chno: 101 });
    // #EXTGRP names the group when the #EXTINF line did not.
    expect(channels[1]).toEqual({ name: 'Two', url: 'http://tv.example.com/two.ts', tvgId: null, logo: null, group: 'Sport', chno: null });
  });

  it('keeps only what a browser can open: no rtmp stream, no script for a logo, no empty tvg-id', () => {
    const { channels } = parseM3u(PLAYLIST);
    expect(channels.map((c) => c.name)).toEqual(['One, the First', 'Two', 'Three', 'bare']);
    expect(channels[2]).toMatchObject({ tvgId: null, logo: null });
    // A stream with no #EXTINF is still a channel, named after its address.
    expect(channels[3]).toMatchObject({ url: 'https://tv.example.com/bare.m3u8', group: null });
  });

  it('finds no channels in something that is not a playlist', () => {
    expect(parseM3u('<!doctype html><html><body>Not found</body></html>').channels).toEqual([]);
    expect(parseM3u('').channels).toEqual([]);
    expect(parseM3u('#EXTM3U\n#EXTINF:-1,Nothing after me').channels).toEqual([]);
  });

  it('treats an HLS stream as one stream, not as a list of its segments', () => {
    const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nhttps://cdn.example.com/seg-1.ts\n#EXTINF:6.0,\nhttps://cdn.example.com/seg-2.ts\n';
    expect(parseM3u(media)).toEqual({ kind: 'stream', channels: [], truncated: false });
    expect(channelFromStream('https://tv.example.com/live/news.m3u8')).toMatchObject({ name: 'news', url: 'https://tv.example.com/live/news.m3u8' });
  });

  it('stops at the limit and says it did, and survives a byte-order mark', () => {
    const many = '﻿#EXTM3U\n' + Array.from({ length: 5 }, (_, i) => `#EXTINF:-1,Channel ${i}\nhttps://tv.example.com/${i}.m3u8`).join('\n');
    const cut = parseM3u(many, 3);
    expect(cut.channels).toHaveLength(3);
    expect(cut.truncated).toBe(true);
    expect(parseM3u(many).truncated).toBe(false);
  });
});

const GUIDE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="test">
  <channel id="one.example">
    <display-name lang="en">One &amp; Only</display-name>
    <icon src="https://img.example.com/one.png"/>
  </channel>
  <channel id="two.example"><display-name>Two</display-name></channel>
  <programme start="20261003080000 +0000" stop="20261003090000 +0000" channel="one.example">
    <title lang="en">Morning &lt;News&gt;</title>
    <desc lang="en"><![CDATA[Headlines & weather <live>]]></desc>
    <category>News</category>
  </programme>
  <programme start="20261003100000 +0100" stop="20261003103000 +0100" channel="one.example"><title>Weather</title></programme>
  <programme start="20261003090000" channel="two.example"><title>No stop: skipped</title></programme>
  <programme start="20261003090000 +0000" stop="20261003100000 +0000" channel="two.example"></programme>
</tv>`;

function scan(text: string, pieceSize: number): { channels: XmltvChannel[]; programmes: XmltvProgramme[]; scanner: XmltvScanner } {
  const channels: XmltvChannel[] = [];
  const programmes: XmltvProgramme[] = [];
  const scanner = new XmltvScanner({ channel: (c) => channels.push(c), programme: (p) => programmes.push(p) });
  for (let i = 0; i < text.length; i += pieceSize) scanner.write(text.slice(i, i + pieceSize));
  scanner.end();
  return { channels, programmes, scanner };
}

describe('reading a programme guide', () => {
  it('reads channels and programmes, with entities, CDATA and time zones worked out', () => {
    const { channels, programmes, scanner } = scan(GUIDE, GUIDE.length);
    expect(scanner.sawRoot).toBe(true);
    expect(channels).toEqual([
      { id: 'one.example', name: 'One & Only', icon: 'https://img.example.com/one.png' },
      { id: 'two.example', name: 'Two', icon: null },
    ]);
    expect(programmes).toEqual([
      { channel: 'one.example', startMs: Date.UTC(2026, 9, 3, 8), stopMs: Date.UTC(2026, 9, 3, 9), title: 'Morning <News>', description: 'Headlines & weather <live>' },
      // +0100 is an hour ahead of UTC: ten o'clock there is nine here.
      { channel: 'one.example', startMs: Date.UTC(2026, 9, 3, 9), stopMs: Date.UTC(2026, 9, 3, 9, 30), title: 'Weather', description: null },
    ]);
    // A programme with no end, or with no title, cannot be shown as now or next.
    expect(scanner.programmes).toBe(2);
  });

  it('reads the same thing however the text is cut up — one character at a time included', () => {
    const whole = scan(GUIDE, GUIDE.length);
    for (const size of [1, 7, 64, 500]) {
      const pieces = scan(GUIDE, size);
      expect(pieces.channels).toEqual(whole.channels);
      expect(pieces.programmes).toEqual(whole.programmes);
      expect(pieces.scanner.sawRoot).toBe(true);
    }
  });

  it('keeps nothing between pieces but the element it is waiting on', () => {
    const scanner = new XmltvScanner({});
    scanner.write('<tv>');
    for (let i = 0; i < 2_000; i += 1) scanner.write(`<programme start="20261003080000" stop="20261003090000" channel="c${i}"><title>T${i}</title></programme>\n`);
    expect(scanner.programmes).toBe(2_000);
    // Private on purpose; this is the property the reader exists for, so the test looks.
    expect((scanner as unknown as { buffer: string }).buffer.length).toBeLessThan(64);
  });

  it('steps over an element that never ends rather than holding it for ever', () => {
    const programmes: XmltvProgramme[] = [];
    const scanner = new XmltvScanner({ programme: (p) => programmes.push(p) });
    scanner.write('<tv><programme start="20261003080000" stop="20261003090000" channel="broken"><title>');
    const filler = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 6; i += 1) scanner.write(filler);
    expect((scanner as unknown as { buffer: string }).buffer.length).toBeLessThan(300 * 1024);
    scanner.write('<programme start="20261003090000" stop="20261003100000" channel="fine"><title>After</title></programme>');
    scanner.end();
    expect(programmes.map((p) => p.channel)).toContain('fine');
  });

  it('does not call a page of HTML, or an RSS feed with channels in it, a guide', () => {
    expect(scan('<html><body><p>404</p></body></html>', 16).scanner.sawRoot).toBe(false);
    const rss = scan('<rss><channel><title>News</title></channel></rss>', 16);
    expect(rss.scanner.sawRoot).toBe(false);
    expect(rss.channels).toEqual([]);
  });

  it('reads XMLTV times with and without seconds and offsets, and refuses what is not a time', () => {
    expect(parseXmltvTime('20261003080000 +0000')).toBe(Date.UTC(2026, 9, 3, 8));
    expect(parseXmltvTime('20261003080000')).toBe(Date.UTC(2026, 9, 3, 8));
    expect(parseXmltvTime('202610030800')).toBe(Date.UTC(2026, 9, 3, 8));
    expect(parseXmltvTime('20261003080000 -0500')).toBe(Date.UTC(2026, 9, 3, 13));
    expect(parseXmltvTime('20261003080000 +05:30')).toBe(Date.UTC(2026, 9, 3, 2, 30));
    expect(parseXmltvTime('yesterday')).toBeNull();
    expect(parseXmltvTime(undefined)).toBeNull();
  });

  it('decodes numbered entities and drops markup inside text', () => {
    expect(decodeXmlText('Caf&#233; &#x2014; <i>live</i>  &amp;  more')).toBe('Café — live & more');
    expect(decodeXmlText('&unknown; stays')).toBe('&unknown; stays');
  });
});
