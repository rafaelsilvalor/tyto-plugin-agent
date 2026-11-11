import type Anthropic from '@anthropic-ai/sdk';
import type { PluginHost } from '@tyto/plugin-api';

import type { Conversation, Entry, Problem, Status } from '../conversation.js';
import { type ApiAgent, agentsOf } from './agents.js';
import { API_KEY_CREDENTIAL, type HostFetch, apiClient } from './client.js';
import { type Records, addSpent, monthOf, spentIn } from './ledger.js';
import { PRICES, costMicros, dollars } from './prices.js';

/**
 * A conversation with one of the person's API agents (TYTO-661): the Claude API, the person's own
 * key, and the window's Tyto tools called in process.
 *
 * It answers the page through the same calls as the ACP driver (`open`, `send`, `read`,
 * `cancel`, `reset`), so the page draws both the same way, plus `useAgent` (the picker) and
 * `keySaved` (after the page stored a key). A turn is a loop: ask the model, run the tools it
 * asks for through `host.window.callTool` (Tyto ADR 0190), give it their answers, until it ends
 * its turn. **Edits stay proposals**: the window's `propose_edit` shows them to the person
 * (ADR 0180), and this driver has no other way to write.
 *
 * **Every call is counted before the next one**: its cost, from `usage` and the price table, is
 * added to the month's record, and a month at or over the cap stops the turn before the next call
 * and refuses the next turn (`cap-reached`).
 */

/** What the driver needs of the host: the 0.18 contract plus what Tyto 0.20 added, detected. */
export type ApiHost = Pick<PluginHost, 'config' | 'log' | 'window'> & {
  readonly fetch: HostFetch;
  readonly storage?: Records & { delete(key: string): Promise<boolean> };
};

interface WindowTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}
type ToolContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string };
interface WindowTools {
  tools(): Promise<readonly WindowTool[]>;
  callTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ content: readonly ToolContent[]; isError: boolean }>;
}

export interface ApiSettings {
  readonly agentLines: readonly string[];
  /** US dollars a month; 0 lets no turn run. */
  readonly monthlyCapUsd: number;
}

export interface ApiConversationOptions {
  readonly settings: () => ApiSettings;
  readonly now?: () => Date;
  /** The SDK client; the default loads the bundled SDK on the host's network. */
  readonly client?: (fetch: HostFetch) => Promise<Anthropic>;
}

/** A turn asks the model at most this often, so a loop of tool calls cannot run without end. */
export const TURN_CALL_LIMIT = 24;
/** A response whole, never streamed: the SDK's ceiling for one that is not. */
const MAX_TOKENS = 16_000;
const READ_LIMIT = 200;
/** One tool answer kept for the model, so a large preview cannot fill the context. */
const TOOL_TEXT_LIMIT = 50_000;

function codeIn(cause: unknown): string | undefined {
  // The SDK wraps a refusal of the host's in its connection error: the code is on a cause.
  for (let at = cause, depth = 0; at !== undefined && at !== null && depth < 5; depth += 1) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('E_')) return code;
    at = (at as { cause?: unknown }).cause;
  }
  return undefined;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function keyProblem(kind: 'no-key' | 'bad-key'): Problem {
  return {
    kind,
    message:
      kind === 'no-key'
        ? 'Enter your Claude API key to talk to the API agents. Tyto keeps it in its keychain; the panel never sees it again.'
        : 'The Claude API refused the key. Enter another one.',
    steps: [],
    params: {},
    canEnterKey: true,
  };
}

const OLD_TYTO: Problem = {
  kind: 'api-old-tyto',
  message:
    'The API agents need Tyto 0.20 or later, which sends the key without the plugin holding it and keeps the month’s spending. Update Tyto.',
  steps: [],
  params: { version: '0.20' },
};

/** The model's tools: the window's, those the agent may use, sorted so the prefix stays stable. */
function toolsFor(agent: ApiAgent, offered: readonly WindowTool[]): Anthropic.Tool[] {
  const allowed = offered
    .filter((tool) => agent.tools === '*' || agent.tools.includes(tool.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return allowed.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: { type: 'object', ...tool.inputSchema } as Anthropic.Tool.InputSchema,
  }));
}

function resultBlocks(
  content: readonly ToolContent[],
): Exclude<Anthropic.ToolResultBlockParam['content'], string | undefined> {
  return content.map((block) =>
    block.type === 'text'
      ? { type: 'text' as const, text: block.text.slice(0, TOOL_TEXT_LIMIT) }
      : {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: block.mimeType as 'image/png',
            data: block.data,
          },
        },
  );
}

export function apiConversation(
  host: ApiHost,
  options: ApiConversationOptions,
): Conversation & {
  useAgent(name: string): Status;
  keySaved(): Status;
} {
  const now = options.now ?? (() => new Date());
  const makeClient = options.client ?? apiClient;
  const entries: Entry[] = [];
  let seq = 0;
  let busy = false;
  let cancelled = false;
  let problem: Problem | null = null;
  let chosen: string | undefined;
  let client: Anthropic | undefined;
  /** The conversation as the API reads it, appended to only, so its cache prefix holds. */
  let messages: Anthropic.MessageParam[] = [];
  let saidLines = '';

  const push = (entry: Record<string, unknown> & { kind: Entry['kind'] }): void => {
    seq += 1;
    entries.push({ ...entry, seq } as Entry);
  };

  const agents = (): readonly ApiAgent[] => {
    const read = agentsOf(options.settings().agentLines);
    const said = read.problems.join('\n');
    if (said !== '' && said !== saidLines) {
      push({ kind: 'notice', code: 'agent-lines', params: { problems: said }, text: said });
    }
    saidLines = said;
    return read.agents;
  };

  const agent = (): ApiAgent | undefined => {
    const all = agents();
    return all.find((candidate) => candidate.name === chosen) ?? all[0];
  };

  const supported = (): boolean =>
    typeof host.storage?.get === 'function' && typeof host.storage.set === 'function';

  const windowTools = (): WindowTools | undefined => {
    const window = host.window as Partial<WindowTools>;
    return typeof window.tools === 'function' && typeof window.callTool === 'function'
      ? (window as WindowTools)
      : undefined;
  };

  const status = (): Status => {
    const current = agent();
    return {
      agent:
        current === undefined
          ? 'Claude API'
          : `${current.name} · ${PRICES[current.model]?.label ?? current.model}`,
      running: true,
      busy,
      window: windowTools() === undefined ? 'unavailable' : 'connected',
      problem,
      folder: null,
      agents: agents().map((each) => ({ name: each.name, model: each.model })),
      ...(current === undefined ? {} : { agentName: current.name }),
    };
  };

  const capMicros = (): number =>
    Math.max(0, Math.round(options.settings().monthlyCapUsd * 1_000_000));

  /** The window's tools for this turn, or none, said once when the window refuses them. */
  async function offeredTools(current: ApiAgent): Promise<Anthropic.Tool[]> {
    const window = windowTools();
    if (window === undefined) {
      push({
        kind: 'notice',
        code: 'no-tools',
        params: { reason: 'old-tyto' },
        text: 'This Tyto does not give plugins its tools; the agent answers without them.',
      });
      return [];
    }
    try {
      return toolsFor(current, await window.tools());
    } catch (cause) {
      const code = codeIn(cause) ?? 'failed';
      push({
        kind: 'notice',
        code: 'no-tools',
        params: { reason: code },
        text: `Tyto's tools are not available now (${code}); the agent answers without them.`,
      });
      return [];
    }
  }

  async function runTools(
    blocks: readonly Anthropic.ContentBlock[],
  ): Promise<Anthropic.ToolResultBlockParam[]> {
    const window = windowTools();
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue;
      push({
        kind: 'tool',
        id: block.id,
        title: block.name,
        status: 'in_progress',
        tyto: block.name,
      });
      try {
        if (window === undefined) throw new Error('this Tyto gives plugins no tools');
        const answer = await window.callTool(
          block.name,
          (block.input ?? {}) as Record<string, unknown>,
        );
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: resultBlocks(answer.content),
          ...(answer.isError ? { is_error: true } : {}),
        });
        push({
          kind: 'tool',
          id: block.id,
          title: block.name,
          status: answer.isError ? 'failed' : 'completed',
          tyto: block.name,
        });
      } catch (cause) {
        // The window refused (agentsListen off, a restricted folder): said to the model too.
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: [
            { type: 'text', text: `Tyto refused the call: ${codeIn(cause) ?? messageOf(cause)}` },
          ],
          is_error: true,
        });
        push({ kind: 'tool', id: block.id, title: block.name, status: 'failed', tyto: block.name });
      }
    }
    return results;
  }

  async function turn(text: string): Promise<void> {
    const storage = host.storage!;
    const month = monthOf(now());
    const cap = capMicros();
    try {
      const current = agent();
      if (current === undefined) {
        problem = {
          kind: 'no-api-agents',
          message: 'No API agent is configured: every line of agent.apiAgents was left out.',
          steps: [],
          params: {},
        };
        return;
      }
      let spent = await spentIn(storage, month);
      if (spent >= cap) {
        push({
          kind: 'notice',
          code: 'cap-reached',
          params: { month: dollars(spent), cap: dollars(cap) },
          text: `This month's spending (US$${dollars(spent)}) has reached the cap (US$${dollars(cap)}). Raise agent.apiMonthlyCapUsd to go on.`,
        });
        push({ kind: 'end', reason: 'cap' });
        return;
      }
      client ??= await makeClient(host.fetch);
      const tools = await offeredTools(current);
      messages.push({ role: 'user', content: text });
      for (let call = 0; ; call += 1) {
        if (call >= TURN_CALL_LIMIT) {
          push({
            kind: 'notice',
            code: 'tool-loop',
            params: { limit: String(TURN_CALL_LIMIT) },
            text: `The turn stopped after ${String(TURN_CALL_LIMIT)} calls to the model.`,
          });
          push({ kind: 'end', reason: 'limit' });
          return;
        }
        const response = await client.messages.create({
          model: current.model,
          max_tokens: MAX_TOKENS,
          // The stable prefix, cached: the tools come first, then these instructions.
          system: [
            { type: 'text', text: current.instructions, cache_control: { type: 'ephemeral' } },
          ],
          ...(tools.length === 0 ? {} : { tools }),
          // And the conversation so far, up to its last block (automatic placement).
          cache_control: { type: 'ephemeral' },
          output_config: { effort: current.effort },
          messages,
        } as Anthropic.MessageCreateParamsNonStreaming);
        const micros = costMicros(current.model, response.usage) ?? 0;
        spent = await addSpent(storage, month, micros);
        push({
          kind: 'usage',
          model: response.model,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
          cost: dollars(micros),
          month: dollars(spent),
          cap: dollars(cap),
        });
        for (const block of response.content) {
          if (block.type === 'text' && block.text !== '') push({ kind: 'text', text: block.text });
        }
        // The answer exactly as it came, thinking blocks included, so the next call reads it.
        messages.push({ role: 'assistant', content: response.content });
        if (response.stop_reason === 'refusal') {
          push({
            kind: 'notice',
            code: 'refused',
            text: 'The model declined this request.',
          });
          push({ kind: 'end', reason: 'refusal' });
          return;
        }
        if (response.stop_reason === 'max_tokens') {
          push({
            kind: 'notice',
            code: 'max-tokens',
            text: 'The answer was cut at its length limit.',
          });
        }
        if (response.stop_reason !== 'tool_use' && response.stop_reason !== 'pause_turn') {
          push({ kind: 'end', reason: response.stop_reason ?? 'end_turn' });
          return;
        }
        if (cancelled || spent >= cap) {
          // The model asked for tools nobody will run: its last message goes, so the next turn
          // does not open on a tool call with no answer. Nothing after it is edited.
          messages.pop();
          if (spent >= cap && !cancelled) {
            push({
              kind: 'notice',
              code: 'cap-reached',
              params: { month: dollars(spent), cap: dollars(cap) },
              text: `This month's spending (US$${dollars(spent)}) has reached the cap (US$${dollars(cap)}).`,
            });
          }
          push({ kind: 'end', reason: cancelled ? 'cancelled' : 'cap' });
          return;
        }
        if (response.stop_reason === 'tool_use') {
          messages.push({ role: 'user', content: await runTools(response.content) });
        }
      }
    } catch (cause) {
      const code = codeIn(cause);
      const statusCode = (cause as { status?: unknown } | null)?.status;
      if (code === 'E_CREDENTIAL_MISSING') problem = keyProblem('no-key');
      else if (statusCode === 401) problem = keyProblem('bad-key');
      else if (code === 'E_PLUGIN_STORAGE' || /spend record/u.test(messageOf(cause))) {
        problem = {
          kind: 'ledger',
          message:
            'The panel cannot read this month’s spending, so it runs no turn until it can. Removing and installing the plugin again starts the record over.',
          steps: [],
          params: {},
        };
      } else {
        const said = messageOf(cause);
        push({
          kind: 'notice',
          code: 'turn-failed',
          params: { message: said },
          text: `The turn failed: ${said}`,
        });
      }
      // A turn that failed leaves no half exchange behind for the next one to open on.
      while (messages.length > 0 && messages.at(-1)?.role === 'user') messages.pop();
      push({ kind: 'end', reason: 'failed' });
    } finally {
      busy = false;
      cancelled = false;
    }
  }

  return {
    open() {
      if (!supported()) problem = OLD_TYTO;
      return Promise.resolve({ ...status(), history: [] });
    },
    send(text) {
      if (busy) {
        return {
          accepted: false,
          code: 'busy',
          reason: 'A turn is running; wait for it or stop it.',
        };
      }
      if (text.trim() === '')
        return { accepted: false, code: 'empty', reason: 'The message is empty.' };
      if (!supported()) {
        problem = OLD_TYTO;
        return { accepted: false, reason: OLD_TYTO.message };
      }
      if (problem?.kind === 'no-key' || problem?.kind === 'bad-key') {
        return { accepted: false, reason: problem.message };
      }
      busy = true;
      problem = null;
      push({ kind: 'user', text });
      void turn(text);
      return { accepted: true };
    },
    read(after) {
      return {
        entries: entries.filter((entry) => entry.seq > after).slice(0, READ_LIMIT),
        status: status(),
      };
    },
    answer: () => ({ answered: false }),
    cancel() {
      if (busy) cancelled = true;
      return Promise.resolve();
    },
    reset() {
      entries.length = 0;
      messages = [];
      problem = supported() ? null : OLD_TYTO;
      saidLines = '';
      return Promise.resolve();
    },
    download: () => ({ started: false, code: 'running' }),
    login: () => Promise.resolve({ opened: false, code: 'no-method' }),
    status,
    useAgent(name) {
      if (!busy && agents().some((each) => each.name === name) && name !== chosen) {
        // Another agent is another model and other instructions: a fresh conversation.
        chosen = name;
        messages = [];
      }
      return status();
    },
    keySaved() {
      if (problem?.kind === 'no-key' || problem?.kind === 'bad-key') problem = null;
      return status();
    },
  };
}

/** The credential the page stores, named once for the page and the manifest. */
export { API_KEY_CREDENTIAL };
