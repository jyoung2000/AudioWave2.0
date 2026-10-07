/**
 * Music search: which services the catalog asks, whether a catalog download carries lyrics, and the
 * optional SongLink key (DEC-039; UX-SEARCH-006).
 *
 * Everything works with no key at all (keyless first). SongLink closed keyless access in 2026, so a
 * key only adds Tidal, Qobuz and Amazon links. The key is write-only, sealed like the hub's other
 * secrets: the hub says whether one is set and never sends it back, and this form never shows one.
 * Nothing is sent while ticking or typing: Save sends what changed, Revert puts back what the hub has.
 */
import { useId, useState } from 'react';
import { CATALOG_PROVIDERS, type CatalogProviderId, type CatalogSettingsInput, type CatalogSettingsView } from '@now-playing/contracts';
import { CATALOG_PROVIDER_LABELS } from '@now-playing/domain/catalog';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { ActionError, Check, errorSentence, Field, Group, Note, Push, useHubUi } from '../ui.js';

const ABOUT: Record<CatalogProviderId, string> = {
  itunes: 'songs, albums and artists, with 30-second previews',
  deezer: 'songs, albums and artists, with previews, tempo and ISRC',
  musicbrainz: 'songs, and the links that tie them to other platforms',
  youtube: 'through yt-dlp on this hub',
  soundcloud: 'through yt-dlp on this hub',
};

interface Draft {
  embedLyrics: boolean;
  providers: Record<CatalogProviderId, boolean>;
  /** Typed but not sent; empty means "leave the key as it is". */
  key: string;
  clearKey: boolean;
}

export function MusicSearchSettingsView() {
  const settings = useResource('catalogSettingsGet');
  const save = useAction(async (body: CatalogSettingsInput) => api('catalogSettingsPut', { body }));
  const { say } = useHubUi();
  const [draft, setDraft] = useState<Draft | null>(null);
  const keyId = useId();

  const stored = settings.data as CatalogSettingsView | null;
  if (!stored) {
    return (
      <Group title="Music search">
        <Note bad={Boolean(settings.error)}>{settings.error ? errorSentence(settings.error) : 'Loading…'}</Note>
      </Group>
    );
  }

  const base: Draft = { embedLyrics: stored.embedLyrics, providers: { ...stored.providers } as Record<CatalogProviderId, boolean>, key: '', clearKey: false };
  const value = draft ?? base;
  const changedProviders = CATALOG_PROVIDERS.filter((p) => value.providers[p] !== base.providers[p]);
  const dirty = draft !== null && (value.embedLyrics !== base.embedLyrics || changedProviders.length > 0 || value.key.trim() !== '' || value.clearKey);
  const none = CATALOG_PROVIDERS.every((p) => !value.providers[p]);
  const edit = (patch: Partial<Draft>): void => {
    setDraft({ ...value, ...patch });
    save.clearError();
  };

  const submit = async (): Promise<void> => {
    if (!dirty || none) return;
    const body: CatalogSettingsInput = {};
    if (value.embedLyrics !== base.embedLyrics) body.embedLyrics = value.embedLyrics;
    if (changedProviders.length) body.providers = Object.fromEntries(changedProviders.map((p) => [p, value.providers[p]]));
    if (value.clearKey) body.odesliKey = '';
    else if (value.key.trim()) body.odesliKey = value.key.trim();
    const answer = await save.run(body);
    if (!answer) return;
    setDraft(null);
    settings.reload();
    say(body.odesliKey === '' ? 'Saved. The SongLink key is cleared.' : body.odesliKey ? 'Saved. The SongLink key is kept sealed on the hub.' : 'Saved.');
  };

  return (
    <Group title="Music search" hint="What the Search tab and every paired player ask when they look for music. Every service here is free and needs no account.">
      <div className="pref">
        <span className="k top">Ask:</span>
        <div className="v stack">
          {CATALOG_PROVIDERS.map((p) => (
            <Check key={p} checked={value.providers[p]} onChange={(on) => edit({ providers: { ...value.providers, [p]: on } })}>
              {CATALOG_PROVIDER_LABELS[p]} <span className="sub">— {ABOUT[p]}</span>
            </Check>
          ))}
          {none ? <span className="sub note--bad">Leave at least one service on, or search finds nothing.</span> : null}
        </div>
        <span className="k top">Downloads:</span>
        <div className="v stack">
          <Check checked={value.embedLyrics} onChange={(on) => edit({ embedLyrics: on })}>
            Write lyrics into a song downloaded from Search
          </Check>
          <span className="sub">From LRCLIB, synced where it has them. ISRC, genre, label and year are always written.</span>
        </div>
        <label className="k top" htmlFor={keyId}>
          SongLink key:
        </label>
        <div className="v">
          <Field
            id={keyId}
            type="password"
            className="field--group"
            autoComplete="off"
            placeholder={stored.odesliKeyConfigured ? 'Set — type a new one to replace it' : 'Not set (optional)'}
            value={value.key}
            disabled={value.clearKey}
            onChange={(event) => edit({ key: event.currentTarget.value, clearKey: false })}
          />
          {stored.odesliKeyConfigured ? (
            <Push onClick={() => edit({ key: '', clearKey: !value.clearKey })} aria-pressed={value.clearKey}>
              {value.clearKey ? 'Keep Key' : 'Clear Key'}
            </Push>
          ) : null}
          <span className="sub">
            {value.clearKey ? 'The key will be cleared when you save.' : 'Optional. Without it, links to other platforms come from MusicBrainz and Deezer; with it, Tidal, Qobuz and Amazon Music too. It is kept sealed and never shown again.'}
          </span>
        </div>
      </div>
      <div className="barrow">
        <Push primary disabled={!dirty || none} reason={none ? 'Leave at least one service on.' : 'Nothing has changed.'} busy={save.busy} onClick={() => void submit()}>
          Save
        </Push>
        <Push disabled={!dirty} onClick={() => setDraft(null)}>
          Revert
        </Push>
      </div>
      <ActionError error={save.error} />
    </Group>
  );
}
