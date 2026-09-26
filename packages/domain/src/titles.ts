/**
 * What a video title is trying to say. Uploaders write "Artist - Song (feat. X) [Official Video]";
 * the parts in brackets are about the video, the dash separates artist from song, and features
 * belong to the recording. Every rule here is a regex a person can read, and a title that fits none
 * of them is returned as it was, with artist null — never a guess.
 */
const NOISE = /\s*[[(]\s*(official\s*(music\s*)?(video|audio|lyric\s*video|visuali[sz]er)|lyrics?(\s*video)?|audio|visuali[sz]er|hd|hq|4k|explicit|clean|remaster(ed)?(\s*\d{4})?|prod\.?\s+by[^\])]*|music\s*video|mv|m\/v)\s*[\])]/gi;
const TRAILING_NOISE = /\s+(hd|hq|4k|official\s+video|official\s+audio|lyrics)\s*$/i;
const FEAT_INLINE = /\s*[[(]\s*(?:feat\.?|ft\.?|featuring)\s+([^\])]+)\s*[\])]/i;
const FEAT_TAIL = /\s+(?:feat\.?|ft\.?|featuring)\s+(.+?)\s*$/i;

function splitNames(s: string): string[] {
  return s.split(/\s*(?:,|&|\band\b|\+)\s*/i).map((n) => n.trim()).filter(Boolean);
}

export function splitFeatured(title: string): { title: string; featured: string[] } {
  const m = title.match(FEAT_INLINE) ?? title.match(FEAT_TAIL);
  if (!m) return { title: title.trim(), featured: [] };
  return { title: title.replace(m[0], '').trim(), featured: splitNames(m[1]!) };
}

function unquote(s: string): string {
  return s.replace(/^["“](.+)["”]$/, '$1').trim();
}

export function cleanVideoTitle(input: { title: string; channel: string | null }): { title: string; artist: string | null; featured: string[]; fromTopicChannel: boolean } {
  let raw = input.title.replace(NOISE, ' ').replace(TRAILING_NOISE, '').replace(/\s+/g, ' ').trim();
  const { title: noFeat, featured } = splitFeatured(raw);
  raw = noFeat.replace(TRAILING_NOISE, '').trim();
  const topic = input.channel?.match(/^(.+?)\s+-\s+Topic$/);
  if (topic) return { title: unquote(raw), artist: topic[1]!.trim(), featured, fromTopicChannel: true };
  const dash = raw.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) return { title: unquote(dash[2]!), artist: dash[1]!.trim(), featured, fromTopicChannel: false };
  const quoted = raw.match(/^(.+?)\s+["“](.+)["”]$/);
  if (quoted) return { title: quoted[2]!.trim(), artist: quoted[1]!.trim(), featured, fromTopicChannel: false };
  const pipe = raw.match(/^(.+?)\s+\|\s+(.+)$/);
  if (pipe) return { title: pipe[1]!.trim(), artist: pipe[2]!.trim(), featured, fromTopicChannel: false };
  return { title: raw, artist: null, featured, fromTopicChannel: false };
}
