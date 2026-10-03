/**
 * Backup, restore, export and import.
 *
 * The design's pane: where backups go (a folder inside the data volume) and how much room is there
 * (measured, never guessed), what each backup holds, how often one is taken and how many are kept,
 * then the archives with Download and Restore, and Back Up Now. The settings change nothing until
 * Save; Revert puts back what the hub has. Restore and Import ask first and say what they will do,
 * because they are the two actions here that replace data.
 */
import { useCallback, useState } from 'react';
import type { BackupSettings, BackupSettingsView, BackupSpace } from '@now-playing/contracts';
import { api, apiUrl } from '../lib/api.js';
import { useAction, useResource } from '../lib/hooks.js';
import { ActionError, Ago, Check, count, EmptyCells, Field, formatBytes, Group, listState, Note, Pop, Push, useHubUi } from '../ui.js';

interface BackupEntry {
  id: string;
  createdAt: string;
  sizeBytes: number;
  relativePath: string;
}

interface ImportReport {
  dryRun: boolean;
  applied: Record<string, number>;
  errors: string[];
}

const PARTS: ReadonlyArray<readonly [keyof BackupSettings['include'], string]> = [
  ['credentials', 'Provider sign-ins and the Discord bot token'],
  ['activity', 'The audit log and the hub’s statistics'],
  ['caches', 'Looked-up details, which the hub can fetch again'],
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const KEEP_CHOICES = [4, 8, 10, 20, 0];

function saveFile(data: unknown, name: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** What a draft says is wrong, or null. The hub checks the folder again when it saves. */
export function backupProblem(draft: BackupSettings & { folder: string }, dataDir: string): string | null {
  const folder = draft.folder.trim().replaceAll('\\', '/');
  const relative = folder.startsWith(`${dataDir}/`) ? folder.slice(dataDir.length + 1) : folder;
  if (!relative || relative === dataDir || relative.startsWith('/') || /^[a-z]:/i.test(relative) || relative.split('/').includes('..')) return `Use a folder inside the data volume, such as ${dataDir}/backups.`;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.schedule.time)) return 'Use a time such as 03:00.';
  return null;
}

function whenText(view: BackupSettingsView): string {
  if (view.schedule.frequency === 'off') return 'Only when you click Back Up Now.';
  if (!view.nextRunAt) return 'Not scheduled.';
  return `Next one ${new Date(view.nextRunAt).toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.`;
}

export function BackupView() {
  const backups = useResource('backupList', {}, { pollMs: 30_000 });
  const space = useResource('backupSpace', {}, { pollMs: 60_000 });
  const settings = useResource('backupSettingsGet');
  const { say, confirm } = useHubUi();
  const create = useAction(async () => api('backupCreate'));
  const restore = useAction(async (backupId: string) => api('backupRestore', { params: { backupId }, body: { confirm: true } }));
  const importAll = useAction(async (payload: { schemaVersion: number; data: Record<string, unknown> }, dryRun: boolean) => api('importAll', { query: { dryRun }, body: payload }));
  const saveSettings = useAction(async (body: Partial<BackupSettings>) => api('backupSettingsPut', { body }));
  const [report, setReport] = useState<ImportReport | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [draft, setDraft] = useState<(BackupSettings & { folder: string }) | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const exportNow = useAction(async () => {
    const data = await api('exportAll');
    saveFile(data, `airwave-hub-export-${new Date().toISOString().slice(0, 10)}.json`);
    return data;
  });

  const pickFile = useCallback(
    (dryRun: boolean) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        setFileProblem(null);
        let parsed: { schemaVersion: number; data: Record<string, unknown> };
        try {
          parsed = JSON.parse(await file.text()) as typeof parsed;
          if (typeof parsed?.schemaVersion !== 'number' || typeof parsed.data !== 'object') throw new Error('not an export');
        } catch {
          setFileProblem('That file isn’t an Airwave Hub export. Choose a file made with Export.');
          return;
        }
        if (!dryRun && !(await confirm({ title: `Import ${file.name}?`, text: 'Its groups, history, playlists and presets are added to this hub. Devices are not imported and pair again.', verb: 'Import' }))) return;
        const result = (await importAll.run(parsed, dryRun)) as ImportReport | null;
        if (result) {
          setReport(result);
          say(dryRun ? 'Checked the file. Nothing was written.' : 'Import finished.');
        }
      };
      input.click();
    },
    [importAll, say, confirm],
  );

  const items = (backups.data as { items: BackupEntry[] } | null)?.items ?? [];
  const state = listState(backups, (d) => (d as { items: BackupEntry[] }).items.length === 0, 'No backups yet.');
  const sp = space.data as BackupSpace | null;
  const view = settings.data as BackupSettingsView | null;
  const dataDir = (view?.dataDir ?? '/data').replaceAll('\\', '/').replace(/\/+$/, '');
  const stored = view ? { location: view.location, include: view.include, schedule: view.schedule, keep: view.keep, folder: `${dataDir}/${view.location}` } : null;
  const current = draft ?? stored;
  const edit = (patch: Partial<BackupSettings & { folder: string }>): void => {
    if (!current) return;
    setDraft({ ...current, ...patch });
    setProblem(null);
  };

  const known = sp !== null && sp.freeBytes !== null && sp.totalBytes !== null && sp.totalBytes > 0;
  const next = sp?.lastArchiveBytes ?? 0;
  const used = known ? sp.totalBytes! - sp.freeBytes! : 0;
  const short = known && next > sp.freeBytes!;
  const usedPercent = known ? (used / sp.totalBytes!) * 100 : 0;
  const nextPercent = known ? Math.max(0.6, Math.min(100 - usedPercent, (next / sp.totalBytes!) * 100)) : 0;

  const save = async (): Promise<void> => {
    if (!draft) return;
    const why = backupProblem(draft, dataDir);
    setProblem(why);
    if (why) return;
    const folder = draft.folder.trim().replaceAll('\\', '/');
    const body: Partial<BackupSettings> = { include: draft.include, schedule: draft.schedule, keep: draft.keep };
    if (!view?.locationFixed) body.location = folder.startsWith(`${dataDir}/`) ? folder.slice(dataDir.length + 1) : folder;
    const saved = (await saveSettings.run(body)) as BackupSettingsView | null;
    if (!saved) return;
    setDraft(null);
    settings.reload();
    space.reload();
    backups.reload();
    say(`Saved. ${whenText(saved)}`);
  };

  return (
    <Group title="Backup">
      <div className="pref">
        <label className="k" htmlFor="bkPath">
          Save backups to:
        </label>
        <div className="v">
          {view?.locationFixed ? (
            <>
              <span className="path">{view.path}</span>
              <span className="sub">Set by NP_BACKUP_DIR in the container’s environment, so it is changed there.</span>
            </>
          ) : (
            <>
              <Field id="bkPath" mono value={current?.folder ?? ''} disabled={!current} invalid={Boolean(problem?.startsWith('Use a folder'))} placeholder={`${dataDir}/backups`} onChange={(e) => edit({ folder: e.currentTarget.value })} />
              <span className="sub">A folder inside the container’s data volume, so whatever backs up the volume backs these up too. Archives already in the old folder stay there.</span>
            </>
          )}
        </div>
        <span className="k top">Space:</span>
        <div className="v stack">
          {known ? (
            <>
              <span>
                <b>{formatBytes(sp.freeBytes)} free</b> of {formatBytes(sp.totalBytes)} · {sp.lastArchiveBytes === null ? 'the size of a backup is known once one exists' : `each backup is about ${formatBytes(sp.lastArchiveBytes)}`}
              </span>
              <div className={`bar spacebar${short ? ' is-short' : ''}`} role="img" aria-label={`${formatBytes(used)} used, ${formatBytes(sp.freeBytes)} free${sp.lastArchiveBytes === null ? '' : `, the next backup about ${formatBytes(next)}`}`}>
                <i className="used" style={{ width: `${usedPercent}%` }} />
                {sp.lastArchiveBytes === null ? null : <i className="this" style={{ left: `${usedPercent}%`, width: `${nextPercent}%` }} />}
              </div>
              {short ? (
                <span className="note note--bad note--row" role="alert">
                  The next backup is not expected to fit. Free some space on the data volume first.
                </span>
              ) : null}
            </>
          ) : (
            <span className="sub">{sp ? 'The free space here could not be measured. The folder may not exist yet.' : space.error ? 'The free space could not be read.' : 'Measuring…'}</span>
          )}
        </div>
        <span className="k top">Include:</span>
        <div className="v stack" role="group" aria-label="What each backup includes">
          <Check checked disabled onChange={() => undefined}>
            Settings, devices, groups, playlists, profiles and the library index
          </Check>
          {PARTS.map(([part, label]) => (
            <Check key={part} checked={current?.include[part] ?? true} disabled={!current} onChange={(on) => current && edit({ include: { ...current.include, [part]: on } })}>
              {label}
            </Check>
          ))}
        </div>
        <label className="k" htmlFor="bkWhen">
          How often:
        </label>
        <div className="v">
          <Pop id="bkWhen" value={current?.schedule.frequency ?? 'daily'} disabled={!current} onChange={(e) => current && edit({ schedule: { ...current.schedule, frequency: e.currentTarget.value as BackupSettings['schedule']['frequency'] } })}>
            <option value="off">Only when I click Back Up Now</option>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
          </Pop>
          {current && current.schedule.frequency === 'weekly' ? (
            <Pop aria-label="On" value={String(current.schedule.weekday)} onChange={(e) => edit({ schedule: { ...current.schedule, weekday: Number(e.currentTarget.value) } })}>
              {WEEKDAYS.map((day, i) => (
                <option key={day} value={i}>
                  on {day}
                </option>
              ))}
            </Pop>
          ) : null}
          {current && current.schedule.frequency !== 'off' ? (
            <>
              <span className="note note--inline">at</span>
              <Field aria-label="At" type="time" className="num field--time" value={current.schedule.time} invalid={Boolean(problem?.startsWith('Use a time'))} onChange={(e) => edit({ schedule: { ...current.schedule, time: e.currentTarget.value } })} />
            </>
          ) : null}
          <span className="sub">{view ? `${whenText(view)} Times are on the hub’s clock.` : ''}</span>
        </div>
        <label className="k" htmlFor="bkKeep">
          Keep:
        </label>
        <div className="v">
          <Pop id="bkKeep" value={String(current?.keep ?? 10)} disabled={!current} onChange={(e) => edit({ keep: Number(e.currentTarget.value) })}>
            {[...new Set([...KEEP_CHOICES, current?.keep ?? 10])].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? 'All of them' : `The last ${n}`}
              </option>
            ))}
          </Pop>
          <span className="sub">Of the scheduled backups; the oldest go first. Ones you make with Back Up Now are kept until you remove them from the folder.</span>
        </div>
        <span className="k" />
        <div className="v">
          <Push primary busy={saveSettings.busy} disabled={draft === null} reason="Nothing has changed." onClick={() => void save()}>
            Save
          </Push>
          <Push
            disabled={draft === null}
            reason="Nothing has changed."
            onClick={() => {
              setDraft(null);
              setProblem(null);
              saveSettings.clearError();
            }}
          >
            Revert
          </Push>
        </div>
      </div>
      {problem ? <Note bad>{problem}</Note> : <ActionError error={saveSettings.error ?? (settings.error && !view ? settings.error : null)} />}

      <div className="well well--after">
        <table className="tbl" aria-label="Backups">
          <colgroup>
            <col />
            <col style={{ width: '18%' }} className="hide-sm" />
            <col style={{ width: '14%' }} />
            <col style={{ width: 196 }} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Archive</th>
              <th scope="col" className="hide-sm">
                Taken
              </th>
              <th scope="col" className="num">
                Size
              </th>
              <th scope="col">
                <span className="sr">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {state ? <EmptyCells columns={4} {...state} /> : null}
            {state
              ? null
              : items.map((row) => (
                  <tr key={row.id}>
                    <td className="mono" title={row.relativePath}>
                      {row.relativePath}
                    </td>
                    <td className="hide-sm">
                      <Ago iso={row.createdAt} />
                    </td>
                    <td className="num">{formatBytes(row.sizeBytes)}</td>
                    <td className="acts">
                      <a className="push push--link" href={apiUrl('backupDownload', { backupId: row.id })} download={`${row.id}.sqlite`} aria-label={`Download ${row.id}`}>
                        Download
                      </a>
                      <Push
                        busy={restore.busy}
                        aria-label={`Restore ${row.id}`}
                        onClick={() =>
                          void confirm({
                            title: 'Restore this backup?',
                            text: 'Everything on the hub goes back to how it was then. The current state is backed up first, then the hub restarts and is away for a few seconds.',
                            verb: 'Restore',
                          }).then((go) => {
                            if (!go) return;
                            void restore.run(row.id).then((r) => {
                              // No reload: the hub exits as soon as it has answered.
                              if (r) setRestarting((r as { safetyBackupId: string }).safetyBackupId);
                            });
                          })
                        }
                      >
                        Restore…
                      </Push>
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      <div className="barrow">
        <Push
          busy={create.busy}
          busyLabel="Backing Up…"
          disabled={short}
          reason="There isn’t room for another backup."
          onClick={() =>
            void create.run().then((r) => {
              if (!r) return;
              backups.reload();
              space.reload();
              say('Backup written.');
            })
          }
        >
          Back Up Now
        </Push>
        <Push busy={exportNow.busy} onClick={() => void exportNow.run().then((r) => r && say('Exported. The file is in your downloads.'))}>
          Export…
        </Push>
        <Push busy={importAll.busy} onClick={() => pickFile(true)}>
          Check an Export…
        </Push>
        <Push busy={importAll.busy} onClick={() => pickFile(false)}>
          Import…
        </Push>
      </div>
      {restarting ? (
        <Note>
          Restored. What was here before is saved as <span className="mono">{restarting}</span>. The hub is restarting; reload this page in a few seconds.
        </Note>
      ) : null}
      {fileProblem ? <Note bad>{fileProblem}</Note> : <ActionError error={restore.error ?? create.error ?? importAll.error ?? exportNow.error} />}
      {report ? (
        <div className="well well--after" role="status">
          <ul className="rows" aria-label={report.dryRun ? 'What the file would import' : 'What was imported'}>
            <li>
              <span className="grow">
                <b>{report.dryRun ? 'This file would import' : 'Imported'}</b>:{' '}
                {Object.entries(report.applied)
                  .map(([key, n]) => count(n, key.replace(/s$/, ''), key))
                  .join(', ') || 'nothing'}
                .
              </span>
            </li>
            {report.errors.map((e, i) => (
              <li key={i}>
                <span className="grow">{e}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {view?.include.credentials ? <Note>Provider sign-ins in a backup are encrypted with this hub’s installation key, which is not in the backup. Restore on this hub, or keep the key file with the archive and treat both like a password.</Note> : null}
      <Note>A backup is the hub’s whole database, taken while it keeps running. An export is a portable copy with no passwords, tokens or provider credentials, so it is safe to move between machines.</Note>
    </Group>
  );
}
