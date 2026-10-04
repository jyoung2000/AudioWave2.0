export function sourceFingerprint(root: string): string;
export function shellHash(text: string): string;
export interface ShellShots {
  source: string;
  sourceHash: string;
  takenAt?: string;
  files?: string[];
}
export function checkShellShots(input: {
  record: ShellShots | null;
  source: string;
  present: (file: string) => boolean;
}): string[];
export function rootProperties(css: string): Record<string, string>;
export function darkProperties(css: string): Record<string, string>;
export function normalizeCssValue(value: string | number): string;
export function unionMembers(source: string, typeName: string): string[];
export interface TokenMap {
  defaults: Record<string, string[]>;
  map: Record<
    string,
    { var?: string; literal?: string; file?: string; note?: string; exception?: string }
  >;
}
export function checkTokens(input: {
  tokens: Record<string, unknown>;
  map: TokenMap;
  sheets: Record<string, string>;
}): { errors: string[]; exceptions: string[]; checked: number };
export interface CheckSummary {
  rules: number;
  surfaces: number;
  flows: number;
  discovered: number;
  discordCommands: number;
  tokensChecked: number;
  tokenExceptions: number;
  runtimeVerified: number;
  mockups: number;
  fingerprint: string | null;
}
export function runChecks(
  root: string,
  options?: { freshness?: boolean },
): { errors: string[]; notes: string[]; summary: CheckSummary };
