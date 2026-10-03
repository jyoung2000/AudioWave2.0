/**
 * Providers.
 *
 * The table is the design's: a status lamp and name, the role, four capability chips, and Details
 * or Set Up. Three honesty rules show in it. Every chip is the provider's reviewed capability, so an
 * operator can see before enabling it that (for example) Spotify will never play audio through the
 * hub. Whether a provider is on is read from the hub, never assumed — the external media tool is on
 * or off because the hub says so. And secrets are write-only: the form shows a hint of what is
 * stored and never the value, and a blank secret field keeps the stored one rather than clearing it.
 *
 * Details and Set Up open under their own row, not below the table: the row's button says it is
 * expanded, the caret moves into the details, Escape or Close shuts them and puts the caret back on
 * the button. Requests and limits lists the providers in use (switched on and set up, or asked for
 * something lately); Show All Providers lists the rest.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderAppConfigView, ProviderDescriptor, ProviderHealth } from '@now-playing/contracts';
import { api } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { CAP_WORDS, CAPABILITY_LABELS, capLevel, headlineCaps, PROVIDER_ROLES, PROVIDER_STATUS } from '../lib/words.js';
import { ActionError, Check, EmptyCells, Field, Group, listState, Note, Push, Sdot, SubHead, useHubUi } from '../ui.js';

interface Usage {
  provider: string;
  budget: { perMinute: number; perDay: number | null; usedMinute: number; usedDay: number; shedding: string[] };
  concurrency: { limit: number; inFlight: number };
  queueDepth: Record<string, number>;
}

function Cap({ label, state }: { label: string; state: string }) {
  const words = CAP_WORDS[state] ?? 'no';
  return (
    <span className={`cap cap--${capLevel(state)}`} title={`${label}: ${words}`}>
      {label}
      <span className="sr">: {words}</span>
    </span>
  );
}

export function ProvidersView() {
  const providers = useResource('providersList', {}, { pollMs: 20_000 });
  const usage = useResource('providersUsage', {}, { pollMs: 15_000 });
  const [selected, setSelected] = useState<string | null>(null);
  const [allUsage, setAllUsage] = useState(false);
  // Each row's Details button, so closing the details can put the caret back where it was.
  const openers = useRef(new Map<string, HTMLButtonElement>());
  const close = useCallback((provider: string) => {
    setSelected(null);
    openers.current.get(provider)?.focus();
  }, []);

  const data = providers.data as { items: ProviderDescriptor[]; health: ProviderHealth[] } | null;
  const state = listState(providers, (d) => (d as { items: ProviderDescriptor[] }).items.length === 0, 'No providers.');
  const healthOf = (id: string): ProviderHealth | undefined => data?.health.find((h) => h.provider === id);
  const nameOf = (id: string): string => data?.items.find((p) => p.provider === id)?.displayName ?? id;
  const usageItems = (usage.data as { items: Usage[] } | null)?.items ?? [];
  const inUse = usageItems.filter((row) => {
    const descriptor = data?.items.find((p) => p.provider === row.provider);
    const busy = row.budget.usedMinute > 0 || row.budget.usedDay > 0 || row.concurrency.inFlight > 0 || Object.values(row.queueDepth).some((n) => n > 0);
    return busy || Boolean(descriptor?.enabled && descriptor.configured);
  });
  const shownUsage = allUsage ? usageItems : inUse;
  const hiddenUsage = usageItems.length - inUse.length;
  const usageState = listState(usage, () => shownUsage.length === 0, 'No provider is in use yet.');

  return (
    <Group title="Providers" hint="Used through their own APIs and within their terms. What each can do is what its terms allow, not what would be convenient.">
      <div className="well">
        <table className="tbl" aria-label="Providers">
          <colgroup>
            <col style={{ width: '26%' }} />
            <col className="hide-sm" style={{ width: '18%' }} />
            <col />
            <col style={{ width: 92 }} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col" className="hide-sm">
                Role
              </th>
              <th scope="col">What it can do</th>
              <th scope="col">
                <span className="sr">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {state ? <EmptyCells columns={4} {...state} /> : null}
            {state
              ? null
              : (data?.items ?? []).map((p) => {
                  const status = PROVIDER_STATUS[healthOf(p.provider)?.status ?? (p.enabled ? 'ok' : 'disabled')] ?? PROVIDER_STATUS.down;
                  // Set Up only where there is a key or an app to enter; everything else is ready as it is.
                  const needsSetup = p.authType === 'api-key' || p.authType === 'oauth-pkce' || p.authType === 'oauth-client-credentials' || !p.configured;
                  const open = selected === p.provider;
                  return (
                    <Fragment key={p.provider}>
                    <tr className={open ? 'is-open' : undefined}>
                      <td title={status.word}>
                        <Sdot kind={status.dot} label={status.word} inline />
                        <b>{p.displayName}</b>
                      </td>
                      <td className="hide-sm">{PROVIDER_ROLES[p.role] ?? p.role}</td>
                      <td>
                        <span className="caps">
                          {headlineCaps(p.capabilities).map((cap) => (
                            <Cap key={cap.label} {...cap} />
                          ))}
                        </span>
                      </td>
                      <td className="acts">
                        <Push
                          ref={(node) => {
                            if (node) openers.current.set(p.provider, node);
                            else openers.current.delete(p.provider);
                          }}
                          aria-label={`${needsSetup ? 'Set up' : 'Details of'} ${p.displayName}`}
                          aria-expanded={open}
                          aria-controls={open ? `prov-detail-${p.provider}` : undefined}
                          onClick={() => setSelected(open ? null : p.provider)}
                        >
                          {needsSetup ? 'Set Up' : 'Details'}
                        </Push>
                      </td>
                    </tr>
                    {open ? (
                      <tr className="detail-row">
                        <td colSpan={4}>
                          <ProviderDetail
                            descriptor={p}
                            health={healthOf(p.provider)}
                            onClose={() => close(p.provider)}
                            onSaved={() => {
                              providers.reload();
                              usage.reload();
                            }}
                          />
                        </td>
                      </tr>
                    ) : null}
                    </Fragment>
                  );
                })}
          </tbody>
        </table>
      </div>

      <SubHead>Requests and limits</SubHead>
      <div className="well">
        <table className="tbl" id="usage-table" aria-label="Requests and limits">
          <colgroup>
            <col />
            <col style={{ width: '20%' }} />
            <col style={{ width: '20%' }} />
            <col style={{ width: '16%' }} className="hide-sm" />
            <col style={{ width: '14%' }} className="hide-sm" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">This minute</th>
              <th scope="col">Today</th>
              <th scope="col" className="num hide-sm">
                In progress
              </th>
              <th scope="col" className="num hide-sm">
                Waiting
              </th>
            </tr>
          </thead>
          <tbody>
            {usageState ? <EmptyCells columns={5} {...usageState} /> : null}
            {usageState
              ? null
              : shownUsage.map((row) => (
                  <tr key={row.provider} title={row.budget.shedding.length ? 'Busy: the hub is putting off the less urgent requests.' : undefined}>
                    <td>{nameOf(row.provider)}</td>
                    <td>
                      {row.budget.usedMinute} of {row.budget.perMinute}
                    </td>
                    <td>{row.budget.perDay === null ? `${row.budget.usedDay}, no daily limit` : `${row.budget.usedDay} of ${row.budget.perDay}`}</td>
                    <td className="num hide-sm">{row.concurrency.inFlight}</td>
                    <td className="num hide-sm">{Object.values(row.queueDepth).reduce((a, b) => a + b, 0)}</td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      {hiddenUsage > 0 || allUsage ? (
        <div className="barrow">
          <Push aria-expanded={allUsage} aria-controls="usage-table" onClick={() => setAllUsage(!allUsage)}>
            {allUsage ? 'Show Providers in Use' : `Show All Providers (${hiddenUsage} more)`}
          </Push>
        </div>
      ) : null}
    </Group>
  );
}

function ProviderDetail({ descriptor, health, onClose, onSaved }: { descriptor: ProviderDescriptor; health: ProviderHealth | undefined; onClose: () => void; onSaved: () => void }) {
  const provider = descriptor.provider;
  const { gated } = useHubUi();
  const config = useResource('providersConfigGet', { params: { provider } }, { enabled: !gated });

  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const save = useAction(async (body: Record<string, unknown>) => api('providersConfigPut', { params: { provider }, body }));
  const test = useAction(async () => api('providersTest', { params: { provider } }));

  const current = config.data as ProviderAppConfigView | null;
  const required = new Set(current?.missing ?? []);
  const wants = {
    clientId: required.has('clientId') || Boolean(current?.clientId),
    clientSecret: required.has('clientSecret') || Boolean(current?.clientSecretHint),
    apiKey: required.has('apiKey') || Boolean(current?.apiKeyHint),
    contactEmail: provider === 'musicbrainz',
  };
  const isOn = enabled ?? current?.enabled ?? descriptor.enabled;

  const submit = useCallback(
    async () => {
      setMessage('Saving…');
      const body: Record<string, unknown> = { enabled: isOn };
      // An empty secret field means "leave what is stored alone", never "clear it".
      if (clientId.trim()) body['clientId'] = clientId.trim();
      if (clientSecret.trim()) body['clientSecret'] = clientSecret.trim();
      if (apiKey.trim()) body['apiKey'] = apiKey.trim();
      if (contactEmail.trim()) body['contactEmail'] = contactEmail.trim();
      const saved = await save.run(body);
      if (!saved) {
        setMessage(null);
        return;
      }
      setClientSecret('');
      setApiKey('');
      config.reload();
      onSaved();
      if (!isOn) {
        setMessage('Saved. It is off.');
        return;
      }
      setMessage('Saved. Testing…');
      const result = (await test.run()) as { ok: boolean; message: string } | null;
      setMessage(result ? `Saved. ${result.message}` : 'Saved, but the test could not run.');
      onSaved();
    },
    [isOn, clientId, clientSecret, apiKey, contactEmail, save, test, config, onSaved],
  );

  const status = PROVIDER_STATUS[health?.status ?? (descriptor.enabled ? 'ok' : 'disabled')] ?? PROVIDER_STATUS.down;
  const id = `prov-${provider}`;
  // Opened under its row: bring it into view and move the caret to its heading, so the next Tab
  // reaches its first field and a screen reader says what opened.
  const box = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView?.({ block: 'nearest' });
    heading.current?.focus();
  }, []);

  return (
    // Escape closes the details from anywhere inside them, as it closes the sheet.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className="tile detail"
      ref={box}
      id={`prov-detail-${provider}`}
      role="region"
      aria-label={`${descriptor.displayName} details`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <h3 ref={heading} tabIndex={-1}>
        {descriptor.displayName} <span className="sub">· {PROVIDER_ROLES[descriptor.role] ?? descriptor.role} · {status.word}</span>
      </h3>
      {descriptor.capabilities.reason ? <p className="detail__text">{descriptor.capabilities.reason}</p> : null}
      {health?.lastError ? <p className="detail__text">Last problem: {health.lastError}</p> : null}
      <p className="caps detail__caps">
        {CAPABILITY_LABELS.map(([key, label]) => (
          <Cap key={key} label={label} state={String(descriptor.capabilities[key])} />
        ))}
      </p>
      {descriptor.limitations.length ? (
        <ul className="detail__list">
          {descriptor.limitations.map((limitation, i) => (
            <li key={i}>{limitation}</li>
          ))}
        </ul>
      ) : null}
      <p className="sub detail__meta">
        {[descriptor.rateStrategy ? `Limits: ${descriptor.rateStrategy}` : null, descriptor.attribution ? `Credit: ${descriptor.attribution}` : null, health?.quota ? `Used ${health.quota.used} of ${health.quota.budget} ${health.quota.unit} today` : null]
          .filter(Boolean)
          .join(' · ')}
        {descriptor.docsUrl ? (
          <>
            {' '}
            <a href={descriptor.docsUrl} target="_blank" rel="noreferrer noopener">
              {descriptor.displayName}’s documentation
            </a>
          </>
        ) : null}
      </p>

      {gated ? (
        <Note>Choose a real password first. Then this provider can be set up.</Note>
      ) : !current ? (
        <Note bad={Boolean(config.error)}>{config.error ? 'Its settings could not be read. Close this and open it again.' : 'Loading its settings…'}</Note>
      ) : (
        // Not a <form>: the design's default button is blue because it stands outside one.
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions
        <div
          className="pref detail__form"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type !== 'checkbox') void submit();
          }}
        >
          <span className="k" />
          <div className="v">
            <Check checked={isOn} onChange={setEnabled}>
              {descriptor.role === 'tool' ? 'Turn on, for content I own or may download' : 'Use this provider'}
            </Check>
          </div>
          {wants.clientId ? (
            <>
              <label className="k" htmlFor={`${id}-cid`}>
                Client ID:
              </label>
              <div className="v">
                <Field id={`${id}-cid`} mono value={clientId} placeholder={current.clientId ?? ''} onChange={(e) => setClientId(e.currentTarget.value)} />
              </div>
            </>
          ) : null}
          {wants.clientSecret ? (
            <>
              <label className="k" htmlFor={`${id}-secret`}>
                Client secret:
              </label>
              <div className="v">
                <Field id={`${id}-secret`} mono type="password" value={clientSecret} onChange={(e) => setClientSecret(e.currentTarget.value)} />
                <span className="sub">{current.clientSecretHint ? `One is stored (${current.clientSecretHint}). Leave this empty to keep it.` : 'Encrypted when stored, and never shown again.'}</span>
              </div>
            </>
          ) : null}
          {wants.apiKey ? (
            <>
              <label className="k" htmlFor={`${id}-key`}>
                API key:
              </label>
              <div className="v">
                <Field id={`${id}-key`} mono type="password" value={apiKey} onChange={(e) => setApiKey(e.currentTarget.value)} />
                <span className="sub">{current.apiKeyHint ? `One is stored (${current.apiKeyHint}). Leave this empty to keep it.` : 'Encrypted when stored, and never shown again.'}</span>
              </div>
            </>
          ) : null}
          {wants.contactEmail ? (
            <>
              <label className="k" htmlFor={`${id}-mail`}>
                Contact email:
              </label>
              <div className="v">
                <Field id={`${id}-mail`} type="email" value={contactEmail} placeholder={current.contactEmail ?? ''} onChange={(e) => setContactEmail(e.currentTarget.value)} />
                <span className="sub">MusicBrainz slows requests that name no contact. It is sent with each request and nowhere else.</span>
              </div>
            </>
          ) : null}
          <span className="k" />
          <div className="v">
            <Push primary busy={save.busy || test.busy} onClick={() => void submit()}>
              Save and Test
            </Push>
            <Push onClick={onClose}>Close</Push>
            <span className="note note--inline" role="status">
              {message ?? (current.missing.length ? `Still needed: ${current.missing.map((m) => FIELD_WORDS[m] ?? m).join(', ')}.` : '')}
            </span>
          </div>
        </div>
      )}
      {current ? null : (
        <div className="barrow">
          <Push onClick={onClose}>Close</Push>
        </div>
      )}
      <ActionError error={save.error ?? test.error} />
    </div>
  );
}

const FIELD_WORDS: Record<string, string> = { clientId: 'the client ID', clientSecret: 'the client secret', apiKey: 'the API key', contactEmail: 'a contact email', applicationId: 'the application ID', redirectUri: 'the redirect address' };
