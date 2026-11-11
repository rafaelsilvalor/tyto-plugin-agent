import { describe, expect, it } from 'vitest';

import { agentOf, agentsOf } from '../src/api/agents.js';
import { apiConversation } from '../src/api/conversation.js';
import { ledgerKey } from '../src/api/ledger.js';
import { costMicros, dollars } from '../src/api/prices.js';
import type { Entry, Status } from '../src/conversation.js';
import { SECRET, TOOLS, fakeHost, message } from './fake-api.js';

/**
 * The API driver (TYTO-661) end to end, against a fake Claude API through the real SDK: a turn
 * that calls a Tyto tool, the cost of each call, the monthly cap, the person's key and what never
 * leaves the host. See `fake-api.ts` for what the fake is and is not.
 */

const NOW = new Date('2026-11-11T12:00:00Z');
const MONTH = ledgerKey('2026-11');
const AGENT =
  'Modelador | claude-haiku-5-5 | low | check_brief,propose_edit | You write briefs for Tyto.';

function settings(capUsd = 10, lines: readonly string[] = [AGENT]) {
  return () => ({ agentLines: lines, monthlyCapUsd: capUsd });
}

type Chat = ReturnType<typeof apiConversation>;

/** Sends, then reads until the turn ends: the page's loop, without its timer. */
async function turn(chat: Chat, text: string): Promise<{ entries: Entry[]; status: Status }> {
  const before = chat.read(0).entries.at(-1)?.seq ?? 0;
  const sent = chat.send(text);
  if (!sent.accepted) throw new Error(sent.reason);
  for (let wait = 0; wait < 200; wait += 1) {
    const read = chat.read(before);
    if (!read.status.busy) return { entries: [...read.entries], status: read.status };
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the turn never ended');
}

const TOOL_USE = message(
  [
    { type: 'text', text: 'Checking the brief.' },
    { type: 'tool_use', id: 'toolu_1', name: 'check_brief', input: { path: 'post.brief' } },
  ],
  'tool_use',
  { input_tokens: 1200, output_tokens: 80, cache_creation_input_tokens: 900 },
);
const DONE = message([{ type: 'text', text: 'Two problems: the title is too long.' }], 'end_turn', {
  input_tokens: 150,
  output_tokens: 40,
  cache_read_input_tokens: 900,
});

describe('a conversation with an API agent', () => {
  it('runs a turn that calls a Tyto tool, and shows each call’s tokens and cost', async () => {
    const fake = fakeHost({ answers: [TOOL_USE, DONE] });
    const chat = apiConversation(fake.host, { settings: settings(), now: () => NOW });
    await chat.open();
    const { entries } = await turn(chat, 'Check my brief');

    expect(fake.calls).toEqual([{ name: 'check_brief', input: { path: 'post.brief' } }]);
    expect(entries.filter((entry) => entry.kind === 'text').map((entry) => entry.text)).toEqual([
      'Checking the brief.',
      'Two problems: the title is too long.',
    ]);
    expect(entries.filter((entry) => entry.kind === 'tool').map((entry) => entry.status)).toEqual([
      'in_progress',
      'completed',
    ]);
    const usage = entries.filter((entry) => entry.kind === 'usage');
    // 1,200 in × $0.10 + 900 written × $0.125 + 80 out × $0.50 = 272.5 µ$, rounded up.
    expect(usage[0]).toMatchObject({ inputTokens: 1200, cacheWriteTokens: 900, cost: '0.0003' });
    // 150 in × $0.10 + 900 read × $0.01 + 40 out × $0.50 = 44 µ$.
    expect(usage[1]).toMatchObject({ cacheReadTokens: 900, cost: '0.0000', month: '0.0003' });
    expect(JSON.parse(fake.records.get(MONTH) ?? '{}')).toEqual({ micros: 317 });
    expect(entries.at(-1)).toMatchObject({ kind: 'end', reason: 'end_turn' });
  });

  it('sends the stable prefix cached, the agent’s tools only, its effort, and appends only', async () => {
    const fake = fakeHost({ answers: [TOOL_USE, DONE, DONE] });
    const chat = apiConversation(fake.host, { settings: settings(), now: () => NOW });
    await turn(chat, 'Check my brief');
    await turn(chat, 'And now?');
    const [first, , third] = fake.sent.map((request) => request.body);
    expect(first?.['model']).toBe('claude-haiku-5-5');
    expect(first?.['output_config']).toEqual({ effort: 'low' });
    expect(first?.['system']).toEqual([
      { type: 'text', text: 'You write briefs for Tyto.', cache_control: { type: 'ephemeral' } },
    ]);
    expect(first?.['cache_control']).toEqual({ type: 'ephemeral' });
    // `export` is the window's but not this agent's; the rest sorted, so the prefix is stable.
    expect((first?.['tools'] as { name: string }[]).map((tool) => tool.name)).toEqual([
      'check_brief',
      'propose_edit',
    ]);
    expect(third?.['tools']).toEqual(first?.['tools']);
    // The third request opens with every message the first two sent, unchanged.
    const earlier = first?.['messages'] as unknown[];
    expect((third?.['messages'] as unknown[]).slice(0, earlier.length)).toEqual(earlier);
  });

  it('stops a turn at the cap before the next call, and refuses the next turn', async () => {
    const fake = fakeHost({ answers: [TOOL_USE, DONE] });
    // US$0.0002: the first call (272.5 µ$) passes it.
    const chat = apiConversation(fake.host, { settings: settings(0.0002), now: () => NOW });
    const { entries } = await turn(chat, 'Check my brief');
    expect(fake.sent).toHaveLength(1);
    expect(fake.calls).toEqual([]);
    expect(entries.some((entry) => entry.kind === 'notice' && entry.code === 'cap-reached')).toBe(
      true,
    );
    expect(entries.at(-1)).toMatchObject({ kind: 'end', reason: 'cap' });

    const next = await turn(chat, 'Try again');
    expect(fake.sent).toHaveLength(1);
    expect(next.entries.at(-1)).toMatchObject({ kind: 'end', reason: 'cap' });
  });

  it('keeps the month’s spending across a restart, in Tyto’s records', async () => {
    const records = new Map([[MONTH, JSON.stringify({ micros: 10_000_000 })]]);
    const fake = fakeHost({ answers: [DONE], records });
    const chat = apiConversation(fake.host, { settings: settings(10), now: () => NOW });
    const { entries } = await turn(chat, 'Hello');
    expect(fake.sent).toHaveLength(0);
    expect(entries.find((entry) => entry.kind === 'notice')).toMatchObject({
      code: 'cap-reached',
      params: { month: '10.00', cap: '10.00' },
    });
  });

  it('runs no turn on a spending record it cannot read', async () => {
    const records = new Map([[MONTH, '{"micros":']]);
    const fake = fakeHost({ answers: [DONE], records });
    const chat = apiConversation(fake.host, { settings: settings(), now: () => NOW });
    const { status } = await turn(chat, 'Hello');
    expect(fake.sent).toHaveLength(0);
    expect(status.problem?.kind).toBe('ledger');
  });

  it('asks for the key when none is stored, and when the API refuses it', async () => {
    const missing = fakeHost({ answers: [DONE], noKey: true });
    const chat = apiConversation(missing.host, { settings: settings(), now: () => NOW });
    expect((await turn(chat, 'Hello')).status.problem).toMatchObject({
      kind: 'no-key',
      canEnterKey: true,
    });
    expect(chat.send('Again')).toMatchObject({ accepted: false });
    expect(chat.keySaved().problem).toBeNull();

    const refused = fakeHost({ answers: [{ status: 401, body: { type: 'error' } }] });
    // The fake answers 401 to any key but its own; this host's is wrong on purpose.
    const wrong = apiConversation(
      {
        ...refused.host,
        fetch: (url, init) =>
          refused.host.fetch(url, {
            ...init,
            credentialHeaders: { 'x-wrong': 'anthropic-api-key' },
          }),
      },
      { settings: settings(), now: () => NOW },
    );
    expect((await turn(wrong, 'Hello')).status.problem).toMatchObject({ kind: 'bad-key' });
  });

  it('refuses to start on a Tyto that cannot send the key for it, and never reads the key', async () => {
    const fake = fakeHost({ answers: [DONE], oldTyto: true });
    const chat = apiConversation(fake.host, { settings: settings(), now: () => NOW });
    expect((await chat.open()).problem?.kind).toBe('api-old-tyto');
    expect(chat.send('Hello')).toMatchObject({ accepted: false });
    expect(fake.sent).toHaveLength(0);
    expect(fake.credentialsRead).toEqual([]);
  });

  it('answers without tools on a Tyto that gives plugins none, and says so', async () => {
    const fake = fakeHost({ answers: [DONE], noTools: true });
    const chat = apiConversation(fake.host, { settings: settings(), now: () => NOW });
    const { entries } = await turn(chat, 'Hello');
    expect(fake.sent[0]?.body['tools']).toBeUndefined();
    expect(entries.some((entry) => entry.kind === 'notice' && entry.code === 'no-tools')).toBe(
      true,
    );
  });

  it('never lets the key reach the plugin: not its logs, settings, records, answers or errors', async () => {
    const fake = fakeHost({
      answers: [
        TOOL_USE,
        DONE,
        { status: 500, body: { type: 'error', error: { message: 'boom' } } },
      ],
    });
    const chat = apiConversation(fake.host, { settings: settings(), now: () => NOW });
    await chat.open();
    await turn(chat, 'Check my brief');
    await turn(chat, 'Fail now');
    // The host put it in the requests it made, and only there.
    expect(fake.sent.every((request) => request.headers['x-api-key'] === SECRET)).toBe(true);
    expect(
      fake.sent.every(
        (request) => request.credentialHeaders?.['x-api-key'] === 'anthropic-api-key',
      ),
    ).toBe(true);
    const seen = JSON.stringify({
      logged: fake.logged,
      written: fake.written,
      records: [...fake.records.values()],
      read: chat.read(0),
      status: chat.status(),
      bodies: fake.sent.map((request) => request.body),
    });
    expect(seen).not.toContain(SECRET);
    expect(fake.credentialsRead).toEqual([]);
    // The SDK's placeholder (it sends it as `authorization: Bearer …`) never leaves the plugin.
    expect(fake.sent.every((request) => request.headers['authorization'] === undefined)).toBe(true);
    expect(JSON.stringify(fake.sent.map((request) => request.headers))).not.toContain(
      'set-by-tyto-host',
    );
  });

  it('runs no turn on a spending record that is readable but not the panel’s', async () => {
    const records = new Map([[MONTH, JSON.stringify({ micros: 'lots' })]]);
    const fake = fakeHost({ answers: [DONE], records });
    const chat = apiConversation(fake.host, { settings: settings(), now: () => NOW });
    const { status } = await turn(chat, 'Hello');
    expect(fake.sent).toHaveLength(0);
    expect(status.problem?.kind).toBe('ledger');
  });
});

describe('agents as configuration', () => {
  it('reads Name | model | effort | tools | instructions, the instructions keeping their bars', () => {
    expect(agentOf('Revisor | claude-opus-5-5 | medium | * | Review. Use a | b.')).toEqual({
      agent: {
        name: 'Revisor',
        model: 'claude-opus-5-5',
        effort: 'medium',
        tools: '*',
        instructions: 'Review. Use a | b.',
      },
    });
    expect(agentOf('Seco | claude-sonnet-5-5 | high | - | Answer.')).toMatchObject({
      agent: { tools: [] },
    });
  });

  it('leaves out a line it cannot price, a bad effort, and a second agent of one name', () => {
    const read = agentsOf([
      'A | gpt-9 | low | * | x',
      'B | claude-haiku-5-5 | turbo | * | x',
      'C | claude-haiku-5-5 | low | * | x',
      'C | claude-opus-5-5 | low | * | y',
      'not an agent',
    ]);
    expect(read.agents.map((agent) => agent.name)).toEqual(['C']);
    expect(read.problems).toHaveLength(4);
    expect(read.problems[0]).toMatch(/no price for gpt-9/u);
  });

  it('starts from the two default agents, both priced', async () => {
    const { DEFAULT_AGENT_LINES } = await import('../src/api/agents.js');
    const read = agentsOf(DEFAULT_AGENT_LINES);
    expect(read.problems).toEqual([]);
    expect(read.agents.map((agent) => `${agent.name} ${agent.model}`)).toEqual([
      'Modelador claude-haiku-5-5',
      'Revisor claude-opus-5-5',
    ]);
  });

  it('switches agents between turns, each on its own model, in a fresh conversation', async () => {
    const fake = fakeHost({ answers: [DONE, DONE] });
    const lines = [AGENT, 'Revisor | claude-opus-5-5 | medium | * | You review briefs.'];
    const chat = apiConversation(fake.host, { settings: settings(10, lines), now: () => NOW });
    await turn(chat, 'Write one');
    expect(chat.useAgent('Revisor').agentName).toBe('Revisor');
    await turn(chat, 'Review it');
    expect(fake.sent.map((request) => request.body['model'])).toEqual([
      'claude-haiku-5-5',
      'claude-opus-5-5',
    ]);
    expect((fake.sent[1]?.body['messages'] as unknown[]).length).toBe(1);
    expect((fake.sent[1]?.body['tools'] as unknown[]).length).toBe(TOOLS.length);
  });
});

describe('the price table', () => {
  it('counts every billed kind of token, and the long-prompt rate where the model has one', () => {
    expect(
      costMicros('claude-opus-5-5', {
        input_tokens: 1000,
        output_tokens: 1000,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 1000,
      }),
    ).toBe(4000 + 20_000 + 200 + 5000);
    // Haiku 5.5 above 100K prompt tokens: $0.50 in, $2.50 out.
    expect(costMicros('claude-haiku-5-5', { input_tokens: 200_000, output_tokens: 1000 })).toBe(
      100_000 + 2500,
    );
    expect(costMicros('gpt-9', { input_tokens: 1, output_tokens: 1 })).toBeUndefined();
    expect(dollars(317)).toBe('0.0003');
    expect(dollars(12_340_000)).toBe('12.34');
  });
});
