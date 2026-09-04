/** Values shared by the e2e setup and the tests that run after it. */
import { fileURLToPath } from 'node:url';

/** Where the signed-in session is saved, so the suite logs in once rather than once per test. */
export const AUTH_STATE = fileURLToPath(new URL('../../test-results/hub-auth.json', import.meta.url));

/** A passphrase that passes the hub's own strength rules. */
export const STRONG_PASSWORD = 'seven-copper-lantern-moth';
