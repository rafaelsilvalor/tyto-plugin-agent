import { readFileSync } from 'node:fs';

import { panelCallerOf } from '@tyto/plugin-api';
import { testPlugin } from '@tyto/plugin-api/testing';
import { afterEach, describe, expect, it } from 'vitest';

import {
  type FakeAgent,
  type FakeAgentOptions,
  FOLDER,
  WINDOW_SERVER,
  fakeAgent,
} from './fake-agent.js';

/**
 * The panel as the window drives it: the committed `dist/index.js`, activated over the isolation
 * protocol by Tyto's own harness (`testPlugin`, Tyto ADR 0150), its panel asked through `call`
 * exactly as the page asks, with a fake ACP agent behind the host's `startProcess` port.
 */

const manifest = readFileSync(new URL('../tyto-plugin.json', import.meta.url), 'utf8');
const entry = new URL('../dist/index.js', import.meta.url).href;

interface Entry {
  readonly seq: number;
  readonly kind: string;
  readonly [key: string]: unknown;
}

interface Status {
  readonly agent: string;
  readonly running: boolean;
  readonly busy: boolean;
  readonly window: string;
  readonly folder: string | null;
  readonly problem: {
    kind: string;
    message: string;
    steps: string[];
    params?: Record<string, string>;
  } | null;
}

const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0)) await close();
});

async function panel(
  options: FakeAgentOptions & { readonly settings?: Record<string, unknown> } = {},
  agent: FakeAgent = fakeAgent(options),
) {
  const harness = await testPlugin({
    manifest,
    load: () => import(entry),
    capabilities: agent.capabilities,
    ...(options.settings === undefined ? {} : { settings: options.settings }),
  });
  if (!harness.ok) throw new Error(harness.error.map((item) => item.message).join('\n'));
  closing.push(() => harness.value.close());
  const caller = panelCallerOf(harness.value.host.registry);
  const call = async <T>(method: string, params?: unknown): Promise<T> => {
    const answer = await caller('agent', params === undefined ? { method } : { method, params });
    if (!answer.ok) throw new Error(answer.error.map((item) => item.message).join('\n'));
    return answer.value as T;
  };
  let after = 0;
  const seen: Entry[] = [];
  /** Reads as the page does, until `done` holds for what was read so far. */
  const readUntil = async (done: (entries: readonly Entry[]) => boolean): Promise<Entry[]> => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const { entries } = await call<{ entries: Entry[] }>('read', { after });
      for (const item of entries) {
        seen.push(item);
        after = item.seq;
      }
      if (done(seen)) return seen;
      if (Date.now() > deadline) throw new Error(`never done; read ${JSON.stringify(seen)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { agent, call, readUntil, seen };
}

const ended = (entries: readonly Entry[]) => entries.some((item) => item.kind === 'end');

/** Waits for the turn to be over, then answers the whole log and the status. */
async function afterTurn(call: Awaited<ReturnType<typeof panel>>['call']) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const read = await call<{ entries: Entry[]; status: Status }>('read', { after: 0 });
    if (!read.status.busy) return read;
    if (Date.now() > deadline) throw new Error('the turn never ended');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const textOf = (entries: readonly Entry[]) =>
  entries
    .filter((item) => item.kind === 'text')
    .map((item) => item.text)
    .join('');

describe('a conversation with the agent', () => {
  it('starts the adapter in the folder Tyto reports, with the window server, and streams a turn', async () => {
    const { agent, call, readUntil } = await panel();
    const opened = await call<Status>('open');
    expect(opened).toMatchObject({
      agent: 'Claude',
      running: true,
      window: 'connected',
      folder: FOLDER,
      problem: null,
    });
    expect(agent.started).toEqual([{ program: 'claude-agent-acp', args: [] }]);
    // ACP's session/new: the absolute cwd the host reported, and the window's MCP server.
    expect(agent.heard.find((item) => item.method === 'session/new')?.params).toEqual({
      cwd: FOLDER,
      mcpServers: [WINDOW_SERVER],
      _meta: expect.any(Object),
    });

    expect(await call('send', { text: 'monta o brief' })).toEqual({ accepted: true });
    const entries = await readUntil(ended);
    expect(entries.map((item) => item.kind)).toEqual(['user', 'text', 'text', 'end']);
    expect(textOf(entries)).toBe('Hello, world');
    const prompt = agent.heard.find((item) => item.method === 'session/prompt')?.params;
    expect(prompt).toEqual({
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'monta o brief' }],
    });
  });

  it('refuses a second message while a turn runs', async () => {
    let finish: () => void = () => undefined;
    const { call, readUntil } = await panel({
      turn: () => new Promise((resolve) => (finish = () => resolve('end_turn'))),
    });
    await call('open');
    expect(await call('send', { text: 'one' })).toEqual({ accepted: true });
    expect(await call('send', { text: 'two' })).toMatchObject({ accepted: false, code: 'busy' });
    expect(await call('send', { text: '  ' })).toMatchObject({ accepted: false, code: 'busy' });
    finish();
    await readUntil(ended);
    expect(await call('send', { text: 'three' })).toEqual({ accepted: true });
  });

  it('passes the person’s extra arguments after the driver’s', async () => {
    const { agent, call } = await panel({ settings: { 'agent.args': ['--model', 'sonnet'] } });
    await call('open');
    expect(agent.started).toEqual([{ program: 'claude-agent-acp', args: ['--model', 'sonnet'] }]);
  });
});

describe('a permission the agent asks for', () => {
  it('shows it, and hands the agent the option the person chose', async () => {
    let outcome: unknown;
    const { call, readUntil } = await panel({
      turn: async (tools) => {
        outcome = await tools.permission('propose_edit');
        tools.update({
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'propose_edit',
          status: 'completed',
        });
        return 'end_turn';
      },
    });
    await call('open');
    await call('send', { text: 'edit it' });
    const asked = await readUntil((entries) => entries.some((item) => item.kind === 'permission'));
    const permission = asked.find((item) => item.kind === 'permission')!;
    expect(permission).toMatchObject({
      title: 'propose_edit',
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    expect(await call('answer', { id: permission['id'], optionId: 'allow' })).toEqual({
      answered: true,
    });
    const entries = await readUntil(ended);
    expect(outcome).toEqual({ outcome: 'selected', optionId: 'allow' });
    expect(entries.map((item) => item.kind)).toEqual([
      'user',
      'permission',
      'answered',
      'tool',
      'end',
    ]);
  });

  it('answers a waiting permission cancelled when the person stops the turn', async () => {
    let outcome: unknown;
    const { agent, call, readUntil } = await panel({
      turn: async (tools) => {
        outcome = await tools.permission('render_preview');
        await tools.cancelled;
        return 'cancelled';
      },
    });
    await call('open');
    await call('send', { text: 'render' });
    await readUntil((entries) => entries.some((item) => item.kind === 'permission'));
    await call('cancel');
    const entries = await readUntil(ended);
    expect(outcome).toEqual({ outcome: 'cancelled' });
    expect(agent.heard.map((item) => item.method)).toContain('session/cancel');
    expect(entries.find((item) => item.kind === 'answered')).toMatchObject({ cancelled: true });
    expect(entries.at(-1)).toMatchObject({ kind: 'end', reason: 'cancelled' });
  });
});

describe('the states the card names', () => {
  it('says how to install the adapter when it is not on PATH', async () => {
    const { call } = await panel({ refuse: 'E_PROCESS_NOT_FOUND' });
    const status = await call<Status>('open');
    expect(status.running).toBe(false);
    expect(status.problem).toEqual({
      kind: 'not-installed',
      message:
        "Claude's ACP adapter, claude-agent-acp, is not on your PATH. Tyto installs no agent.",
      steps: [
        'npm install -g @agentclientprotocol/claude-agent-acp',
        'then sign in once: claude /login',
      ],
      params: { label: 'Claude', program: 'claude-agent-acp', login: 'claude /login' },
    });
  });

  it('says how to sign in when the agent asks for authentication, and ends the adapter', async () => {
    const { agent, call } = await panel({ signedOut: true });
    const status = await call<Status>('open');
    expect(status.problem?.kind).toBe('not-logged-in');
    expect(status.problem?.steps).toEqual(['open a terminal in Tyto and run: claude /login']);
    expect(status.problem?.params).toEqual({ label: 'Claude', login: 'claude /login' });
    expect(agent.killed()).toBe(1);
  });

  // The page draws the status's problem as a box with its steps; the same words as a log line
  // too showed the message twice (seen on Tyto 0.17.0, 9 November 2026).

  it('says "not signed in" once, as the problem, when a message finds the agent signed out', async () => {
    const { call } = await panel({ signedOut: true });
    await call('open');
    expect(await call('send', { text: 'oi' })).toEqual({ accepted: true });
    const { entries, status } = await afterTurn(call);
    expect(status.problem?.kind).toBe('not-logged-in');
    expect(entries.map((item) => item.kind)).toEqual(['user']);
  });

  it('says "not signed in" once, as the problem, when the login expires mid-conversation', async () => {
    const { call } = await panel({ expiresAtPrompt: true });
    expect((await call<Status>('open')).problem).toBeNull();
    expect(await call('send', { text: 'oi' })).toEqual({ accepted: true });
    const { entries, status } = await afterTurn(call);
    expect(status.problem?.kind).toBe('not-logged-in');
    expect(entries.map((item) => item.kind)).toEqual(['user']);
  });

  it('says the folder is restricted, and starts nothing', async () => {
    const { agent, call } = await panel({ refuse: 'E_PROCESS_RESTRICTED' });
    const status = await call<Status>('open');
    expect(status.problem?.kind).toBe('restricted');
    expect(agent.started).toEqual([]);
  });

  it('talks without the window when agentsListen is off, and says so', async () => {
    const { agent, call, readUntil } = await panel({ window: 'E_WINDOW_AGENTS_OFF' });
    const status = await call<Status>('open');
    expect(status).toMatchObject({ running: true, window: 'off', problem: null });
    expect(agent.heard.find((item) => item.method === 'session/new')?.params).toEqual({
      cwd: FOLDER,
      mcpServers: [],
      _meta: expect.any(Object),
    });
    const notice = await readUntil((entries) => entries.some((item) => item.kind === 'notice'));
    expect(String(notice[0]?.['text'])).toContain('setting agentsListen');
    expect(notice[0]?.['code']).toBe('agents-off');
  });

  it('says the agent ended, and starts it again on the next message', async () => {
    let turns = 0;
    const { agent, call, readUntil } = await panel({
      turn: async (tools) => {
        turns += 1;
        if (turns === 1) {
          tools.exit(1);
          return undefined;
        }
        return 'end_turn';
      },
    });
    await call('open');
    await call('send', { text: 'first' });
    const first = await readUntil((entries) =>
      entries.some((item) => item.kind === 'notice' && String(item['text']).includes('ended')),
    );
    expect(first.find((item) => item.kind === 'notice')).toMatchObject({
      code: 'ended',
      params: { exit: '1' },
    });
    await readUntil(() => true);
    expect((await call<{ status: Status }>('read', { after: 1e9 })).status.busy).toBe(false);
    await call('send', { text: 'second' });
    await readUntil(ended);
    expect(agent.started).toHaveLength(2);
  });
});

// Seen on Tyto 0.17.0, 9 November 2026: the organisation's Claude Code settings allowed a list
// of MCP servers without `tyto`, Claude Code dropped the window's server without a word, and
// the panel said "sees the window". Claude's adapter reports the session's servers on the
// first turn when asked to (`_claude/sdkMessage`, Claude Code's `system`/`init`).
describe("Tyto's tools in the agent's session", () => {
  /** One turn, then the status as the page reads it. */
  async function firstTurn(options: FakeAgentOptions) {
    const run = await panel(options);
    await run.call('open');
    await run.call('send', { text: 'oi' });
    return { ...run, ...(await afterTurn(run.call)) };
  }

  it('asks Claude’s adapter for the report in session/new', async () => {
    const { agent } = await firstTurn({ init: [{ name: 'tyto', status: 'connected' }] });
    const created = agent.heard.find((item) => item.method === 'session/new')?.params;
    expect(created).toMatchObject({
      _meta: { claudeCode: { emitRawSDKMessages: [{ type: 'system', subtype: 'init' }] } },
    });
  });

  it('says the agent lacks Tyto’s tools when the session has no tyto server', async () => {
    const { status } = await firstTurn({
      init: [
        { name: 'claude.ai Figma', status: 'connected' },
        { name: 'claude.ai Notion', status: 'connected' },
      ],
    });
    expect(status.window).toBe('missing');
    expect(status.problem?.kind).toBe('no-tools');
    expect(status.problem?.message).toContain("Claude started without Tyto's tools");
    expect(status.problem?.message).toContain('allowedMcpServers');
    expect(status.problem?.message).toContain(
      "Ask your organisation's admin to allow the MCP server `tyto`; Tyto does not work around that policy.",
    );
  });

  it('says nothing when the tyto server connected', async () => {
    const { status, entries } = await firstTurn({
      init: [
        { name: 'claude.ai Figma', status: 'connected' },
        { name: 'tyto', status: 'connected' },
      ],
    });
    expect(status).toMatchObject({ window: 'connected', problem: null });
    expect(entries.filter((item) => item.kind === 'notice')).toEqual([]);
  });

  it('says nothing when the agent sends no report: no false alarm', async () => {
    const { status } = await firstTurn({});
    expect(status).toMatchObject({ window: 'connected', problem: null });
  });

  it('says the tools did not connect when the tyto server failed', async () => {
    const { status } = await firstTurn({ init: [{ name: 'tyto', status: 'failed' }] });
    expect(status.window).toBe('missing');
    expect(status.problem?.message).toContain('did not connect (status: failed)');
  });

  it('waits on a tyto server still connecting', async () => {
    const { status } = await firstTurn({ init: [{ name: 'tyto', status: 'pending' }] });
    expect(status).toMatchObject({ window: 'connected', problem: null });
  });

  it('does not blame a policy when Tyto offered no server (agentsListen off)', async () => {
    const { status } = await firstTurn({ window: 'E_WINDOW_AGENTS_OFF', init: [] });
    expect(status).toMatchObject({ window: 'off', problem: null });
  });
});

describe('tool lines', () => {
  it('name Tyto’s tools, and keep the name when an update does not repeat it', async () => {
    const { call } = await panel({
      turn: async (tools) => {
        tools.update({
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          name: 'mcp__tyto__describe_template',
          title: 'describe_template',
          status: 'pending',
        });
        tools.update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 't1',
          status: 'completed',
          _meta: { claudeCode: { toolName: 'mcp__tyto__describe_template' } },
        });
        tools.update({
          sessionUpdate: 'tool_call',
          toolCallId: 't2',
          name: 'Read',
          title: 'Read brief.brief',
          status: 'pending',
        });
        tools.update({ sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'completed' });
        tools.update({
          sessionUpdate: 'tool_call',
          toolCallId: 't3',
          title: '',
          status: 'pending',
          _meta: { claudeCode: { toolName: 'mcp__figma__get_screenshot' } },
        });
        return 'end_turn';
      },
    });
    await call('open');
    await call('send', { text: 'oi' });
    const { entries } = await afterTurn(call);
    expect(
      entries
        .filter((item) => item.kind === 'tool')
        .map((item) => [item['title'], item['status'], item['tyto']]),
    ).toEqual([
      ['Tyto · describe a template', 'pending', 'describe_template'],
      ['Tyto · describe a template', 'completed', 'describe_template'],
      ['Read brief.brief', 'pending', undefined],
      ['Read brief.brief', 'completed', undefined],
      ['figma · get_screenshot', 'pending', undefined],
    ]);
  });
});

describe('the history kept per folder', () => {
  it('keeps what was said in this folder, and shows it in the next conversation', async () => {
    const agent = fakeAgent();
    const first = await panel({}, agent);
    await first.call('open');
    await first.call('send', { text: 'oi' });
    await first.readUntil(ended);

    const second = await panel({}, agent);
    const status = await second.call<Status & { history: unknown[] }>('open');
    expect(status.history).toEqual([
      { role: 'user', text: 'oi' },
      { role: 'agent', text: 'Hello, world' },
    ]);
    // Nothing but the conversation is stored: no token, no setting.
    const stored = [...agent.cache.values()].map((bytes) => new TextDecoder().decode(bytes));
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0]!)).toEqual({ folder: FOLDER, messages: status.history });
  });

  it('shows nothing from another folder', async () => {
    const agent = fakeAgent();
    const first = await panel({}, agent);
    await first.call('open');
    await first.call('send', { text: 'oi' });
    await first.readUntil(ended);

    const elsewhere = fakeAgent({ folder: '/home/ana/other' });
    for (const [key, bytes] of agent.cache) elsewhere.cache.set(key, bytes);
    const second = await panel({}, elsewhere);
    expect((await second.call<{ history: unknown[] }>('open')).history).toEqual([]);
  });
});
