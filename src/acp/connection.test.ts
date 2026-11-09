import { describe, expect, it } from 'vitest';

import { AUTH_REQUIRED, RpcError, connect, lineReader } from './connection.js';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('lineReader', () => {
  it('joins a message split across chunks, and reads CRLF and blank lines', () => {
    const lines: string[] = [];
    const read = lineReader((line) => lines.push(line));
    read(bytes('{"a":'));
    read(bytes('1}\r\n\n{"b":2}\n{"c"'));
    read(bytes(':3}\n'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('keeps a multibyte character split across chunks whole', () => {
    const lines: string[] = [];
    const read = lineReader((line) => lines.push(line));
    const encoded = bytes('{"t":"olá"}\n');
    read(encoded.slice(0, 10));
    read(encoded.slice(10));
    expect(lines).toEqual(['{"t":"olá"}']);
  });
});

function wire() {
  const written: Record<string, unknown>[] = [];
  let deliver: (chunk: Uint8Array) => void = () => undefined;
  const problems: string[] = [];
  const connection = connect(
    {
      write: (text) => {
        expect(text.endsWith('\n')).toBe(true);
        expect(text.slice(0, -1)).not.toContain('\n');
        written.push(JSON.parse(text) as Record<string, unknown>);
        return Promise.resolve();
      },
      onStdout: (listener) => {
        deliver = listener;
        return () => undefined;
      },
    },
    { onProblem: (problem) => problems.push(problem) },
  );
  return {
    connection,
    written,
    problems,
    say: (message: unknown) => deliver(bytes(`${JSON.stringify(message)}\n`)),
  };
}

describe('connect', () => {
  it('matches answers to requests by id, and keeps an error answer’s code', async () => {
    const { connection, written, say } = wire();
    const first = connection.request('initialize', { protocolVersion: 1 });
    const second = connection.request('session/new', { cwd: '/w', mcpServers: [] });
    say({
      jsonrpc: '2.0',
      id: 2,
      error: { code: AUTH_REQUIRED, message: 'Authentication required' },
    });
    say({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
    expect(await first).toEqual({ protocolVersion: 1 });
    const refused = await second.catch((cause: unknown) => cause);
    expect(refused).toBeInstanceOf(RpcError);
    expect((refused as RpcError).code).toBe(AUTH_REQUIRED);
    expect(
      written.map((message) => [message['id'], message['method'], message['jsonrpc']]),
    ).toEqual([
      [1, 'initialize', '2.0'],
      [2, 'session/new', '2.0'],
    ]);
  });

  it('answers the agent’s own requests, and says so when nothing handles one', async () => {
    const { connection, written, say } = wire();
    connection.handle('session/request_permission', () => ({ outcome: { outcome: 'cancelled' } }));
    say({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: {} });
    say({ jsonrpc: '2.0', id: 8, method: 'fs/read_text_file', params: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Each answer goes when its handler is done, so their order is not the requests' order.
    expect(written).toHaveLength(2);
    expect(written).toEqual(
      expect.arrayContaining([
        { jsonrpc: '2.0', id: 7, result: { outcome: { outcome: 'cancelled' } } },
        {
          jsonrpc: '2.0',
          id: 8,
          error: { code: -32601, message: 'no handler for fs/read_text_file' },
        },
      ]),
    );
  });

  it('reports a line that is not JSON and goes on reading', async () => {
    const { connection, problems, say } = wire();
    const answer = connection.request('initialize', {});
    say('not json');
    say({ jsonrpc: '2.0', id: 1, result: 'ok' });
    expect(await answer).toBe('ok');
    expect(problems).toEqual(['the agent wrote a line that is not JSON: "not json"']);
  });

  it('rejects what is waiting when the program ends', async () => {
    const { connection } = wire();
    const answer = connection.request('session/prompt', {});
    connection.close('the agent ended');
    await expect(answer).rejects.toThrow('the agent ended');
    await expect(connection.request('initialize', {})).rejects.toThrow('the agent ended');
  });
});
