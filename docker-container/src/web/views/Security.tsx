/** The signed-in admin can change the password again without resetting the Hub. */
import { useState, type FormEvent } from 'react';
import type { SessionInfo } from '@now-playing/contracts';
import { api, setCsrfToken } from '../lib/api.js';
import { useAction } from '../lib/hooks.js';
import { ActionError, Field, Group, Note, Push } from '../ui.js';

export function SecurityView({ onSessionChanged }: { onSessionChanged: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const change = useAction(async (currentPassword: string, newPassword: string) =>
    api('authChangePassword', { body: { currentPassword, newPassword } }),
  );

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSaved(false);
    const why = !current ? 'Type the current password.' : next.length < 12 ? 'Use at least 12 characters.' : next !== again ? 'The two don’t match.' : null;
    setProblem(why);
    if (why) return;
    const result = (await change.run(current, next)) as SessionInfo | null;
    if (!result) return;
    setCurrent('');
    setNext('');
    setAgain('');
    setCsrfToken(result.csrfToken ?? null);
    setSaved(true);
    onSessionChanged();
  };

  return (
    <Group title="Change admin password" hint="The signed-in administrator can change the password at any time. You’ll need the current one. Changing it signs out other admin sessions; paired devices keep their own credentials.">
      <form onSubmit={(event) => void submit(event)} noValidate>
        <div className="pref">
          <label className="k" htmlFor="security-current">Current password:</label>
          <div className="v"><Field id="security-current" type="password" value={current} autoComplete="current-password" onChange={(event) => setCurrent(event.currentTarget.value)} /></div>
          <label className="k" htmlFor="security-next">New password:</label>
          <div className="v"><Field id="security-next" type="password" value={next} autoComplete="new-password" onChange={(event) => setNext(event.currentTarget.value)} /></div>
          <label className="k" htmlFor="security-again">Confirm new password:</label>
          <div className="v"><Field id="security-again" type="password" value={again} autoComplete="new-password" onChange={(event) => setAgain(event.currentTarget.value)} /></div>
          <span className="k" />
          <div className="v"><Push type="submit" primary busy={change.busy} busyLabel="Changing…">Change Password</Push></div>
        </div>
        {problem ? <Note bad>{problem}</Note> : <ActionError error={change.error} />}
        {saved ? <p className="note" role="status">Password changed. Other admin sessions have been signed out.</p> : null}
      </form>
    </Group>
  );
}
