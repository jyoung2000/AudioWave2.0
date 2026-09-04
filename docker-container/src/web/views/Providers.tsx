/**
 * Provider configuration.
 *
 * Two honesty rules are visible in the UI here. Secrets are write-only: the form shows a hint of
 * what is stored and never the value, and leaving a secret field blank keeps the existing one
 * rather than clearing it. And each provider's capability matrix is shown as reviewed facts with
 * its limitations spelled out, so an operator can see *before* enabling it that (for example)
 * Spotify will never play audio through the hub.
 */
import { useCallback, useState } from 'react';
import { AquaTable, Button, Checkbox, Panel, PanelSection, SourceBadge, TextField, useToast } from '@now-playing/aqua-ui';
import type { ProviderAppConfigView, ProviderDescriptor, ProviderHealth } from '@now-playing/contracts';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { AsyncPanel, Health, InlineError } from './common.js';

const CAPABILITY_LABELS: Record<string, string> = {
  metadata: 'Metadata',
  search: 'Search',
  preview: 'Preview',
  playback: 'Playback',
  importLikes: 'Import likes',
  importPlaylists: 'Import playlists',
  creatorDownload: 'Creator downloads',
  userOwnedDownload: 'Your own downloads',
  groupSync: 'Group sync',
  eq: 'Equaliser',
};

export function ProvidersView() {
  const providers = useResource('providersList', {}, { pollMs: 20_000 });
  const usage = useResource('providersUsage', {}, { pollMs: 15_000 });
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <>
      <AsyncPanel resource={providers} title="Providers">
        {(raw) => {
          const data = raw as { items: ProviderDescriptor[]; health: ProviderHealth[] };
          const healthOf = (id: string) => data.health.find((h) => h.provider === id);
          return (
            <AquaTable
              label="Providers"
              rowKey={(row: ProviderDescriptor) => row.provider}
              rows={data.items}
              onActivate={(row) => setSelected(row.provider)}
              columns={[
                { id: 'provider', header: 'Provider', primary: true, cell: (row) => <SourceBadge provider={row.provider} label={row.displayName} /> },
                { id: 'role', header: 'Role', cell: (row) => row.role },
                { id: 'status', header: 'Status', cell: (row) => <Health status={healthOf(row.provider)?.status ?? 'unknown'} /> },
                { id: 'playback', header: 'Playback', cell: (row) => row.capabilities.playback },
                { id: 'download', header: 'Downloads', cell: (row) => (row.capabilities.creatorDownload === 'available' || row.capabilities.userOwnedDownload === 'available' ? 'available' : row.capabilities.userOwnedDownload) },
                { id: 'sync', header: 'Group sync', cell: (row) => row.capabilities.groupSync },
                { id: 'configure', header: '', headerLabel: 'Configure', cell: (row) => <Button size="small" onClick={() => setSelected(row.provider)} ellipsis>Configure</Button> },
              ]}
            />
          );
        }}
      </AsyncPanel>

      {selected ? <ProviderDetail provider={selected} onClose={() => setSelected(null)} onSaved={() => { providers.reload(); usage.reload(); }} /> : null}

      <AsyncPanel resource={usage} title="Quota and rate limits">
        {(raw) => (
          <AquaTable
            label="Provider usage"
            rowKey={(row: { provider: string }) => row.provider}
            rows={(raw as { items: Array<{ provider: string; budget: { perMinute: number; perDay: number | null; usedMinute: number; usedDay: number; shedding: string[] }; concurrency: { limit: number; inFlight: number }; queueDepth: Record<string, number> }> }).items}
            columns={[
              { id: 'provider', header: 'Provider', primary: true, cell: (row) => row.provider },
              { id: 'minute', header: 'This minute', cell: (row) => `${row.budget.usedMinute} / ${row.budget.perMinute}` },
              { id: 'day', header: 'Today', cell: (row) => (row.budget.perDay === null ? `${row.budget.usedDay}` : `${row.budget.usedDay} / ${row.budget.perDay}`) },
              { id: 'inflight', header: 'In flight', align: 'right', cell: (row) => `${row.concurrency.inFlight} / ${row.concurrency.limit}` },
              { id: 'queue', header: 'Queued', align: 'right', cell: (row) => Object.values(row.queueDepth).reduce((a, b) => a + b, 0) },
              { id: 'shed', header: 'Shedding', cell: (row) => (row.budget.shedding.length ? row.budget.shedding.join(', ') : '—') },
            ]}
          />
        )}
      </AsyncPanel>
    </>
  );
}

function ProviderDetail({ provider, onClose, onSaved }: { provider: string; onClose: () => void; onSaved: () => void }) {
  const config = useResource('providersConfigGet', { params: { provider } });
  const descriptors = useResource('providersList');
  const toast = useToast();

  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [enabled, setEnabled] = useState<boolean | null>(null);

  const save = useAction(async (body: Record<string, unknown>) => api('providersConfigPut', { params: { provider }, body }));
  const test = useAction(async () => api('providersTest', { params: { provider } }));

  const current = config.data as ProviderAppConfigView | null;
  const descriptor = (descriptors.data as { items: ProviderDescriptor[] } | null)?.items.find((d) => d.provider === provider) ?? null;

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const body: Record<string, unknown> = { enabled: enabled ?? current?.enabled ?? true };
      // An empty secret field means "leave what is stored alone", never "clear it".
      if (clientId.trim()) body['clientId'] = clientId.trim();
      if (clientSecret.trim()) body['clientSecret'] = clientSecret.trim();
      if (apiKey.trim()) body['apiKey'] = apiKey.trim();
      if (contactEmail.trim()) body['contactEmail'] = contactEmail.trim();
      const result = await save.run(body);
      if (result) {
        setClientSecret('');
        setApiKey('');
        toast.show(`${descriptor?.displayName ?? provider} saved`, { kind: 'success' });
        config.reload();
        onSaved();
      }
    },
    [enabled, current, clientId, clientSecret, apiKey, contactEmail, save, toast, descriptor, provider, config, onSaved],
  );

  const required = new Set(current?.missing ?? []);

  return (
    <Panel title={descriptor?.displayName ?? provider}>
      <PanelSection title="What this provider can do">
        <ul className="admin-capabilities">
          {Object.entries(descriptor?.capabilities ?? {})
            .filter(([key]) => key in CAPABILITY_LABELS)
            .map(([key, value]) => (
              <li key={key} data-state={String(value)}>
                <span>{CAPABILITY_LABELS[key]}</span>
                <span>{String(value)}</span>
              </li>
            ))}
        </ul>
        {descriptor?.capabilities.reason ? <p className="admin-hint">{descriptor.capabilities.reason}</p> : null}
        {descriptor?.limitations?.length ? (
          <>
            <h4 className="admin-subhead">Limitations</h4>
            <ul className="admin-list">
              {descriptor.limitations.map((limitation, i) => (
                <li key={i}>{limitation}</li>
              ))}
            </ul>
          </>
        ) : null}
        {descriptor?.attribution ? <p className="admin-hint">Attribution: {descriptor.attribution}</p> : null}
        {descriptor?.rateStrategy ? <p className="admin-hint">Rate limits: {descriptor.rateStrategy}</p> : null}
        {descriptor?.docsUrl ? (
          <p className="admin-hint">
            <a href={descriptor.docsUrl} target="_blank" rel="noreferrer noopener">
              Provider documentation
            </a>
          </p>
        ) : null}
      </PanelSection>

      <PanelSection title="Credentials">
        <form className="admin-form" onSubmit={submit}>
          <Checkbox checked={enabled ?? current?.enabled ?? true} onChange={(e) => setEnabled(e.currentTarget.checked)}>
            Enabled
          </Checkbox>
          {required.has('clientId') || current?.clientId ? (
            <TextField label="Client ID" value={clientId} placeholder={current?.clientId ?? ''} onChange={(e) => setClientId(e.currentTarget.value)} autoComplete="off" spellCheck={false} />
          ) : null}
          {required.has('clientSecret') || current?.clientSecretHint ? (
            <TextField
              label="Client secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.currentTarget.value)}
              autoComplete="off"
              hint={current?.clientSecretHint ? `Stored (${current.clientSecretHint}). Leave blank to keep it.` : 'Stored encrypted; never shown again.'}
            />
          ) : null}
          {required.has('apiKey') || current?.apiKeyHint ? (
            <TextField
              label="API key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.currentTarget.value)}
              autoComplete="off"
              hint={current?.apiKeyHint ? `Stored (${current.apiKeyHint}). Leave blank to keep it.` : 'Stored encrypted; never shown again.'}
            />
          ) : null}
          {provider === 'musicbrainz' ? (
            <TextField
              label="Contact email"
              value={contactEmail}
              placeholder={current?.contactEmail ?? ''}
              onChange={(e) => setContactEmail(e.currentTarget.value)}
              hint="MusicBrainz throttles requests that do not identify a contact. This is sent in the User-Agent header only."
            />
          ) : null}
          {current?.missing.length ? <p className="admin-hint admin-hint--warning">Still missing: {current.missing.join(', ')}</p> : null}
          <div className="admin-actions">
            <Button type="submit" variant="default" busy={save.busy}>
              Save
            </Button>
            <Button busy={test.busy} onClick={() => void test.run().then((r) => r && toast.show((r as { message: string }).message, { kind: (r as { ok: boolean }).ok ? 'success' : 'warning' }))}>
              Test connection
            </Button>
            <Button onClick={onClose}>Close</Button>
          </div>
          <InlineError error={save.error} />
        </form>
      </PanelSection>
    </Panel>
  );
}
