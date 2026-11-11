import type { PluginHost, PluginProcess } from '@tyto/plugin-api';

import { AUTH_REQUIRED, type Connection, RpcError, connect } from './acp/connection.js';
import { type InstallOutcome, adapterStatus, installAdapter, megabytes } from './adapter.js';
import { type AgentChoice, chosenAgent } from './drivers.js';
import type { StatusLine } from './launcher/protocol.js';
import { type HistoryMessage, loadHistory, saveHistory } from './history.js';

/**
 * One conversation with the configured agent, over ACP, for the panel.
 *
 * A panel's call is a request and an answer, at most 30 s each, and nothing flows to the page on
 * its own (Tyto ADR 0173 decision 8). So a turn is started by one call and read by the next ones:
 * every update the agent streams becomes an entry with a number, and the page asks for the
 * entries after the last number it has (`read`), a few times a second.
 *
 * The program is started through the host (`process:<program>`, ADR 0182) in the folder Tyto
 * opened, which the host reports as `cwd` and which ACP's `session/new` needs. The window's MCP
 * server is handed to the agent in the same call (ADR 0183), so it sees the brief in front and
 * proposes edits the person approves.
 */

export type Entry =
  | { readonly seq: number; readonly kind: 'user'; readonly text: string }
  | { readonly seq: number; readonly kind: 'text'; readonly text: string }
  | { readonly seq: number; readonly kind: 'thought'; readonly text: string }
  | {
      readonly seq: number;
      readonly kind: 'tool';
      readonly id: string;
      readonly title: string;
      readonly status: string;
      /** Tyto's own tool's name (`check_brief`…), which the page names in its language. */
      readonly tyto?: string;
    }
  | {
      readonly seq: number;
      readonly kind: 'plan';
      readonly entries: readonly { readonly content: string; readonly status: string }[];
    }
  | {
      readonly seq: number;
      readonly kind: 'permission';
      readonly id: string;
      readonly title: string;
      readonly options: readonly PermissionOption[];
    }
  | {
      readonly seq: number;
      readonly kind: 'answered';
      readonly id: string;
      readonly name: string;
      readonly cancelled: boolean;
    }
  | {
      readonly seq: number;
      readonly kind: 'notice';
      readonly text: string;
      /** What the notice says, for the page to say it in its language; `text` is English. */
      readonly code?: NoticeCode;
      readonly params?: Readonly<Record<string, string>>;
    }
  | { readonly seq: number; readonly kind: 'end'; readonly reason: string }
  | ({ readonly seq: number; readonly kind: 'usage' } & TurnUsage);

/**
 * One API call's tokens and estimated cost (TYTO-661), and the month so far against the cap. Only
 * the API driver reports it: a subscription has no per-token price.
 */
export interface TurnUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** Dollars, as `dollars()` writes them. */
  readonly cost: string;
  readonly month: string;
  readonly cap: string;
}

export type NoticeCode =
  | 'agents-off'
  | 'ended'
  | 'not-started'
  | 'turn-failed'
  | 'cap-reached'
  | 'no-tools'
  | 'agent-lines'
  | 'max-tokens'
  | 'refused'
  | 'tool-loop';

export interface PermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: string;
}

/**
 * Why there is no agent to talk to, as the card names the states. `steps` are what the person
 * does about it, shown as they are.
 */
export interface Problem {
  readonly kind:
    | 'script-missing'
    | 'not-downloaded'
    | 'downloading'
    | 'download-failed'
    | 'no-claude'
    | 'old-tyto'
    | 'not-logged-in'
    | 'restricted'
    | 'no-programs'
    | 'exited'
    | 'failed'
    | 'no-tools'
    | 'no-key'
    | 'bad-key'
    | 'no-api-agents'
    | 'api-old-tyto'
    | 'ledger';
  /** In English; the page says it in its language from `kind` and `params` when it knows it. */
  readonly message: string;
  readonly steps: readonly string[];
  /** The names `message` is built from: `label`, `program`, `status`. */
  readonly params?: Readonly<Record<string, string>>;
  /**
   * For `not-logged-in`: whether the agent offered a sign-in the panel can open in a Tyto
   * terminal (`login`). Without one the panel cannot sign the person in, and says so.
   */
  readonly canLogIn?: boolean;
  /** For `not-downloaded`: the page offers **Download** (`download`). */
  readonly canDownload?: boolean;
  /**
   * For `no-key` and `bad-key`: the page offers a field for the API key, which it stores in
   * Tyto's keychain itself (`storeCredential`), never through the plugin (TYTO-661).
   */
  readonly canEnterKey?: boolean;
}

/** One of the agent's terminal sign-ins: run the agent again with `args`, in a terminal. */
export interface LoginMethod {
  readonly id: string;
  readonly name: string;
  readonly args: readonly string[];
}

/**
 * The agent's terminal sign-in, from `initialize`'s `authMethods` (ACP): a method of type
 * `terminal` whose `args` are strings, the driver's preferred one first. `undefined` when it
 * offers none. The arguments are the agent's own, never written here, so a new version of the
 * agent that changes its login command changes what the panel runs.
 */
export function loginMethodOf(initialized: unknown, preferred?: string): LoginMethod | undefined {
  const methods = (initialized as { authMethods?: unknown } | null)?.authMethods;
  if (!Array.isArray(methods)) return undefined;
  const usable = methods
    .map((method) => method as { id?: unknown; name?: unknown; type?: unknown; args?: unknown })
    .filter(
      (method) =>
        method.type === 'terminal' &&
        typeof method.id === 'string' &&
        Array.isArray(method.args) &&
        method.args.every((arg) => typeof arg === 'string'),
    )
    .map((method) => ({
      id: method.id as string,
      name: typeof method.name === 'string' ? method.name : (method.id as string),
      args: method.args as string[],
    }));
  return usable.find((method) => method.id === preferred) ?? usable[0];
}

/** What `login` answers: the tab opened, or why not, as a code the page says in its language. */
export interface LoginAnswer {
  readonly opened: boolean;
  readonly code?: 'no-method' | 'already-open' | 'restricted' | 'no-terminal' | 'failed';
  readonly reason?: string;
}

/**
 * Whether the agent reaches the window's tools. `connected` is that Tyto handed the agent the
 * window's server; `missing`, that the agent reported its session without it, or with it not
 * connected (`driver.serverReport`). `off` is the `agentsListen` setting.
 */
export type WindowReach = 'connected' | 'missing' | 'off' | 'unavailable' | 'unknown';

export interface Status {
  readonly agent: string;
  readonly running: boolean;
  readonly busy: boolean;
  readonly window: WindowReach;
  readonly problem: Problem | null;
  /** The folder the agent runs in, once it has started. */
  readonly folder: string | null;
  /** The API driver's agents, for the page's picker, and the one this conversation uses. */
  readonly agents?: readonly { readonly name: string; readonly model: string }[];
  readonly agentName?: string;
}

/** At most this many entries per `read`, so one answer stays far below a panel call's 1 MiB. */
const READ_LIMIT = 200;
/** ACP's version this client speaks (schema-v1.30.0). */
const PROTOCOL_VERSION = 1;
const CLIENT_INFO = { name: 'tyto-plugin-agent', version: '0.1.0' };

/** A refusal's code, from the host's `PluginCapabilityError`, which crosses as `code`. */
function codeOf(cause: unknown): string | undefined {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** What the person reads when starting the program was refused, by the host's code. */
export function startProblem(choice: AgentChoice, cause: unknown): Problem {
  const { driver } = choice;
  switch (codeOf(cause)) {
    // The program is the plugin's own launcher (ADR 0184), so a missing one is a broken install,
    // never a program the person forgot to put on PATH.
    case 'E_PROCESS_SCRIPT_MISSING':
    case 'E_PROCESS_NOT_FOUND':
      return {
        kind: 'script-missing',
        message: `The agent plugin's own program, ${driver.program}, is missing from its folder. Reinstall the plugin.`,
        steps: [],
        params: { label: driver.label, program: driver.program },
      };
    case 'E_PROCESS_RESTRICTED':
      return {
        kind: 'restricted',
        message:
          'The folder open in Tyto is restricted, and Tyto starts no program in a restricted folder. Trust the folder to talk to an agent here.',
        steps: [],
      };
    case 'E_PROCESS_UNAVAILABLE':
      return {
        kind: 'no-programs',
        message:
          'This Tyto starts no programs for plugins; the agent panel works in the desktop app.',
        steps: [],
      };
    default:
      return { kind: 'failed', message: messageOf(cause), steps: [] };
  }
}

/**
 * The agent asked for authentication. With a terminal sign-in to offer, the page shows **Log in**
 * (`canLogIn`); without one it says the agent offers none, and names no command of its own.
 */
export function loginProblem(choice: AgentChoice, method: LoginMethod | undefined): Problem {
  const label = choice.driver.label;
  return method === undefined
    ? {
        kind: 'not-logged-in',
        message: `${label} is not signed in, and its adapter offers no sign-in Tyto can open in a terminal. Sign ${label} in yourself, then press New. Tyto never sees or stores the login.`,
        steps: [],
        params: { label },
        canLogIn: false,
      }
    : {
        kind: 'not-logged-in',
        message: `${label} is not signed in. Log in opens a Tyto terminal where ${label}'s own sign-in runs and your browser opens on its page; Tyto never sees or stores the login.`,
        steps: [],
        params: { label },
        canLogIn: true,
      };
}

/** What the launcher's status (TYTO-666) says stands in the way, or `undefined` when nothing does. */
export function adapterProblem(choice: AgentChoice, status: StatusLine): Problem | undefined {
  const label = choice.driver.label;
  if (!status.data) {
    return {
      kind: 'old-tyto',
      message: `The agent panel needs Tyto 0.18 or later, which gives a plugin's program a folder to download ${label}'s adapter into. Update Tyto.`,
      steps: [],
      params: { label },
    };
  }
  if (status.claude !== 'found') {
    return {
      kind: 'no-claude',
      message:
        status.claude === 'shim'
          ? `${label} Code was found only as an old npm install (claude.cmd running cli.js), which the adapter cannot start. Update it with \`npm install -g @anthropic-ai/claude-code\`, or install ${label} Code natively, then press New.`
          : `${label} Code is not installed: the panel talks to your own \`claude\`, and it is not on your PATH. Install ${label} Code, then press New.`,
      steps: [],
      params: { label, found: status.claude },
    };
  }
  if (!status.installed) {
    const size = megabytes(status.bytes);
    return {
      kind: 'not-downloaded',
      message: `${label}'s adapter is not downloaded yet. **Download** fetches @agentclientprotocol/claude-agent-acp ${status.version} from ${status.source}, about ${size} MB on disk, into Tyto's folder for this plugin, and checks every file against the hash this plugin pins. It includes Anthropic's Claude Agent SDK, under Anthropic's own terms.`,
      steps: [],
      params: { label, version: status.version, size, source: status.source },
      canDownload: true,
    };
  }
  return undefined;
}

export function downloadingProblem(choice: AgentChoice, done: number, total: number): Problem {
  const label = choice.driver.label;
  return {
    kind: 'downloading',
    message: `Downloading ${label}'s adapter: ${String(done)} of ${String(total)} packages.`,
    steps: [],
    params: { label, done: String(done), total: String(total) },
  };
}

export function downloadFailedProblem(
  choice: AgentChoice,
  outcome: Extract<InstallOutcome, { installed: false }>,
): Problem {
  const label = choice.driver.label;
  return {
    kind: 'download-failed',
    message: `${label}'s adapter did not download, and nothing was installed (${outcome.code}): ${outcome.message}. Press New to try again.`,
    steps: [],
    params: { label, code: outcome.code, reason: outcome.message },
  };
}

/** The name Tyto gives the window's MCP server (Tyto ADR 0183, `WINDOW_AGENT_SERVER_NAME`). */
const WINDOW_SERVER = 'tyto';

/**
 * What the person reads when the agent's session has no Tyto tools. `undefined` when it has
 * them, and when they are still connecting: a slow start is not a missing server.
 */
export function toolsProblem(
  choice: AgentChoice,
  servers: readonly { readonly name: string; readonly status: string }[],
): Problem | undefined {
  const label = choice.driver.label;
  const server = servers.find((candidate) => candidate.name === WINDOW_SERVER);
  if (server === undefined) {
    return {
      kind: 'no-tools',
      message: `${label} started without Tyto's tools, so it cannot see the brief in front or act on it. The likely cause is an MCP server allowlist in your Claude Code settings (often set by your organisation, as allowedMcpServers) that does not list \`tyto\`. Ask your organisation's admin to allow the MCP server \`tyto\`; Tyto does not work around that policy.`,
      steps: [],
      params: { label },
    };
  }
  if (server.status === 'connected' || server.status === 'pending') return undefined;
  return {
    kind: 'no-tools',
    message: `${label} has Tyto's tools configured, but they did not connect (status: ${server.status || 'unknown'}), so it cannot see the brief in front or act on it. Press New to start again; if it happens again, Claude Code's MCP log for \`tyto\` says why.`,
    steps: [],
    params: { label, status: server.status || 'unknown' },
  };
}

/**
 * Tyto's window tools (`MCP_TOOLS` in Tyto 0.17.0's `packages/command-line/src/mcp/tools.ts`),
 * as a tool line names them. A tool Tyto adds later shows by its own name.
 */
const TYTO_TOOLS: Readonly<Record<string, string>> = {
  list_templates: 'list templates',
  describe_template: 'describe a template',
  check_brief: 'check the brief',
  render_preview: 'render a preview',
  brief_in_front: 'read the brief in front',
  selection: 'read the selection',
  open_file: 'open a file',
  show_format: 'show a format',
  propose_edit: 'propose an edit',
  proposal_status: 'check a proposal',
};

/**
 * A tool line's name: an MCP tool as `<server> · <tool>` (Tyto's own with a short label), any
 * other by the title the agent gave it, else its name.
 */
export function toolTitle(name: string, title: string): string {
  const match = /^mcp__(.+?)__(.+)$/u.exec(name);
  if (match !== null) {
    const [, server, tool] = match as unknown as [string, string, string];
    if (server === WINDOW_SERVER) return `Tyto · ${TYTO_TOOLS[tool] ?? tool.replaceAll('_', ' ')}`;
    return `${server} · ${tool}`;
  }
  return title !== '' ? title : name;
}

/** Tyto's own tool's name, when `name` is one of the window server's tools. */
export function tytoTool(name: string): string | undefined {
  const match = /^mcp__(.+?)__(.+)$/u.exec(name);
  return match !== null && match[1] === WINDOW_SERVER ? match[2] : undefined;
}

/** The tool's own name in an update: ACP's `name` field, or the adapter's `_meta`. */
function toolNameOf(update: Record<string, unknown>): string {
  if (typeof update['name'] === 'string') return update['name'];
  const meta = update['_meta'] as { claudeCode?: { toolName?: unknown } } | undefined;
  const named = meta?.claudeCode?.toolName;
  return typeof named === 'string' ? named : '';
}

interface Running {
  readonly program: PluginProcess;
  readonly connection: Connection;
  readonly sessionId: string;
  readonly choice: AgentChoice;
}

export interface Conversation {
  /** Starts the agent if it is not running, and says how things stand. */
  open(): Promise<Status & { readonly history: readonly HistoryMessage[] }>;
  /** Starts a turn with the person's text; refused while one runs. */
  send(text: string): {
    readonly accepted: boolean;
    readonly reason?: string;
    readonly code?: 'busy' | 'empty';
  };
  read(after: number): { readonly entries: readonly Entry[]; readonly status: Status };
  answer(permission: string, optionId: string | null): { readonly answered: boolean };
  cancel(): Promise<void>;
  /** Ends the agent and forgets the conversation; the next message starts a fresh one. */
  reset(): Promise<void>;
  /**
   * Starts the download the person accepted (TYTO-666): answered at once, its progress read as
   * the status's `downloading` problem. Refused while one runs.
   */
  download(): { readonly started: boolean; readonly code?: 'running' };
  /**
   * Opens a Tyto terminal running the agent's own sign-in (Tyto ADR 0184): the agent's program
   * with the arguments its `initialize` offered. The plugin never sees what runs there.
   */
  login(): Promise<LoginAnswer>;
  status(): Status;
}

export function conversation(
  host: Pick<PluginHost, 'config' | 'process' | 'window' | 'cache' | 'log' | 'terminal'>,
): Conversation {
  const entries: Entry[] = [];
  let seq = 0;
  let running: Running | undefined;
  let starting: Promise<Running | undefined> | undefined;
  let busy = false;
  let problem: Problem | null = null;
  let window: WindowReach = 'unknown';
  let folder: string | null = null;
  /** The agent's terminal sign-in, from its last `initialize`. */
  let loginMethod: LoginMethod | undefined;
  /** The adapter's download, while it runs (TYTO-666). */
  let downloading: Promise<void> | undefined;
  let messages: HistoryMessage[] = [];
  let reply = '';
  const permissions = new Map<string, (optionId: string | null) => void>();
  /** Each tool call's line name, from its first report: updates rarely repeat it. */
  const toolTitles = new Map<string, string>();
  /** Each Tyto tool call's own name, from its first report. */
  const tytoTools = new Map<string, string>();

  // Typed per kind: `Omit` over the union would lose which fields go with which kind.
  const push = (entry: Record<string, unknown> & { kind: Entry['kind'] }): void => {
    seq += 1;
    entries.push({ ...entry, seq } as Entry);
  };

  const status = (): Status => ({
    agent: chosenAgent(host).driver.label,
    running: running !== undefined,
    busy,
    window,
    problem,
    folder,
  });

  function update(params: unknown): void {
    const update = (params as { update?: Record<string, unknown> } | undefined)?.update;
    if (update === undefined) return;
    const kind = update['sessionUpdate'];
    const content = update['content'] as { type?: unknown; text?: unknown } | undefined;
    const text = content?.type === 'text' && typeof content.text === 'string' ? content.text : '';
    if (kind === 'agent_message_chunk' && text !== '') {
      reply += text;
      push({ kind: 'text', text });
    } else if (kind === 'agent_thought_chunk' && text !== '') {
      push({ kind: 'thought', text });
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      const id = String(update['toolCallId'] ?? '');
      const name = toolNameOf(update);
      const named = toolTitle(name, typeof update['title'] === 'string' ? update['title'] : '');
      if (named !== '') toolTitles.set(id, named);
      const tyto = tytoTool(name);
      if (tyto !== undefined) tytoTools.set(id, tyto);
      push({
        kind: 'tool',
        id,
        title: toolTitles.get(id) ?? '',
        status: typeof update['status'] === 'string' ? update['status'] : '',
        ...(tytoTools.has(id) ? { tyto: tytoTools.get(id) } : {}),
      });
    } else if (kind === 'plan' && Array.isArray(update['entries'])) {
      push({
        kind: 'plan',
        entries: (update['entries'] as { content?: unknown; status?: unknown }[]).map((item) => ({
          content: String(item.content ?? ''),
          status: String(item.status ?? ''),
        })),
      });
    }
  }

  function askPermission(params: unknown): Promise<unknown> {
    const request = params as
      { toolCall?: { toolCallId?: unknown; title?: unknown }; options?: unknown } | undefined;
    const options = Array.isArray(request?.options)
      ? (request.options as Record<string, unknown>[])
          .filter((option) => typeof option['optionId'] === 'string')
          .map((option) => ({
            optionId: String(option['optionId']),
            name: String(option['name'] ?? option['optionId']),
            kind: String(option['kind'] ?? ''),
          }))
      : [];
    const id = `p${String(seq + 1)}`;
    push({
      kind: 'permission',
      id,
      title: String(request?.toolCall?.title ?? request?.toolCall?.toolCallId ?? 'a tool'),
      options,
    });
    return new Promise((resolve) => {
      permissions.set(id, (optionId) => {
        permissions.delete(id);
        const chosen = options.find((option) => option.optionId === optionId);
        push({
          kind: 'answered',
          id,
          name: chosen?.name ?? 'cancelled',
          cancelled: chosen === undefined,
        });
        resolve({
          outcome:
            chosen === undefined
              ? { outcome: 'cancelled' }
              : { outcome: 'selected', optionId: chosen.optionId },
        });
      });
    });
  }

  /** Every permission still waiting is answered `cancelled`, as ACP requires on cancel. */
  function cancelPermissions(): void {
    for (const settle of [...permissions.values()]) settle(null);
  }

  async function windowServers(): Promise<unknown[]> {
    try {
      const server = await host.window.agentServer();
      window = 'connected';
      return [server];
    } catch (cause) {
      const code = codeOf(cause);
      window = code === 'E_WINDOW_AGENTS_OFF' ? 'off' : 'unavailable';
      if (code === 'E_WINDOW_AGENTS_OFF') {
        push({
          kind: 'notice',
          code: 'agents-off',
          text: 'Tyto does not let agents connect (setting agentsListen), so the agent cannot see the brief in front or propose edits. Turn it on and start a new conversation.',
        });
      }
      return [];
    }
  }

  function download(): { readonly started: boolean; readonly code?: 'running' } {
    if (downloading !== undefined) return { started: false, code: 'running' };
    const choice = chosenAgent(host);
    problem = downloadingProblem(choice, 0, 0);
    downloading = installAdapter(host, choice.driver.program, (done, total) => {
      problem = downloadingProblem(choice, done, total);
    })
      .catch((cause: unknown): InstallOutcome => ({
        installed: false,
        code: 'unknown',
        message: startProblem(choice, cause).message,
      }))
      .then((outcome) => {
        problem = outcome.installed ? null : downloadFailedProblem(choice, outcome);
      })
      .finally(() => {
        downloading = undefined;
      });
    return { started: true };
  }

  /**
   * Whether the adapter is there to start (TYTO-666): the launcher's status, read before every
   * start, so a download, a new pin or a `claude` installed meanwhile is seen at the next one. An
   * earlier pin the person already accepted is replaced without asking again, as Zed keeps its
   * copy up to date.
   */
  async function prepared(choice: AgentChoice): Promise<boolean> {
    if (downloading !== undefined) return false;
    let found: StatusLine | undefined;
    try {
      found = await adapterStatus(host, choice.driver.program);
    } catch (cause) {
      problem = startProblem(choice, cause);
      return false;
    }
    if (found === undefined) {
      problem = {
        kind: 'failed',
        message: "The agent plugin's launcher said nothing about the adapter.",
        steps: [],
      };
      return false;
    }
    if (!found.installed && found.data && found.claude === 'found' && found.previous !== null) {
      download();
      return false;
    }
    const standing = adapterProblem(choice, found);
    if (standing !== undefined) {
      problem = standing;
      return false;
    }
    return true;
  }

  async function start(): Promise<Running | undefined> {
    const choice = chosenAgent(host);
    if (choice.driver.downloads && !(await prepared(choice))) return undefined;
    let program: PluginProcess;
    try {
      program = await host.process.start(choice.driver.program, choice.args);
    } catch (cause) {
      problem = startProblem(choice, cause);
      return undefined;
    }
    folder = program.cwd;
    let stderr = '';
    program.onStderr((bytes) => {
      stderr = (stderr + new TextDecoder().decode(bytes)).slice(-4000);
    });
    const connection = connect(program, {
      onProblem: (text) => host.log.warn(text),
    });
    connection.handle('session/update', update);
    connection.handle('session/request_permission', askPermission);
    let signedOut = false;
    const auth = choice.driver.authReport;
    if (auth !== undefined) {
      connection.handle(auth.notification, (params) => {
        const said = auth.signedOut(params);
        if (said === undefined) return;
        signedOut = said;
        if (said) problem = loginProblem(choice, loginMethod);
        else if (problem?.kind === 'not-logged-in') problem = null;
      });
    }
    const report = choice.driver.serverReport;
    if (report !== undefined) {
      connection.handle(report.notification, (params) => {
        const servers = report.servers(params);
        // Only a session Tyto offered its server to can be missing it.
        if (servers === undefined || window === 'off' || window === 'unavailable') return;
        const missing = toolsProblem(choice, servers);
        if (missing !== undefined) {
          problem = missing;
          window = 'missing';
        } else if (problem?.kind === 'no-tools') {
          problem = null;
          window = 'connected';
        }
      });
    }
    void program.exited.then((exit) => {
      connection.close('the agent ended');
      cancelPermissions();
      if (running?.program === program) {
        running = undefined;
        busy = false;
        const code = String(exit.code ?? exit.signal);
        push({
          kind: 'notice',
          code: 'ended',
          params: { exit: code },
          text: `The agent ended (exit ${code}). Your next message starts it again.`,
        });
        if (stderr.trim() !== '') host.log.info(`agent stderr: ${stderr.trim()}`);
      }
    });
    try {
      // `auth.terminal`: this client can run an agent's sign-in in a terminal, so the agent
      // lists its terminal methods in `authMethods` (TYTO-657).
      const initialized = await connection.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          auth: { terminal: true },
        },
        clientInfo: CLIENT_INFO,
      });
      loginMethod = loginMethodOf(initialized, choice.driver.preferredLogin);
      const created = (await connection.request('session/new', {
        cwd: program.cwd,
        mcpServers: await windowServers(),
        ...(report === undefined ? {} : { _meta: report.sessionMeta }),
      })) as { sessionId?: unknown } | null;
      if (typeof created?.sessionId !== 'string')
        throw new Error('session/new answered no sessionId');
      // A session can open signed out (Claude's adapter does): the agent's own report decides.
      problem = signedOut ? loginProblem(choice, loginMethod) : null;
      // A cache that cannot be read costs the earlier messages, never the conversation.
      messages = [...(await loadHistory(host, program.cwd).catch(() => []))];
      return { program, connection, sessionId: created.sessionId, choice };
    } catch (cause) {
      problem =
        cause instanceof RpcError && cause.code === AUTH_REQUIRED
          ? loginProblem(choice, loginMethod)
          : { kind: 'failed', message: messageOf(cause), steps: [] };
      await program.kill();
      return undefined;
    }
  }

  async function ensure(): Promise<Running | undefined> {
    if (running !== undefined) return running;
    starting ??= start().finally(() => {
      starting = undefined;
    });
    running = await starting;
    return running;
  }

  async function turn(text: string): Promise<void> {
    reply = '';
    try {
      const agent = await ensure();
      // A problem is shown once, by the page, from the status with its steps; the log
      // repeats it only when there is none to show.
      if (agent === undefined) {
        if (problem === null)
          push({ kind: 'notice', code: 'not-started', text: 'The agent did not start.' });
        return;
      }
      const answer = (await agent.connection.request('session/prompt', {
        sessionId: agent.sessionId,
        prompt: [{ type: 'text', text }],
      })) as { stopReason?: unknown } | null;
      push({ kind: 'end', reason: String(answer?.stopReason ?? 'end_turn') });
    } catch (cause) {
      if (cause instanceof RpcError && cause.code === AUTH_REQUIRED) {
        problem = loginProblem(chosenAgent(host), loginMethod);
      } else {
        const said = messageOf(cause);
        push({
          kind: 'notice',
          code: 'turn-failed',
          params: { message: said },
          text: `The turn failed: ${said}`,
        });
      }
    } finally {
      busy = false;
      if (folder !== null && reply !== '') {
        messages.push({ role: 'user', text }, { role: 'agent', text: reply });
        await saveHistory(host, folder, messages).catch((cause: unknown) =>
          host.log.warn(`the conversation was not saved: ${messageOf(cause)}`),
        );
      }
    }
  }

  return {
    async open() {
      // Signed out, the page's next `open` is a try again: the agent starts afresh and reads its
      // login anew, which a session opened before the person signed in would not.
      if (problem?.kind === 'not-logged-in' && running !== undefined) {
        const ending = running;
        running = undefined;
        await ending.program.kill();
      }
      await ensure();
      return { ...status(), history: messages };
    },
    send(text) {
      if (busy) {
        return {
          accepted: false,
          code: 'busy',
          reason: 'A turn is running; wait for it or stop it.',
        };
      }
      if (text.trim() === '') {
        return { accepted: false, code: 'empty', reason: 'The message is empty.' };
      }
      busy = true;
      push({ kind: 'user', text });
      void turn(text);
      return { accepted: true };
    },
    read(after) {
      const next = entries.filter((entry) => entry.seq > after).slice(0, READ_LIMIT);
      return { entries: next, status: status() };
    },
    answer(permission, optionId) {
      const settle = permissions.get(permission);
      if (settle === undefined) return { answered: false };
      settle(optionId);
      return { answered: true };
    },
    async cancel() {
      cancelPermissions();
      if (running !== undefined && busy) {
        await running.connection.notify('session/cancel', { sessionId: running.sessionId });
      }
    },
    async reset() {
      cancelPermissions();
      const ending = running;
      running = undefined;
      busy = false;
      entries.length = 0;
      toolTitles.clear();
      tytoTools.clear();
      messages = [];
      problem = null;
      window = 'unknown';
      if (ending !== undefined) await ending.program.kill();
    },
    download,
    async login() {
      const method = loginMethod;
      if (method === undefined) return { opened: false, code: 'no-method' };
      const choice = chosenAgent(host);
      try {
        await host.terminal.open(choice.driver.program, [...choice.args, ...method.args]);
        return { opened: true };
      } catch (cause) {
        switch (codeOf(cause)) {
          case 'E_TERMINAL_LIMIT':
            return { opened: false, code: 'already-open' };
          case 'E_PROCESS_RESTRICTED':
            return { opened: false, code: 'restricted' };
          case 'E_TERMINAL_UNAVAILABLE':
            return { opened: false, code: 'no-terminal' };
          default:
            return { opened: false, code: 'failed', reason: messageOf(cause) };
        }
      }
    },
    status,
  };
}
