import type { Db } from '../connection.js';
import { AdminRepository } from './admin.js';
import { AuditRepository } from './audit.js';
import { CanonicalRepository } from './canonical.js';
import { DevicesRepository } from './devices.js';
import { DownloadsRepository } from './downloads.js';
import { GroupsRepository } from './groups.js';
import { LibraryRepository } from './library.js';
import { MetricsRepository } from './metrics.js';
import { PairingRepository } from './pairing.js';
import { ProvidersRepository } from './providers.js';
import { SettingsRepository } from './settings.js';
import { SharesRepository } from './shares.js';
import { SyncRepository } from './sync.js';

export interface Repositories {
  settings: SettingsRepository;
  admin: AdminRepository;
  audit: AuditRepository;
  devices: DevicesRepository;
  pairing: PairingRepository;
  groups: GroupsRepository;
  providers: ProvidersRepository;
  downloads: DownloadsRepository;
  library: LibraryRepository;
  sync: SyncRepository;
  shares: SharesRepository;
  canonical: CanonicalRepository;
  metrics: MetricsRepository;
}

export function createRepositories(db: Db): Repositories {
  return {
    settings: new SettingsRepository(db),
    admin: new AdminRepository(db),
    audit: new AuditRepository(db),
    devices: new DevicesRepository(db),
    pairing: new PairingRepository(db),
    groups: new GroupsRepository(db),
    providers: new ProvidersRepository(db),
    downloads: new DownloadsRepository(db),
    library: new LibraryRepository(db),
    sync: new SyncRepository(db),
    shares: new SharesRepository(db),
    canonical: new CanonicalRepository(db),
    metrics: new MetricsRepository(db),
  };
}

export * from './admin.js';
export * from './audit.js';
export * from './canonical.js';
export * from './devices.js';
export * from './downloads.js';
export * from './groups.js';
export * from './library.js';
export * from './metrics.js';
export * from './pairing.js';
export * from './providers.js';
export * from './settings.js';
export * from './shares.js';
export * from './sync.js';
