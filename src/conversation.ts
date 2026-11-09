import type { PluginHost, PluginProcess } from '@tyto/plugin-api';

import { AUTH_REQUIRED, type Connection, RpcError, connect } from './acp/connection.js';
import { type AgentChoice, chosenAgent } from './drivers.js';
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
  | { readonly seq: number; readonly kind: 'answered'; readonly id: string; readonly name: string }
  | { readonly seq: number; readonly kind: 'notice'; readonly text: string }
  | { readonly seq: number; readonly kind: 'end'; readonly reason: string };

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
    'not-installed' | 'not-logged-in' | 'restricted' | 'no-programs' | 'exited' | 'failed';
  readonly message: string;
  readonly steps: readonly string[];
}

/** Whether the agent reaches the window's tools: `off` is the `agentsListen` setting. */
export type WindowReach = 'connected' | 'off' | 'unavailable' | 'unknown';

export interface Status {
  readonly agent: string;
  readonly running: boolean;
  readonly busy: boolean;
  readonly window: WindowReach;
  readonly problem: Problem | null;
  /** The folder the agent runs in, once it has started. */
  readonly folder: string | null;
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
    case 'E_PROCESS_NOT_FOUND':
      return {
        kind: 'not-installed',
        message: `${driver.label}'s ACP adapter, ${driver.program}, is not on your PATH. Tyto installs no agent.`,
        steps: [...driver.install, `then sign in once: ${driver.login.join(' ')}`],
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

export function loginProblem(choice: AgentChoice): Problem {
  return {
    kind: 'not-logged-in',
    message: `${choice.driver.label} is not signed in. It uses its own login: Tyto never sees or stores it.`,
    steps: [`open a terminal in Tyto and run: ${choice.driver.login.join(' ')}`],
  };
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
  send(text: string): { readonly accepted: boolean; readonly reason?: string };
  read(after: number): { readonly entries: readonly Entry[]; readonly status: Status };
  answer(permission: string, optionId: string | null): { readonly answered: boolean };
  cancel(): Promise<void>;
  /** Ends the agent and forgets the conversation; the next message starts a fresh one. */
  reset(): Promise<void>;
  status(): Status;
}

export function conversation(
  host: Pick<PluginHost, 'config' | 'process' | 'window' | 'cache' | 'log'>,
): Conversation {
  const entries: Entry[] = [];
  let seq = 0;
  let running: Running | undefined;
  let starting: Promise<Running | undefined> | undefined;
  let busy = false;
  let problem: Problem | null = null;
  let window: WindowReach = 'unknown';
  let folder: string | null = null;
  let messages: HistoryMessage[] = [];
  let reply = '';
  const permissions = new Map<string, (optionId: string | null) => void>();

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
      push({
        kind: 'tool',
        id: String(update['toolCallId'] ?? ''),
        title: typeof update['title'] === 'string' ? update['title'] : '',
        status: typeof update['status'] === 'string' ? update['status'] : '',
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
        push({ kind: 'answered', id, name: chosen?.name ?? 'cancelled' });
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
          text: 'Tyto does not let agents connect (setting agentsListen), so the agent cannot see the brief in front or propose edits. Turn it on and start a new conversation.',
        });
      }
      return [];
    }
  }

  async function start(): Promise<Running | undefined> {
    const choice = chosenAgent(host);
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
    void program.exited.then((exit) => {
      connection.close('the agent ended');
      cancelPermissions();
      if (running?.program === program) {
        running = undefined;
        busy = false;
        push({
          kind: 'notice',
          text: `The agent ended (exit ${String(exit.code ?? exit.signal)}). Your next message starts it again.`,
        });
        if (stderr.trim() !== '') host.log.info(`agent stderr: ${stderr.trim()}`);
      }
    });
    try {
      await connection.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: CLIENT_INFO,
      });
      const created = (await connection.request('session/new', {
        cwd: program.cwd,
        mcpServers: await windowServers(),
      })) as { sessionId?: unknown } | null;
      if (typeof created?.sessionId !== 'string')
        throw new Error('session/new answered no sessionId');
      problem = null;
      // A cache that cannot be read costs the earlier messages, never the conversation.
      messages = [...(await loadHistory(host, program.cwd).catch(() => []))];
      return { program, connection, sessionId: created.sessionId, choice };
    } catch (cause) {
      problem =
        cause instanceof RpcError && cause.code === AUTH_REQUIRED
          ? loginProblem(choice)
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
        if (problem === null) push({ kind: 'notice', text: 'The agent did not start.' });
        return;
      }
      const answer = (await agent.connection.request('session/prompt', {
        sessionId: agent.sessionId,
        prompt: [{ type: 'text', text }],
      })) as { stopReason?: unknown } | null;
      push({ kind: 'end', reason: String(answer?.stopReason ?? 'end_turn') });
    } catch (cause) {
      if (cause instanceof RpcError && cause.code === AUTH_REQUIRED) {
        problem = loginProblem(chosenAgent(host));
      } else {
        push({ kind: 'notice', text: `The turn failed: ${messageOf(cause)}` });
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
      await ensure();
      return { ...status(), history: messages };
    },
    send(text) {
      if (busy) return { accepted: false, reason: 'A turn is running; wait for it or stop it.' };
      if (text.trim() === '') return { accepted: false, reason: 'The message is empty.' };
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
      messages = [];
      problem = null;
      window = 'unknown';
      if (ending !== undefined) await ending.program.kill();
    },
    status,
  };
}
