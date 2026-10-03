/**
 * Pairing with an Airwave Hub, and what sharing actually means.
 *
 * The section states the boundary before anyone opts in: what goes to the hub, what never does,
 * and that audio does not move unless a transfer is explicitly started. That is the whole privacy
 * model, and it belongs where the decision is made.
 *
 * Pairing shows a code to compare with the one on the hub's screen and claims nothing until the
 * hub has confirmed it. Forgetting the hub asks first.
 */
import { useEffect, useState, type FormEvent } from 'react';
import type { HubConnection, PairingChallenge } from '../../shared/ipc.js';
import { invoke } from '../bridge.js';
import { ago } from '../format.js';
import { useAction } from '../hooks.js';
import { Check, Push, Status, useConfirm } from '../ui.js';

/** What a hub lets this PC do, in words. A permission this build does not know is left out, not shown raw. */
const SCOPE_WORDS: Record<string, string> = {
  'library:read': 'see the hub’s library',
  'library:share': 'share this PC’s library',
  'playlists:sync': 'keep playlists in step',
  'eq:sync': 'keep EQ presets in step',
  'history:aggregate': 'add to listening totals',
  'history:events': 'add to listening history',
  'group:member': 'join group sessions',
  'group:admin': 'manage groups',
  'downloads:request': 'ask the hub to download',
  'transfers:receive': 'send and receive files',
  'files:serve': 'serve files to your devices',
  'search:use': 'search through the hub',
  'shares:create': 'make share links',
  'profile:read': 'read your profile',
  'profile:write': 'change your profile',
  'backup:read': 'read the hub’s backups',
};

export function scopeWords(scopes: readonly string[]): string {
  const words = scopes.map((scope) => SCOPE_WORDS[scope]).filter((word): word is string => Boolean(word));
  if (!words.length) return 'Nothing yet.';
  const sentence = words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

export function HubView({ status, onChanged }: { status: HubConnection | null; onChanged: () => void }) {
  const confirm = useConfirm();
  const [endpoint, setEndpoint] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<PairingChallenge | null>(null);
  const [shareLibrary, setShareLibrary] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);

  const start = useAction(async () => invoke('hub:pair-start', { endpoint: endpoint.trim(), code: code.trim() }));
  const complete = useAction(async (sessionId: string) => invoke('hub:pair-await', { sessionId }));
  const forget = useAction(async () => invoke('hub:forget', undefined));
  const sync = useAction(async () => invoke('hub:sync-now', undefined));
  const share = useAction(async (enabled: boolean) => invoke('hub:share-library', { enabled }));

  const paired = Boolean(status?.connected || status?.endpoint);

  // The checkbox shows what was chosen, not "off" every time the window opens.
  useEffect(() => {
    if (!paired) return undefined;
    let cancelled = false;
    void invoke('hub:sharing', undefined)
      .then((result) => {
        if (!cancelled) setShareLibrary(result.enabled);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [paired]);

  if (paired && status) {
    const ask = async () => {
      const yes = await confirm({ title: `Forget ${status.hubName ?? 'this hub'}?`, detail: 'This PC stops syncing with it. Your music and folders on this PC stay exactly as they are.', action: 'Forget This Hub', destructive: true });
      if (!yes) return;
      await forget.run();
      setSaid(null);
      onChanged();
    };
    return (
      <>
        <fieldset>
          <legend>Hub connection</legend>
          <div className="pref">
            <span className="k">Hub:</span>
            <div className="v">
              <b>{status.hubName ?? 'Airwave Hub'}</b>
              <span className="path">{status.endpoint}</span>
            </div>
            <span className="k top">Status:</span>
            <div className="v">
              <Status kind={status.connected ? 'ok' : 'warn'}>{status.connected ? 'Connected' : 'Not reachable'}</Status>
              {status.reason ? <span className={status.connected ? 'sub' : 'sub note--bad'}>{status.reason}</span> : null}
            </div>
            <span className="k">Fingerprint:</span>
            <div className="v">
              <span className="path">{status.hubFingerprint ?? '—'}</span>
            </div>
            <span className="k top">This PC may:</span>
            <div className="v">{scopeWords(status.scopes)}</div>
            <span className="k">Last synced:</span>
            <div className="v">{status.lastSyncAt ? ago(status.lastSyncAt) : 'Not yet'}</div>
            <span className="k" />
            <div className="v">
              <Push
                busy={sync.busy}
                disabled={!status.connected}
                reason={status.connected ? null : 'The hub isn’t reachable right now.'}
                onClick={() =>
                  void sync.run().then((result) => {
                    if (!result) return;
                    setSaid(result.reason ? { text: result.reason, bad: true } : { text: 'Synced.' });
                    onChanged();
                  })
                }
              >
                Sync Now
              </Push>
              <Push busy={forget.busy} onClick={() => void ask()}>
                Forget This Hub…
              </Push>
              {said ? (
                <span className={said.bad ? 'note note--bad' : 'note'} style={{ margin: 0 }} role="status">
                  {said.text}
                </span>
              ) : null}
            </div>
          </div>
        </fieldset>

        <fieldset>
          <legend>What is shared</legend>
          <Check
            checked={shareLibrary}
            disabled={share.busy}
            onChange={(event) => {
              const enabled = event.currentTarget.checked;
              void share.run(enabled).then((result) => {
                if (!result) return;
                if (result.reason) setSaid({ text: result.reason, bad: true });
                else setShareLibrary(result.enabled);
              });
            }}
          >
            Let the hub see what music is on this PC
          </Check>
          <ul className="plainlist">
            <li>What is sent: titles, artists, albums, durations, formats and playlist contents.</li>
            <li>What is never sent: the folders on this PC, or any path within them.</li>
            <li>Audio files stay here until you send one yourself, with Send to Hub in Library.</li>
            <li>Turning this off stops future syncs. The hub’s administrator can delete what it already has.</li>
          </ul>
        </fieldset>
      </>
    );
  }

  const pair = async (event: FormEvent) => {
    event.preventDefault();
    if (!endpoint.trim() || !code.trim() || start.busy) return;
    setSaid(null);
    const result = await start.run();
    if (!result) return;
    if (result.reason) return setSaid({ text: result.reason, bad: true });
    if (!result.challenge) return;
    setChallenge(result.challenge);
    const completed = await complete.run(result.challenge.sessionId);
    setChallenge(null);
    setCode('');
    if (completed?.reason) setSaid({ text: completed.reason, bad: true });
    onChanged();
  };

  return (
    <fieldset>
      <legend>Hub connection</legend>
      <p className="hint">An Airwave Hub is optional. Pairing with one puts this PC’s library on your other devices and keeps playlists in step. Nothing about this PC is shared until you pair, and then only what the next step lists.</p>
      {challenge ? (
        <>
          <div className="lcd" role="status">
            <span className="lcd__code lcd__code--words">{challenge.verificationFingerprint}</span>
            <span className="lcd__sub">Check that this matches the code on the hub’s screen</span>
          </div>
          <p className="note">
            {challenge.hubName} · hub fingerprint <span className="path">{challenge.hubFingerprint}</span>
          </p>
          <p className="note">If the two don’t match, cancel — something else is answering at that address.</p>
          <div className="barrow">
            <Push
              onClick={() => {
                setChallenge(null);
                setCode('');
              }}
            >
              Cancel
            </Push>
            <span className="note" style={{ margin: 0 }} role="status">
              Waiting for someone at the hub to confirm…
            </span>
          </div>
        </>
      ) : (
        <>
          <form className="barrow" noValidate onSubmit={(event) => void pair(event)}>
            <input className="field" type="url" inputMode="url" value={endpoint} onChange={(event) => setEndpoint(event.currentTarget.value)} placeholder="http://192.168.1.20:4546" aria-label="Hub address" spellCheck={false} autoComplete="off" />
            <input className="field field--code" type="text" value={code} onChange={(event) => setCode(event.currentTarget.value.toUpperCase())} placeholder="Pairing code" aria-label="Pairing code" spellCheck={false} autoComplete="off" />
            <Push type="submit" isDefault busy={start.busy} disabled={!code.trim() || !endpoint.trim()} reason={!endpoint.trim() ? 'Enter the hub’s address first.' : !code.trim() ? 'Enter the pairing code first.' : null}>
              Pair
            </Push>
          </form>
          <p className={said?.bad || start.error ? 'note note--bad' : 'note'} role={said?.bad || start.error ? 'alert' : undefined}>
            {start.error ?? said?.text ?? 'The address is where the hub’s page opens. Make a pairing code there, under Devices.'}
          </p>
        </>
      )}
    </fieldset>
  );
}
