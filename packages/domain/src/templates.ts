import { DISCORD_LIMITS, DISCORD_TEMPLATE_KEYS, DISCORD_TEMPLATE_VARIABLES, type DiscordTemplate, type DiscordTemplateKey, type DiscordTemplates } from '@now-playing/contracts';

const VAR_RE = /\{\{\s*([a-zA-Z]+)\s*\}\}/g;
const ZWSP = '​';

export interface TemplateCompileResult {
  errors: string[];
  warnings: string[];
  variablesUsed: string[];
}

/** Validate a template string: only allowlisted variables, balanced braces, length limits. */
export function validateTemplateText(text: string, limit: number): TemplateCompileResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const used = new Set<string>();
  if (text.length > limit) errors.push(`Template is longer than ${limit} characters`);
  for (const m of text.matchAll(VAR_RE)) {
    const name = m[1]!;
    if (!(DISCORD_TEMPLATE_VARIABLES as readonly string[]).includes(name)) errors.push(`Unknown variable {{${name}}}`);
    else used.add(name);
  }
  const stray = text.replace(VAR_RE, '').match(/\{\{|\}\}/g);
  if (stray) errors.push('Unbalanced {{ }} braces');
  if (/@everyone|@here/.test(text)) warnings.push('@everyone/@here will be escaped unless explicitly allowed');
  return { errors, warnings, variablesUsed: [...used] };
}

export interface MentionPolicy {
  allowEveryone?: boolean;
  allowedRoleIds?: readonly string[];
}

/** Escape mass mentions and non-allowlisted role mentions with a zero-width space. User mentions are neutralised too; pings are governed by allowed_mentions at send time. */
export function escapeMentions(text: string, policy: MentionPolicy = {}): string {
  let out = text;
  if (!policy.allowEveryone) out = out.replace(/@(everyone|here)/g, `@${ZWSP}$1`);
  out = out.replace(/<@&(\d+)>/g, (m, id: string) => (policy.allowedRoleIds?.includes(id) ? m : `<@${ZWSP}&${id}>`));
  out = out.replace(/<@!?(\d+)>/g, (_m, id: string) => `<@${ZWSP}${id}>`);
  return out;
}

/** Render a template with variables. Variable values are escaped; template text is trusted admin input but still escaped for mass mentions. */
export function renderTemplateText(text: string, vars: Record<string, string | number | null | undefined>, policy: MentionPolicy = {}): string {
  const rendered = text.replace(VAR_RE, (_m, name: string) => {
    const v = vars[name];
    return v === null || v === undefined ? '' : escapeMentions(String(v), {});
  });
  return escapeMentions(rendered, policy);
}

export interface RenderedTemplate {
  content: string;
  embedTitle: string | null;
  embedDescription: string | null;
  color: number | null;
  ephemeral: boolean;
  warnings: string[];
}

export function renderTemplate(template: DiscordTemplate, vars: Record<string, string | number | null | undefined>, policy: MentionPolicy = {}): RenderedTemplate {
  const warnings: string[] = [];
  const clip = (s: string | null, limit: number, what: string): string | null => {
    if (s === null) return null;
    if (s.length > limit) {
      warnings.push(`${what} truncated to ${limit} characters`);
      return s.slice(0, limit - 1) + '…';
    }
    return s;
  };
  return {
    content: clip(renderTemplateText(template.content, vars, policy), DISCORD_LIMITS.content, 'content') ?? '',
    embedTitle: clip(template.embedTitle === null ? null : renderTemplateText(template.embedTitle, vars, policy), DISCORD_LIMITS.embedTitle, 'embed title'),
    embedDescription: clip(template.embedDescription === null ? null : renderTemplateText(template.embedDescription, vars, policy), DISCORD_LIMITS.embedDescription, 'embed description'),
    color: template.color,
    ephemeral: template.ephemeral,
    warnings,
  };
}

export function validateTemplate(template: DiscordTemplate): TemplateCompileResult {
  const c = validateTemplateText(template.content, DISCORD_LIMITS.content);
  const t = template.embedTitle === null ? { errors: [], warnings: [], variablesUsed: [] } : validateTemplateText(template.embedTitle, DISCORD_LIMITS.embedTitle);
  const d = template.embedDescription === null ? { errors: [], warnings: [], variablesUsed: [] } : validateTemplateText(template.embedDescription, DISCORD_LIMITS.embedDescription);
  return { errors: [...c.errors, ...t.errors, ...d.errors], warnings: [...c.warnings, ...t.warnings, ...d.warnings], variablesUsed: [...new Set([...c.variablesUsed, ...t.variablesUsed, ...d.variablesUsed])] };
}

export function validateTemplates(templates: DiscordTemplates): Record<DiscordTemplateKey, TemplateCompileResult> {
  const out = {} as Record<DiscordTemplateKey, TemplateCompileResult>;
  for (const key of DISCORD_TEMPLATE_KEYS) {
    const t = templates.templates[key];
    out[key] = t ? validateTemplate(t) : { errors: [`Missing template ${key}`], warnings: [], variablesUsed: [] };
  }
  return out;
}

const AQUA_BLUE = 0x378dda;
const DANGER = 0xd64a44;
const SUCCESS = 0x4e9d47;
const WARNING = 0xd9a431;

function t(content: string, extra: Partial<DiscordTemplate> = {}): DiscordTemplate {
  return { content, embedTitle: null, embedDescription: null, color: null, ephemeral: false, ...extra };
}

export const DEFAULT_DISCORD_TEMPLATES: DiscordTemplates = {
  schemaVersion: 1,
  allowedMentionRoleIds: [],
  allowEveryone: false,
  templates: {
    success: t('Done.', { color: SUCCESS }),
    queued: t('', { embedTitle: 'Queued #{{position}}', embedDescription: '**{{title}}** — {{artist}}\nRequested by {{requester}} · {{duration}} · {{source}}', color: AQUA_BLUE }),
    nowPlaying: t('', { embedTitle: 'Now Playing', embedDescription: '**{{title}}** — {{artist}}\n{{album}}\nRequested by {{requester}} in {{group}}', color: AQUA_BLUE }),
    skipped: t('Skipped **{{title}}** ({{reason}}).', { color: WARNING }),
    permissionDenied: t("You don't have permission to do that ({{reason}}).", { color: DANGER, ephemeral: true }),
    noResults: t('No results for “{{reason}}”.', { ephemeral: true }),
    unavailableSource: t('**{{title}}** cannot be played here: {{reason}}.', { color: WARNING, ephemeral: true }),
    emptyQueue: t('The queue is empty. Use /play to add something.', { ephemeral: true }),
    joined: t('Joined {{channel}}.', { color: SUCCESS }),
    left: t('Left the voice channel.', { color: SUCCESS }),
    error: t('Something went wrong: {{reason}}', { color: DANGER, ephemeral: true }),
    wrongChannel: t('Music commands work in {{channel}}.', { ephemeral: true }),
    paused: t('Paused.', { color: WARNING }),
    resumed: t('Resumed.', { color: SUCCESS }),
    stopped: t('Stopped and cleared the queue.', { color: WARNING }),
    shuffled: t('Shuffled {{count}} tracks.', { color: SUCCESS }),
    cleared: t('Cleared {{count}} tracks from the queue.', { color: SUCCESS }),
  },
};
