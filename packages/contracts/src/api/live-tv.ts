/**
 * Live TV kept on the hub.
 *
 * The Windows companion reads M3U playlists and XMLTV guides and serves the result on its local
 * helper (`HelperTvChannel`, `HelperTvGuideEntry`). A player on the same PC reads it there; a player
 * anywhere else cannot reach that loopback helper, so the companion also sends a copy to the hub it
 * is paired with, and the hub hands that copy to its paired players.
 *
 * The hub never fetches anything here: it stores what the companion sent and returns it. That is
 * why the stream and logo addresses are held to plain http(s) links with no user name or password
 * in them — they are opened by players, and a link that carries a sign-in in its address would hand
 * that sign-in to every paired device.
 */
import { z } from 'zod';
import { IsoDateTime, Uuid } from '../common.js';
import { HelperTvChannel, HelperTvGuideEntry } from './local-helper.js';

/** The most channels one companion may keep on the hub. Larger lists are refused, not trimmed. */
export const HUB_LIVE_TV_MAX_CHANNELS = 50_000;
/** At most one guide entry per channel. */
export const HUB_LIVE_TV_MAX_GUIDE = 50_000;
/** The largest upload the hub reads for `PUT /live-tv`, in bytes. */
export const HUB_LIVE_TV_MAX_BYTES = 32 * 1024 * 1024;

/** True for an absolute http(s) address with no user name or password in it. */
export function isPlainWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

const WebUrl = z.string().min(1).max(2048).refine(isPlainWebUrl, { message: 'Use an http or https address with no user name or password in it' });

/** A channel as the hub keeps it: the helper's shape, with its addresses held to plain web links. */
export const HubLiveTvChannel = HelperTvChannel.extend({ url: WebUrl, logo: WebUrl.nullable() });
export type HubLiveTvChannel = z.infer<typeof HubLiveTvChannel>;

/** `PUT /api/v1/live-tv`: what a companion sends. The hub records who sent it and when. */
export const HubLiveTvUpload = z.object({
  channels: z.array(HubLiveTvChannel).max(HUB_LIVE_TV_MAX_CHANNELS),
  guide: z.array(HelperTvGuideEntry).max(HUB_LIVE_TV_MAX_GUIDE),
});
export type HubLiveTvUpload = z.infer<typeof HubLiveTvUpload>;

/** The paired companion the channels came from. */
export const HubLiveTvSource = z.object({ deviceId: Uuid, name: z.string().max(200) });
export type HubLiveTvSource = z.infer<typeof HubLiveTvSource>;

/**
 * `GET /api/v1/live-tv`: the hub's copy. Before any companion has sent one, both lists are empty and
 * `updatedAt` and `sourceDevice` are null.
 */
export const HubLiveTv = z.object({
  channels: z.array(HubLiveTvChannel),
  guide: z.array(HelperTvGuideEntry),
  updatedAt: IsoDateTime.nullable(),
  sourceDevice: HubLiveTvSource.nullable(),
});
export type HubLiveTv = z.infer<typeof HubLiveTv>;

/** What the admin window shows, without the lists themselves. Also the answer to a `PUT`. */
export const HubLiveTvSummary = z.object({
  channelCount: z.number().int().nonnegative(),
  guideCount: z.number().int().nonnegative(),
  updatedAt: IsoDateTime.nullable(),
  sourceDevice: HubLiveTvSource.nullable(),
});
export type HubLiveTvSummary = z.infer<typeof HubLiveTvSummary>;
