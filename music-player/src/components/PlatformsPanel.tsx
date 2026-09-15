/**
 * Platforms: what each one lets this player do, and what it does not.
 *
 * This is the panel to read before pairing anything, so it works with no hub paired — the table in
 * `lib/platforms.ts` ships with the player and is narrowed, never widened, by whatever a hub
 * reports once one is connected.
 *
 * It answers the question people actually arrive with ("can I get my Spotify library in here?")
 * with the same three columns for everyone, and it never leaves a "no" unexplained. The row also
 * carries the one route that does work for almost every platform: the export of your own music that
 * the platform itself will hand you, which this player can now unpack from the .zip it arrives in.
 *
 * And, when one is running, the local helper. Note where that appears: as a *fourth* line on a row,
 * never as a change to the first three. A yt-dlp on your own machine does not alter what YouTube
 * permits — it alters what is possible here — and writing those in the same column would turn an
 * honest "No" into a claim this app has no standing to make.
 */
import { useEffect, useState } from 'react';
import { Button, ButtonLink, Panel, PanelSection, ProviderMark, Spinner, StatusDot, TextField, useToast } from '@now-playing/aqua-ui';
import type { ProviderDescriptor } from '@now-playing/contracts';
import { useAppState, usePlayer } from '../state/context.js';
import { ROUTE_LABELS, ROUTE_TONE, platformsInOrder, withHelper, withHubReport, type Platform, type PlatformRoute } from '../lib/platforms.js';
import { zipSupported } from '../lib/zip.js';

export function PlatformsPanel({ descriptors }: { descriptors: readonly ProviderDescriptor[] | null }) {
  const { store } = usePlayer();
  const state = useAppState();

  // A helper can be started or stopped while this page sits open, so the answer is taken fresh each
  // time someone comes to look rather than remembered from startup.
  useEffect(() => {
    void store.refreshHelper();
  }, [store]);

  const rows = withHelper(withHubReport(platformsInOrder(), descriptors), state.helper?.health ?? null);
  return (
    <Panel title="Platforms">
      <PanelSection>
        <p className="player-hint">
          Three different questions, because the platforms answer them differently: whether this app can put sound out of your speakers, whether a copy can live here and play with the network off, and
          whether you end up with a file of your own. Every “no” below says whose rule it is.
        </p>
        <p className="player-hint">
          None of them lets an application take the audio out of its stream — Spotify’s and YouTube’s is protected, and this player will not work around that. What every one of them <em>does</em> offer
          is an export of the music that is already yours, and those arrive as a .zip, which this player {zipSupported() ? 'can unpack for you' : 'would unpack for you if this browser could inflate one'}
          .
        </p>
      </PanelSection>
      <HelperSection />
      <PanelSection>
        <ul className="player-platforms">
          {rows.map((row) => (
            <PlatformRow key={row.provider} platform={row} artwork={state.providerArtwork[row.provider] ?? null} />
          ))}
        </ul>
      </PanelSection>
      <PanelSection>
        <p className="player-hint">
          The marks above are this project’s own, in each platform’s published colour. Their logos belong to them and their brand terms ask that only the official file be used, so none is shipped here.
          If you hold one under those terms, “Use official artwork” puts it in place of the mark everywhere in the app; the file stays on this device.
        </p>
      </PanelSection>
    </Panel>
  );
}

/**
 * The helper, and the honest version of why it is not simply built in.
 *
 * Most people will see the "not running" state, so that state has to be the useful one: it says
 * what a helper is, what it would add, and the one command that starts it — not an apology.
 */
function HelperSection() {
  const { store } = usePlayer();
  const state = useAppState();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState('');
  const [token, setToken] = useState('');
  const helper = state.helper;

  // Between "we have not asked" and "there is none" is a real difference, and the second is a
  // claim. Until the first probe comes back, the panel says what it is doing instead.
  if (!state.helperProbed) {
    return (
      <PanelSection title="Running the tools yourself">
        <p className="player-hint">
          <Spinner /> Looking for a local helper…
        </p>
      </PanelSection>
    );
  }

  if (!helper) {
    return (
      <PanelSection title="Running the tools yourself">
        <p className="player-hint">
          A page in a browser cannot start a program — that is the sandbox every page lives in, and it is also what makes this one safe to open from a link. So yt-dlp and spotDL need something outside
          the page to run them. The helper is that: one small program that serves this player and runs the tools for it.
        </p>
        <p className="player-hint">
          Put <code>now-playing-helper</code> beside <code>now-playing.html</code> and run it. It opens the player with the tools wired up — no container, no desktop app, nothing to configure.
        </p>
        {state.savedHelper ? <p className="player-hint player-hint--warning">Nothing is answering at {state.savedHelper.origin} just now.</p> : null}
        <details className="player-details">
          <summary>My player is hosted somewhere else</summary>
          <p className="player-hint">
            Start the helper with <code>--no-app --allow-origin {typeof window === 'undefined' ? 'https://…' : window.location.origin}</code>, then paste what it prints.
          </p>
          <TextField label="Helper address" value={origin} onChange={(event) => setOrigin(event.currentTarget.value)} placeholder="http://127.0.0.1:17342" autoComplete="off" spellCheck={false} />
          <TextField label="Token" value={token} onChange={(event) => setToken(event.currentTarget.value)} autoComplete="off" spellCheck={false} />
          <div className="player-toolbar-row">
            <Button
              size="small"
              disabled={!origin.trim() || !token.trim() || busy}
              busy={busy}
              onClick={() => {
                setBusy(true);
                void store
                  .saveHelper({ origin: origin.trim().replace(/\/$/, ''), token: token.trim() })
                  .finally(() => setBusy(false));
              }}
            >
              Connect
            </Button>
            {state.savedHelper ? (
              <Button size="small" onClick={() => void store.saveHelper(null)}>
                Forget it
              </Button>
            ) : null}
          </div>
        </details>
      </PanelSection>
    );
  }

  return (
    <PanelSection title="Local helper">
      <p className="player-hint">
        <StatusDot kind="ok" label={`Running ${helper.sameOrigin ? 'and serving this page' : `at ${helper.origin}`}`} />
      </p>
      <ul className="player-helper-tools">
        {helper.health.tools.map((tool) => (
          <li key={tool.id}>
            <StatusDot kind={tool.present ? 'ok' : 'neutral'} label={tool.id} />
            <span>{tool.present ? (tool.version ?? 'present') : 'not installed'}</span>
            {!tool.present && tool.installable ? (
              <Button
                size="mini"
                busy={busy}
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void store
                    .installHelperTool(tool.id)
                    .then(() => toast.show(`Asked the helper to fetch ${tool.id}.`))
                    .finally(() => setBusy(false));
                }}
                ellipsis
              >
                Fetch it
              </Button>
            ) : null}
            {!tool.present && tool.installHint ? <span className="player-helper-tools__hint">{tool.installHint}</span> : null}
          </li>
        ))}
      </ul>
      <p className="player-hint">
        The helper will fetch from {helper.health.allowedHosts.length} host{helper.health.allowedHosts.length === 1 ? '' : 's'} and no others, and it refuses any request that does not say what
        entitles you to the file. It is on your machine, so what it does is yours to answer for.
      </p>
      {!helper.sameOrigin ? (
        <div className="player-toolbar-row">
          <Button size="small" onClick={() => void store.saveHelper(null)}>
            Forget this helper
          </Button>
        </div>
      ) : null}
    </PanelSection>
  );
}

function PlatformRow({ platform, artwork }: { platform: Platform; artwork: string | null }) {
  const { store } = usePlayer();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  return (
    <li className="player-platform">
      <div className="player-platform__head">
        <span className="player-platform__mark">
          <ProviderMark provider={platform.provider} />
        </span>
        <span className="player-platform__name">
          <strong>{platform.name}</strong>
          <span className="player-platform__summary">{platform.summary}</span>
        </span>
        <span className="player-platform__routes">
          <Route label="Play here" route={platform.play} />
          <Route label="Keep offline" route={platform.keep} />
          <Route label="Save a file" route={platform.save} />
          {platform.viaTool ? (
            <span className="player-platform__route" title={platform.viaTool.detail}>
              <StatusDot kind={platform.viaTool.available ? 'info' : 'neutral'} label={`Your ${platform.viaTool.tool}: ${platform.viaTool.available ? 'can reach it' : 'not installed'}`} />
            </span>
          ) : null}
        </span>
      </div>
      <Button size="mini" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
        {open ? 'Hide the detail' : 'Why?'}
      </Button>
      {open ? (
        <div className="player-platform__detail">
          <dl>
            <dt>Play here</dt>
            <dd>{platform.play.detail}</dd>
            <dt>Keep offline</dt>
            <dd>{platform.keep.detail}</dd>
            <dt>Save a file</dt>
            <dd>{platform.save.detail}</dd>
            <dt>Getting your music in</dt>
            <dd>{platform.bringIn ?? 'There is no route from here into your library, and this app does not pretend otherwise.'}</dd>
            {platform.viaTool ? (
              <>
                <dt>With your own tool</dt>
                <dd>{platform.viaTool.detail}</dd>
              </>
            ) : null}
          </dl>
          {platform.needsHub ? <p className="player-hint">Needs a paired hub: the keys and the sign-in live there, not in this browser.</p> : null}
          <div className="player-toolbar-row">
            {platform.home ? (
              <ButtonLink size="mini" href={platform.home} target="_blank" rel="noopener noreferrer">
                Open {platform.name}
              </ButtonLink>
            ) : null}
            {platform.terms ? (
              <ButtonLink size="mini" href={platform.terms} target="_blank" rel="noopener noreferrer">
                The terms this follows
              </ButtonLink>
            ) : null}
            <Button
              size="mini"
              onClick={() => {
                pickImage((file) => {
                  void store.setPlatformArtwork(platform.provider, file).then(() => toast.show(`${platform.name} now shows the artwork you supplied.`));
                });
              }}
              ellipsis
            >
              {artwork ? 'Replace official artwork' : 'Use official artwork'}
            </Button>
            {artwork ? (
              <Button
                size="mini"
                onClick={() => {
                  void store.setPlatformArtwork(platform.provider, null).then(() => toast.show(`${platform.name} is back to this project’s own mark.`));
                }}
              >
                Back to our mark
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

function Route({ label, route }: { label: string; route: PlatformRoute }) {
  return (
    <span className="player-platform__route" title={route.detail}>
      <StatusDot kind={ROUTE_TONE[route.state]} label={`${label}: ${ROUTE_LABELS[route.state]}`} />
    </span>
  );
}

function pickImage(onPick: (file: File) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/svg+xml,image/webp,image/jpeg';
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) onPick(file);
  };
  input.click();
}
