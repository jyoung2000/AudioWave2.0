/** Files the styleguide shows as they are: icons, the decisions log. */
declare module '*?raw' {
  const text: string;
  export default text;
}

/** Computed by vite.config.ts at build time from scripts/styleguide-lib.mjs. */
declare const __STYLEGUIDE_BUILD__: {
  fingerprint: string;
  summary: {
    rules: number;
    surfaces: number;
    flows: number;
    discovered: number;
    discordCommands: number;
    tokensChecked: number;
    tokenExceptions: number;
    runtimeVerified: number;
    mockups: number;
  };
  notes: string[];
  problems: number;
  scheme: Array<{ name: string; light: string; dark: string }>;
  /** Read from the products' source at build time: see `usage()` in vite.config.ts. */
  usage: {
    library: Array<{ name: string; player: boolean; hub: boolean; companion: boolean }>;
    kits: { hub: string[]; companion: string[] };
  };
};
