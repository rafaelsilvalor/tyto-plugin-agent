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
  /** The program on the person's PATH, exactly as `process:<program>` names it. */
  readonly program: string;
  /** Arguments always passed, before the person's own `agent.args`. */
  readonly args: readonly string[];
  /** What the person runs to install the program, shown when it is missing. */
  readonly install: readonly string[];
  /** What the person runs to sign in, shown when the agent asks for authentication. */
  readonly login: readonly string[];
}

export const DRIVERS: readonly Driver[] = [
  {
    id: 'claude',
    label: 'Claude',
    // The ACP adapter for Claude Code (Apache-2.0), which drives the person's own `claude` CLI
    // and its login: github.com/agentclientprotocol/claude-agent-acp.
    program: 'claude-agent-acp',
    args: [],
    install: ['npm install -g @agentclientprotocol/claude-agent-acp'],
    login: ['claude', '/login'],
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
