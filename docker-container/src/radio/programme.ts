import type { SafeHttpClient } from '../providers/http.js';

const BBC_SCHEDULE_HOST = 'ess.api.bbci.co.uk';
const BBC_STREAM_HOST = 'stream.live.vc.bbcmedia.co.uk';
const BBC_SERVICES = new Set([
  'bbc_radio_one', 'bbc_radio_two', 'bbc_radio_three', 'bbc_radio_fourfm', 'bbc_radio_fourlw',
  'bbc_radio_five_live', 'bbc_6music', 'bbc_1xtra',
  'bbc_radio_four_extra', 'bbc_asian_network', 'bbc_world_service',
]);

/** Only a known BBC stream path can select a service; never fetch the listener's URL as a schedule. */
export async function readCurrentProgramme(stream: string, http: SafeHttpClient, now: number): Promise<string | null> {
  let url: URL;
  try { url = new URL(stream); } catch { return null; }
  const serviceId = url.pathname.slice(1);
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== BBC_STREAM_HOST ||
      url.username || url.password || url.port || !BBC_SERVICES.has(serviceId)) return null;
  try {
    const schedule = await http.getJson<{
      service?: { id?: unknown };
      items?: Array<{ service?: { id?: unknown }; brand?: { title?: unknown }; episode?: { title?: unknown }; published_time?: { start?: unknown; end?: unknown } }>;
    }>(`https://${BBC_SCHEDULE_HOST}/schedules?serviceId=${serviceId}`, {
      allowedHosts: [BBC_SCHEDULE_HOST], allowedSchemes: ['https:'], maxRedirects: 0,
      timeoutMs: 3000, maxBytes: 300_000,
    });
    if (schedule.service?.id !== serviceId || !Array.isArray(schedule.items)) return null;
    for (const item of schedule.items) {
      if (item.service?.id !== serviceId) continue;
      const start = typeof item.published_time?.start === 'string' ? Date.parse(item.published_time.start) : NaN;
      const end = typeof item.published_time?.end === 'string' ? Date.parse(item.published_time.end) : NaN;
      if (!(start <= now && now < end)) continue;
      for (const title of [item.brand?.title, item.episode?.title]) {
        if (typeof title === 'string' && title.trim().length > 0 && title.trim().length <= 300) return title.trim();
      }
      return null;
    }
  } catch { /* A schedule failure must never erase the station's ICY answer. */ }
  return null;
}
