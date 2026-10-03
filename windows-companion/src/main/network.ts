/**
 * Which kind of connection this PC is on, for "Stream to your devices ▸ How devices may connect":
 * Wi-Fi and Ethernet, or a metered connection (mobile data, a phone's hotspot, or a network the
 * person marked metered in Windows).
 *
 * Windows knows this as the connection's *cost*, and the reliable way to read it from a program
 * that is not a packaged Windows app is the WinRT call `NetworkInformation.GetInternetConnectionProfile()
 * .GetConnectionCost()`. Node cannot call WinRT, so the companion asks Windows PowerShell — with
 * `execFile`, no shell, and one fixed script that takes no input: nothing from the network, the
 * person or the page can reach that command line. It answers one line,
 * `<NetworkCostType>|<Roaming>|<OverDataLimit>|<IsWwan>`, or `none` when there is no connection.
 *
 * The decision itself (`streamingDecision`) and the reading of that line (`classifyCost`) are
 * pure, and tested on their own.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { NetworkKind } from '../shared/ipc.js';

/** The whole script. A constant: there is nothing to interpolate, so nothing can be injected. */
export const COST_SCRIPT =
  "$ErrorActionPreference='Stop';" +
  '$p=[Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]::GetInternetConnectionProfile();' +
  "if($null -eq $p){'none'}else{$c=$p.GetConnectionCost();'{0}|{1}|{2}|{3}' -f $c.NetworkCostType,$c.Roaming,$c.OverDataLimit,$p.IsWwanConnectionProfile}";

/**
 * What PowerShell's line means. `Fixed` and `Variable` are what Windows calls a metered connection;
 * roaming, being over a data limit, and a mobile-broadband (WWAN) profile count as metered whatever
 * the cost type says. `Unrestricted` is Wi-Fi or Ethernet as most homes have them.
 */
export function classifyCost(output: string): NetworkKind {
  const line = output.trim().split(/\r?\n/).pop()?.trim() ?? '';
  if (line === 'none') return 'offline';
  const [cost, roaming, over, wwan] = line.split('|').map((part) => part.trim().toLowerCase());
  if (!cost) return 'unknown';
  if (roaming === 'true' || over === 'true' || wwan === 'true') return 'metered';
  if (cost === 'fixed' || cost === 'variable') return 'metered';
  if (cost === 'unrestricted') return 'unmetered';
  return 'unknown';
}

/**
 * Whether streaming may serve on this connection, and if not, the sentence the Remote tab shows.
 * An unknown connection is treated as Wi-Fi or Ethernet — the usual case on a PC — so a failed
 * look never switches streaming off by itself; offline has nothing to stream over anyway.
 */
export function streamingDecision(allowed: { unmetered: boolean; metered: boolean }, connection: NetworkKind): { allowed: boolean; reason: string | null } {
  if (connection === 'metered') {
    return allowed.metered ? { allowed: true, reason: null } : { allowed: false, reason: 'Paused: this PC is on a metered connection (mobile data or a hotspot), and streaming on metered connections is off.' };
  }
  if (connection === 'offline') return { allowed: true, reason: null };
  return allowed.unmetered ? { allowed: true, reason: null } : { allowed: false, reason: 'Paused: this PC is on Wi-Fi or Ethernet, and streaming on Wi-Fi and Ethernet is off.' };
}

/**
 * Asks Windows what this connection costs. Anything but Windows, and any failure, is `unknown`. Takes
 * a few seconds the first time PowerShell starts, so callers never wait on it for anything else.
 */
export function probeConnection(options: { timeoutMs?: number } = {}): Promise<NetworkKind> {
  if (process.platform !== 'win32') return Promise.resolve('unknown');
  // Windows PowerShell by its full path, so a `powershell.exe` earlier on PATH is never what runs.
  const root = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'] ?? 'C:\\Windows';
  const exe = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve) => {
    execFile(exe, ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', COST_SCRIPT], { windowsHide: true, timeout: options.timeoutMs ?? 30_000, shell: false }, (error, stdout) => {
      resolve(error ? 'unknown' : classifyCost(String(stdout)));
    });
  });
}
