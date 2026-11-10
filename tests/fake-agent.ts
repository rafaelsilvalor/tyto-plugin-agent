import {
  type AgentServer,
  type HostCapabilities,
  PluginCapabilityError,
  type ProcessEvents,
  type StartedProcess,
} from '@tyto/plugin-api';

import {
  INSTALL_ARGUMENT,
  type LauncherLine,
  STATUS_ARGUMENT,
  type StatusLine,
} from '../src/launcher/protocol.js';

/**
 * A fake ACP agent behind the host's `startProcess` port: the program a real Tyto would start for
 * `process:claude-agent-acp`, speaking newline-delimited JSON-RPC on stdin and stdout as ACP's
 * stdio transport does. What it does on each turn is the test's script.
 *
 * It answers `initialize` and `session/new` (recording the `cwd` and `mcpServers` it was given),
 * then runs `turn` for each `session/prompt`, which may stream updates, ask for a permission and
 * read the answer, wait for `session/cancel`, or exit.
 */

export const FOLDER = '/home/ana/work';

export const WINDOW_SERVER: AgentServer = {
  name: 'tyto',
  command: '/opt/tyto/node/node',
  args: ['/opt/tyto/relay/agent-relay.js'],
  env: [
    { name: 'TYTO_WINDOW', value: '4242' },
    { name: 'TYTO_HOME', value: '/home/ana/.tyto' },
  ],
};

export interface TurnTools {
  readonly text: string;
  update(update: Record<string, unknown>): void;
  /** Asks the client for a permission and resolves with its `outcome`. */
  permission(title: string): Promise<{ outcome: string; optionId?: string }>;
  /** Resolves when the client sends `session/cancel`. */
  readonly cancelled: Promise<void>;
  exit(code: number): void;
}

export interface FakeAgentOptions {
  /** The host refuses the start with this code, as the desktop's adapter would. */
  readonly refuse?: 'E_PROCESS_SCRIPT_MISSING' | 'E_PROCESS_RESTRICTED';
  /** `session/new` answers ACP's "authentication required", until the test calls `signIn`. */
  readonly signedOut?: boolean;
  /**
   * What `initialize` lists in `authMethods`. Absent, the methods Claude's adapter lists (read
   * in 0.102.0, measured on 2026-11-10), and only to a client that sent `auth.terminal: true`,
   * as the adapter does.
   */
  readonly authMethods?: readonly unknown[];
  /**
   * As Claude's adapter does (measured with 0.102.0 on 2026-11-10): `_auth/status_update` after
   * `initialize`, `session/new` opens a session even signed out, and the first `session/prompt`
   * answers "authentication required".
   */
  readonly reportsAuth?: boolean;
  /** The host refuses `host.terminal.open` with this code. */
  readonly refuseTerminal?: 'E_TERMINAL_LIMIT' | 'E_PROCESS_RESTRICTED' | 'E_TERMINAL_UNAVAILABLE';
  /** `session/prompt` answers ACP's "authentication required": a login that expired. */
  readonly expiresAtPrompt?: boolean;
  /** The window's server, or the code `host.window.agentServer()` refuses with. */
  readonly window?: AgentServer | 'E_WINDOW_AGENTS_OFF';
  readonly folder?: string;
  readonly turn?: (tools: TurnTools) => Promise<string | undefined>;
  /**
   * The MCP servers Claude Code's `system`/`init` message lists, sent as Claude's adapter sends
   * it: an `_claude/sdkMessage` notification when a turn starts, only to a client that asked for
   * it in `session/new`. Absent, no init is sent at all: an agent with no such report.
   */
  readonly init?: readonly { readonly name: string; readonly status: string }[];
  /**
   * What the launcher (`adapter/launch.mjs`, TYTO-666) answers to `--tyto-status`. Absent, the
   * adapter is installed and `claude` found, so a test about something else starts the agent.
   */
  readonly adapter?: Partial<Omit<StatusLine, 'tyto'>>;
  /** How `--tyto-install` ends: installed (the default), or failed with this code. */
  readonly install?: 'installed' | 'integrity' | 'network';
}

export interface FakeAgent {
  readonly capabilities: Partial<HostCapabilities>;
  /** Every agent started: its name and arguments. The launcher's own runs are in `launched`. */
  readonly started: { program: string; args: readonly string[] }[];
  /** Every run of the launcher's protocol (`--tyto-status`, `--tyto-install`), in order. */
  readonly launched: string[];
  /** Every request and notification the client sent, by method, with its params. */
  readonly heard: { method: string; params: unknown }[];
  readonly killed: () => number;
  /** The plugin's private cache, shared across conversations of one test. */
  readonly cache: Map<string, Uint8Array>;
  /** Every terminal the plugin asked the host to open: its program and arguments. */
  readonly terminals: { program: string; args: readonly string[] }[];
  /** The person finished signing in: from now on `session/new` answers a session. */
  signIn(): void;
}

/** The terminal methods Claude's adapter lists to a client that can run them. */
export const CLAUDE_AUTH_METHODS = [
  {
    id: 'claude-ai-login',
    name: 'Claude Subscription',
    description: 'Use Claude subscription ',
    type: 'terminal',
    args: ['--cli', 'auth', 'login', '--claudeai'],
  },
  {
    id: 'console-login',
    name: 'Anthropic Console',
    description: 'Use Anthropic Console (API usage billing)',
    type: 'terminal',
    args: ['--cli', 'auth', 'login', '--console'],
  },
];

function refusal(code: string): PluginCapabilityError {
  return new PluginCapabilityError({
    severity: 'error',
    code,
    message: `the fake host refused: ${code}`,
  } as unknown as ConstructorParameters<typeof PluginCapabilityError>[0]);
}

const defaultTurn = async (tools: TurnTools): Promise<string> => {
  tools.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } });
  tools.update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: ', world' },
  });
  return 'end_turn';
};

/** The launcher's protocol, as `adapter/launch.mjs` speaks it: JSON lines, then an exit. */
function launcher(
  events: ProcessEvents,
  lines: readonly LauncherLine[],
  code: number,
): StartedProcess {
  const encoder = new TextEncoder();
  queueMicrotask(() => {
    for (const line of lines)
      events.stdout(
        encoder.encode(`${JSON.stringify(line)}
`),
      );
    events.exit({ code, signal: null });
  });
  return {
    cwd: FOLDER,
    write: () => Promise.resolve(),
    end: () => Promise.resolve(),
    kill: () => undefined,
  };
}

export function fakeAgent(options: FakeAgentOptions = {}): FakeAgent {
  const started: { program: string; args: readonly string[] }[] = [];
  const launched: string[] = [];
  let status: Omit<StatusLine, 'tyto'> = {
    data: true,
    installed: true,
    previous: null,
    version: '0.104.1',
    bytes: 53_567_526,
    source: 'registry.npmjs.org',
    claude: 'found',
    ...options.adapter,
  };
  const heard: { method: string; params: unknown }[] = [];
  const cache = new Map<string, Uint8Array>();
  const terminals: { program: string; args: readonly string[] }[] = [];
  let signedIn = options.signedOut !== true;
  let kills = 0;

  function run(events: ProcessEvents): StartedProcess {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let buffered = '';
    let ended = false;
    let nextId = 1000;
    const waiting = new Map<number, (result: unknown) => void>();
    let cancel: (() => void) | undefined;
    /** Whether `session/new` asked for Claude Code's init message, as the adapter reads it. */
    let wantsInit = false;

    const say = (message: Record<string, unknown>): void => {
      if (ended) return;
      events.stdout(encoder.encode(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`));
    };
    const exit = (code: number | null, signal: string | null): void => {
      if (ended) return;
      ended = true;
      events.exit({ code, signal });
    };

    async function prompt(id: unknown, params: { sessionId: string; prompt: { text: string }[] }) {
      const cancelled = new Promise<void>((resolve) => {
        cancel = resolve;
      });
      const tools: TurnTools = {
        text: params.prompt.map((block) => block.text).join(''),
        update: (update) =>
          say({ method: 'session/update', params: { sessionId: params.sessionId, update } }),
        permission: (title) => {
          const requestId = nextId++;
          say({
            id: requestId,
            method: 'session/request_permission',
            params: {
              sessionId: params.sessionId,
              toolCall: { toolCallId: 't1', title },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
              ],
            },
          });
          return new Promise((resolve) => {
            waiting.set(requestId, (result) =>
              resolve((result as { outcome: { outcome: string; optionId?: string } }).outcome),
            );
          });
        },
        cancelled,
        exit: (code) => exit(code, null),
      };
      if (options.init !== undefined && wantsInit) {
        say({
          method: '_claude/sdkMessage',
          params: {
            sessionId: params.sessionId,
            message: {
              type: 'system',
              subtype: 'init',
              mcp_servers: options.init,
              tools: ['Read', 'Edit'],
            },
          },
        });
      }
      const stopReason = await (options.turn ?? defaultTurn)(tools);
      if (stopReason !== undefined) say({ id, result: { stopReason } });
    }

    function heardLine(line: string): void {
      const message = JSON.parse(line) as {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
      };
      if (message.method === undefined) {
        waiting.get(message.id!)?.(message.result);
        return;
      }
      heard.push({ method: message.method, params: message.params });
      if (message.method === 'initialize') {
        const asked = (message.params as { clientCapabilities?: { auth?: { terminal?: unknown } } })
          .clientCapabilities?.auth?.terminal;
        say({
          id: message.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {},
            authMethods: options.authMethods ?? (asked === true ? CLAUDE_AUTH_METHODS : []),
          },
        });
        if (options.reportsAuth === true) {
          say({
            method: '_auth/status_update',
            params: {
              authStatus: signedIn
                ? { kind: 'account', label: 'Claude Team', account: { email: 'ana@example.com' } }
                : { kind: 'none' },
            },
          });
        }
      } else if (message.method === 'session/new') {
        const meta = (message.params as { _meta?: { claudeCode?: Record<string, unknown> } })._meta;
        const asked = meta?.claudeCode?.['emitRawSDKMessages'];
        wantsInit =
          asked === true ||
          (Array.isArray(asked) &&
            asked.some(
              (filter: { type?: unknown; subtype?: unknown }) =>
                filter.type === 'system' &&
                (filter.subtype === undefined || filter.subtype === 'init'),
            ));
        if (!signedIn && options.reportsAuth !== true) {
          say({ id: message.id, error: { code: -32000, message: 'Authentication required' } });
        } else {
          say({ id: message.id, result: { sessionId: 'session-1' } });
        }
      } else if (
        message.method === 'session/prompt' &&
        (options.expiresAtPrompt === true || (options.reportsAuth === true && !signedIn))
      ) {
        say({ id: message.id, error: { code: -32000, message: 'Authentication required' } });
      } else if (message.method === 'session/prompt') {
        void prompt(
          message.id,
          message.params as { sessionId: string; prompt: { text: string }[] },
        );
      } else if (message.method === 'session/cancel') {
        cancel?.();
      }
    }

    return {
      cwd: options.folder ?? FOLDER,
      write(bytes) {
        buffered += decoder.decode(bytes);
        for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          if (line.trim() !== '') heardLine(line);
        }
        return Promise.resolve();
      },
      end() {
        exit(0, null);
        return Promise.resolve();
      },
      kill() {
        kills += 1;
        exit(null, 'SIGTERM');
      },
    };
  }

  const window = options.window ?? WINDOW_SERVER;
  return {
    started,
    launched,
    heard,
    cache,
    terminals,
    signIn: () => {
      signedIn = true;
    },
    killed: () => kills,
    capabilities: {
      openTerminal: (_plugin, program, args) => {
        if (options.refuseTerminal !== undefined) {
          return Promise.reject(refusal(options.refuseTerminal));
        }
        terminals.push({ program, args });
        return Promise.resolve({ closed: new Promise<void>(() => undefined) });
      },
      startProcess: (_plugin, program, args, events) => {
        if (options.refuse !== undefined) return Promise.reject(refusal(options.refuse));
        if (args[0] === STATUS_ARGUMENT) {
          launched.push('status');
          return Promise.resolve(launcher(events, [{ tyto: 'status', ...status }], 0));
        }
        if (args[0] === INSTALL_ARGUMENT) {
          launched.push('install');
          const ending = options.install ?? 'installed';
          if (ending === 'installed') status = { ...status, installed: true, previous: null };
          return Promise.resolve(
            launcher(
              events,
              [
                { tyto: 'progress', done: 1, total: 2 },
                { tyto: 'progress', done: 2, total: 2 },
                ending === 'installed'
                  ? { tyto: 'installed', version: status.version }
                  : {
                      tyto: 'failed',
                      code: ending,
                      message: `the fake launcher failed: ${ending}`,
                    },
              ],
              ending === 'installed' ? 0 : 1,
            ),
          );
        }
        started.push({ program, args });
        return Promise.resolve(run(events));
      },
      windowAgentServer: () =>
        typeof window === 'string' ? Promise.reject(refusal(window)) : Promise.resolve(window),
      cacheGet: (_plugin, key) => {
        const bytes = cache.get(key);
        return Promise.resolve(
          bytes === undefined ? undefined : { bytes, storedAt: '2026-11-09T00:00:00Z' },
        );
      },
      cachePut: (_plugin, key, bytes) => {
        cache.set(key, bytes);
        return Promise.resolve({ storedAt: '2026-11-09T00:00:00Z' });
      },
    },
  };
}
