/**
 * The hub's copy of a companion's Live TV.
 *
 * A companion keeps M3U channels and an XMLTV guide and serves them on its own loopback helper; a
 * player on another machine cannot reach that, so the companion sends a copy here and the hub
 * hands it to paired players (`GET /api/v1/live-tv`). One copy at a time: whichever companion sent
 * last replaces it, and the hub says which one that was.
 *
 * The hub never opens any of these addresses. It stores them (in the settings table, so a backup
 * carries them and an in-memory test hub works the same) and returns them. The contract has
 * already held every address to a plain http(s) link with no sign-in in it.
 */
import type { HubLiveTv, HubLiveTvSource, HubLiveTvSummary, HubLiveTvUpload } from '@now-playing/contracts';
import { DomainError } from '@now-playing/domain';
import type { AuditService } from '../auth/audit.js';
import type { SettingsRepository } from '../db/repositories/settings.js';
import type { Clock } from '../deps.js';
import type { MetricsRegistry } from '../metrics/registry.js';

const KEY = 'liveTv.companion';
const EMPTY: HubLiveTv = { channels: [], guide: [], updatedAt: null, sourceDevice: null };

export class LiveTvService {
  /** Parsed once and kept: the list can be tens of megabytes and players ask for it often. */
  private cache: HubLiveTv | null = null;

  constructor(
    private readonly settings: SettingsRepository,
    private readonly audit: AuditService,
    private readonly metrics: MetricsRegistry,
    private readonly clock: Clock,
  ) {}

  get(): HubLiveTv {
    if (!this.cache) this.cache = this.settings.get<HubLiveTv>(KEY) ?? EMPTY;
    return this.cache;
  }

  summary(): HubLiveTvSummary {
    const tv = this.get();
    return { channelCount: tv.channels.length, guideCount: tv.guide.length, updatedAt: tv.updatedAt, sourceDevice: tv.sourceDevice };
  }

  put(upload: HubLiveTvUpload, source: HubLiveTvSource, meta: { ip: string | null; correlationId: string }): HubLiveTvSummary {
    const now = new Date(this.clock.now()).toISOString();
    const next: HubLiveTv = { channels: upload.channels, guide: upload.guide, updatedAt: now, sourceDevice: source };
    this.settings.set(KEY, next, now);
    this.cache = next;
    this.metrics.increment('liveTv.updated');
    this.audit.record({
      actor: { kind: 'device', id: source.deviceId, displayName: source.name },
      action: 'liveTv.update',
      outcome: 'success',
      target: { kind: 'live-tv', id: 'companion' },
      ip: meta.ip,
      correlationId: meta.correlationId,
      details: { channels: String(upload.channels.length), guide: String(upload.guide.length) },
    });
    return this.summary();
  }

  /**
   * Remove the copy. The admin may always; a companion only when the copy is its own, so one
   * companion cannot wipe what another sent.
   */
  clear(device: HubLiveTvSource | null, meta: { ip: string | null; correlationId: string; actorName: string }): void {
    const current = this.get();
    if (device && current.sourceDevice && current.sourceDevice.deviceId !== device.deviceId) throw new DomainError('forbidden', 'This Live TV was sent by another companion.');
    this.settings.delete(KEY);
    this.cache = EMPTY;
    this.audit.record({
      actor: device ? { kind: 'device', id: device.deviceId, displayName: device.name } : { kind: 'admin', id: 'admin', displayName: meta.actorName },
      action: 'liveTv.clear',
      outcome: 'success',
      target: { kind: 'live-tv', id: 'companion' },
      ip: meta.ip,
      correlationId: meta.correlationId,
    });
  }
}
