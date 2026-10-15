import { describe, expect, it } from 'vitest';
import { spotdlYtDlpArgs, withYtDlpJsRuntime } from '@now-playing/domain/tool-install';

describe('YouTube JavaScript runtime arguments', () => {
  it('adds the app Node runtime before the URL separator without disturbing the protected URL', () => {
    const args = withYtDlpJsRuntime(['--ignore-config', '--dump-single-json', '--', 'https://youtube.com/watch?v=a'], 'C:/Program Files/Node/node.exe');
    expect(args).toEqual(['--ignore-config', '--dump-single-json', '--js-runtimes', 'node:C:/Program Files/Node/node.exe', '--', 'https://youtube.com/watch?v=a']);
  });

  it('does not add a second runtime when the command already names one', () => {
    const args = withYtDlpJsRuntime(['--ignore-config', '--js-runtimes', 'node', '--', 'https://youtube.com/watch?v=a'], 'C:/node.exe');
    expect(args.filter((arg) => arg === '--js-runtimes')).toHaveLength(1);
    expect(args).toContain('https://youtube.com/watch?v=a');
  });

  it('quotes the Node path safely when spotDL reparses its yt-dlp argument string', () => {
    const nodePath = 'C:\\Program Files\\Node\\node.exe';
    const args = spotdlYtDlpArgs(nodePath, ['--limit-rate', '2048K']);
    const quotedNode = nodePath.replaceAll('\\', '\\\\');
    expect(args).toBe(`"--limit-rate" "2048K" "--js-runtimes" "node:${quotedNode}"`);
  });
});
