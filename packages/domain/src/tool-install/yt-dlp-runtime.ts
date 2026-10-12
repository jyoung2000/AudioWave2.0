/**
 * yt-dlp 2025.11+ needs an explicitly enabled JavaScript runtime for full YouTube support.
 * The helper and hub supply their own Node executable; it is never taken from a request.
 */
function checkedRuntimePath(runtimePath: string): string {
  if (!runtimePath.trim() || [...runtimePath].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) throw new Error('A valid Node runtime path is required.');
  return runtimePath;
}

/** Insert the runtime before yt-dlp's `--` URL boundary; leave an explicit existing runtime alone. */
export function withYtDlpJsRuntime(args: readonly string[], runtimePath: string): string[] {
  const separator = args.indexOf('--');
  if (separator === args.length - 1) throw new Error('yt-dlp arguments must keep the URL after `--`.');
  if (args.includes('--js-runtimes')) return [...args];
  const runtime = checkedRuntimePath(runtimePath);
  if (separator < 0) return [args[0]!, '--js-runtimes', `node:${runtime}`, ...args.slice(1)];
  return [...args.slice(0, separator), '--js-runtimes', `node:${runtime}`, ...args.slice(separator)];
}

/**
 * spotDL accepts yt-dlp options as a shell-like string and re-parses it with shlex. Quote each token,
 * doubling backslashes so Windows executable paths with spaces survive that second parse as one token.
 */
export function spotdlYtDlpArgs(runtimePath: string, extraArgs: readonly string[] = []): string {
  const runtime = checkedRuntimePath(runtimePath);
  const args = [...extraArgs, '--js-runtimes', `node:${runtime}`];
  return args.map((arg) => `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(' ');
}
