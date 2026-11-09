import {
  type AgentServer,
  type HostCapabilities,
  PluginCapabilityError,
  type ProcessEvents,
  type StartedProcess,
} from '@tyto/plugin-api';

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
  readonly refuse?: 'E_PROCESS_NOT_FOUND' | 'E_PROCESS_RESTRICTED';
  /** `session/new` answers ACP's "authentication required". */
  readonly signedOut?: boolean;
  /** The window's server, or the code `host.window.agentServer()` refuses with. */
  readonly window?: AgentServer | 'E_WINDOW_AGENTS_OFF';
  readonly folder?: string;
  readonly turn?: (tools: TurnTools) => Promise<string | undefined>;
}

export interface FakeAgent {
  readonly capabilities: Partial<HostCapabilities>;
  /** Every program started: its name and arguments. */
  readonly started: { program: string; args: readonly string[] }[];
  /** Every request and notification the client sent, by method, with its params. */
  readonly heard: { method: string; params: unknown }[];
  readonly killed: () => number;
  /** The plugin's private cache, shared across conversations of one test. */
  readonly cache: Map<string, Uint8Array>;
}

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

export function fakeAgent(options: FakeAgentOptions = {}): FakeAgent {
  const started: { program: string; args: readonly string[] }[] = [];
  const heard: { method: string; params: unknown }[] = [];
  const cache = new Map<string, Uint8Array>();
  let kills = 0;

  function run(events: ProcessEvents): StartedProcess {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let buffered = '';
    let ended = false;
    let nextId = 1000;
    const waiting = new Map<number, (result: unknown) => void>();
    let cancel: (() => void) | undefined;

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
        say({
          id: message.id,
          result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
        });
      } else if (message.method === 'session/new') {
        if (options.signedOut === true) {
          say({ id: message.id, error: { code: -32000, message: 'Authentication required' } });
        } else {
          say({ id: message.id, result: { sessionId: 'session-1' } });
        }
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
    heard,
    cache,
    killed: () => kills,
    capabilities: {
      startProcess: (_plugin, program, args, events) => {
        if (options.refuse !== undefined) return Promise.reject(refusal(options.refuse));
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
