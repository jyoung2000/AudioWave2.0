/** The served Player’s paired Hub identity; never a Companion/helper credential. */
export interface HubAccount {
  base: string;
  credentialId: string;
  secret: string;
  hubName?: string;
  scopes?: string[];
}

type ShellKv = { get(key: string): Promise<unknown> };

export async function hubAccount(): Promise<HubAccount | null> {
  const kv = (window as unknown as { kv?: ShellKv }).kv;
  if (!kv?.get) return null;
  try {
    const v = (await kv.get('player:hub')) as Partial<HubAccount> | null;
    return v && typeof v.base === 'string' && v.credentialId && v.secret ? (v as HubAccount) : null;
  } catch {
    return null;
  }
}
