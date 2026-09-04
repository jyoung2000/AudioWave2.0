/* Standalone migration runner: `pnpm --filter @now-playing/hub migrate` (uses NP_DATA_DIR). */
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { openDatabase } from './connection.js';
import { migrate } from './migrate.js';

const config = loadConfig();
const dbFile = join(config.dataDir, 'hub.sqlite');
const db = openDatabase({ file: dbFile });
const result = migrate(db, { dbFile, backupDir: join(config.dataDir, 'backups') });
db.close();
console.info(`schema ${result.from} -> ${result.to}; applied: ${result.applied.join(', ') || 'nothing'}${result.backupPath ? `; backup: ${result.backupPath}` : ''}`);
