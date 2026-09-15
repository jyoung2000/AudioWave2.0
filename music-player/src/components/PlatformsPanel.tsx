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
 */
import { useState } from 'react';
import { Button, ButtonLink, Panel, PanelSection, ProviderMark, StatusDot, useToast } from '@now-playing/aqua-ui';
import type { ProviderDescriptor } from '@now-playing/contracts';
import { useAppState, usePlayer } from '../state/context.js';
import { ROUTE_LABELS, ROUTE_TONE, platformsInOrder, withHubReport, type Platform, type PlatformRoute } from '../lib/platforms.js';
import { zipSupported } from '../lib/zip.js';

export function PlatformsPanel({ descriptors }: { descriptors: readonly ProviderDescriptor[] | null }) {
  const state = useAppState();
  const rows = withHubReport(platformsInOrder(), descriptors);
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
