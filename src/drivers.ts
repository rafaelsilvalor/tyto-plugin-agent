import type { FormConfigurationContribution, PluginHost } from '@tyto/plugin-api';

/**
 * The agents this plugin can talk to. Each one is a program the manifest names as
 * `process:<program>` (Tyto ADR 0182): one more agent is one more row here and one more line the
 * person approves at install, never a wider grant.
 *
 * Only Claude ships in 0.1.0. Codex (`@agentclientprotocol/codex-acp`, program `codex-acp`) and
 * Gemini CLI (`gemini --acp`) speak the same protocol and are rows to add once tested.
 */
export interface Driver {
  readonly id: string;
  /** What the panel calls it. */
  readonly label: string;
  /** The program, exactly as `process:<program>` names it. */
  readonly program: string;
  /** Arguments always passed, before the person's own `agent.args`. */
  readonly args: readonly string[];
  /**
   * The program is this plugin's launcher (`adapter/launch.mjs`, Tyto ADR 0184 `programs`), which
   * fetches the agent's adapter from npm on first use (TYTO-666): the panel asks it what is
   * installed before it starts a conversation, and offers the download.
   */
  readonly downloads: boolean;
  /**
   * The sign-in the panel prefers among the agent's own terminal methods (ACP `authMethods` of
   * type `terminal`, read from `initialize`). The arguments always come from the agent, so they
   * follow its version; a missing id falls back to its first terminal method.
   */
  readonly preferredLogin?: string;
  /**
   * How this agent says which MCP servers its session ended up with, when it can. ACP has no
   * message for it, so it is the adapter's own extension, and an agent without one is never
   * checked (Tyto's tools may be missing, and the panel cannot tell).
   */
  readonly serverReport?: ServerReport;
  /**
   * How this agent says it is signed out before a turn fails, when it can: an extension
   * notification read for its kind only. The panel then offers Log in when it opens, not after
   * the first message.
   */
  readonly authReport?: AuthReport;
}

export interface AuthReport {
  readonly notification: string;
  /** `true` signed out, `false` signed in, `undefined` when this notification does not say. */
  signedOut(params: unknown): boolean | undefined;
}

/**
 * Claude's adapter sends `_auth/status_update` after `initialize` (measured with 0.102.0 on
 * 2026-11-10, in a signed-out profile: `authStatus.kind` is `none`; signed in it is `account`).
 * Only the kind is read: the notification also names the account, which is never kept or logged.
 */
const CLAUDE_AUTH_REPORT: AuthReport = {
  notification: '_auth/status_update',
  signedOut(params) {
    const kind = (params as { authStatus?: { kind?: unknown } } | null)?.authStatus?.kind;
    if (kind === 'none') return true;
    return typeof kind === 'string' ? false : undefined;
  },
};

/** One MCP server as the agent reports it: its name, and how its connection went. */
export interface ReportedServer {
  readonly name: string;
  readonly status: string;
}

export interface ServerReport {
  /** Merged into `session/new` as `_meta`: the adapter's opt-in to send the report. */
  readonly sessionMeta: Record<string, unknown>;
  /** The notification that carries the report. */
  readonly notification: string;
  /** The servers it names, or `undefined` when this notification is not the report. */
  servers(params: unknown): readonly ReportedServer[] | undefined;
}

/**
 * Claude's adapter forwards Claude Code's own messages on request (`_meta.claudeCode
 * .emitRawSDKMessages` in `session/new`, as `_claude/sdkMessage`; read in
 * `@agentclientprotocol/claude-agent-acp` 0.102.0). The `system`/`init` message lists the
 * session's MCP servers with their status. Claude Code sends it when a turn starts, so the
 * check runs on the first turn, not when the session is created. A server Claude Code's
 * settings do not allow (`allowedMcpServers`) is not in it at all: Claude Code drops it before
 * starting it, and says nothing.
 */
const CLAUDE_SERVER_REPORT: ServerReport = {
  sessionMeta: { claudeCode: { emitRawSDKMessages: [{ type: 'system', subtype: 'init' }] } },
  notification: '_claude/sdkMessage',
  servers(params) {
    const message = (params as { message?: Record<string, unknown> } | null)?.message;
    if (message?.['type'] !== 'system' || message['subtype'] !== 'init') return undefined;
    const servers = message['mcp_servers'];
    if (!Array.isArray(servers)) return [];
    return servers
      .filter(
        (server): server is { name: string; status?: unknown } =>
          typeof (server as { name?: unknown } | null)?.name === 'string',
      )
      .map((server) => ({
        name: server.name,
        status: typeof server.status === 'string' ? server.status : '',
      }));
  },
};

export const DRIVERS: readonly Driver[] = [
  {
    id: 'claude',
    label: 'Claude',
    // The ACP adapter for Claude Code, which drives the person's own `claude` CLI and its login:
    // github.com/agentclientprotocol/claude-agent-acp. Fetched from npm on first use at the
    // version adapter/lock.json pins, never committed (TYTO-666).
    program: 'claude-agent-acp',
    args: [],
    downloads: true,
    // The adapter's subscription sign-in: it runs the Claude CLI's own login (TYTO-657).
    preferredLogin: 'claude-ai-login',
    serverReport: CLAUDE_SERVER_REPORT,
    authReport: CLAUDE_AUTH_REPORT,
  },
];

export const SETTINGS: readonly FormConfigurationContribution[] = [
  {
    id: 'agent',
    form: { type: 'string', enum: DRIVERS.map((driver) => driver.id) },
    default: 'claude',
    description: 'Which agent the panel talks to.',
    options: DRIVERS.map((driver) => ({ value: driver.id, description: driver.label })),
  },
  {
    id: 'args',
    form: { type: 'array', items: { type: 'string', minLength: 1 } },
    default: [],
    description:
      "Extra arguments for the agent's program, after the ones the plugin passes. Tyto refuses an argument with a quote, %, ^, &, |, <, >, (, ) or ! in it.",
  },
];

/** The schema `host.config` asks for, typed off the host so the plugin bundles no Zod. */
type ConfigSchema = Parameters<PluginHost['config']>[0];

/**
 * The plugin's record as the host resolved it. The host has already replaced a value its form
 * refused with the default, so only the shape is left to check here.
 */
const RAW_RECORD = {
  safeParse: (value: unknown) => ({ success: true as const, data: value }),
} as unknown as ConfigSchema;

export interface AgentChoice {
  readonly driver: Driver;
  readonly args: readonly string[];
}

/** The agent the settings name, read on every start so a change applies to the next one. */
export function chosenAgent(host: Pick<PluginHost, 'config'>): AgentChoice {
  const raw = host.config(RAW_RECORD) as { agent?: unknown; args?: unknown } | undefined;
  const driver = DRIVERS.find((candidate) => candidate.id === raw?.agent) ?? DRIVERS[0]!;
  const extra = Array.isArray(raw?.args)
    ? raw.args.filter((arg): arg is string => typeof arg === 'string' && arg !== '')
    : [];
  return { driver, args: [...driver.args, ...extra] };
}
