/**
 * JSON-RPC 2.0 over newline-delimited JSON, as ACP's stdio transport frames it: UTF-8, one
 * message per line, no newline inside a message (agentclientprotocol.com/protocol/transports,
 * read on 2026-11-09). Both sides send requests: the client asks `session/prompt`, the agent asks
 * `session/request_permission`.
 *
 * No dependency: the plugin ships as one bundle with no imports, and the part of ACP a chat panel
 * needs is small enough to write here and test against a fake agent.
 */

/** Where bytes go and come from: a program the host started (`host.process`). */
export interface Transport {
  write(text: string): Promise<void>;
  onStdout(listener: (bytes: Uint8Array) => void): () => void;
}

/** A JSON-RPC error answer, kept whole so a caller can read `code` (ACP: -32000 is auth). */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

/** ACP's "authentication required" (schema-v1.30.0). */
export const AUTH_REQUIRED = -32000;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

type Handler = (params: unknown) => unknown;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** Splits bytes into lines, keeping a partial line for the next chunk. */
export function lineReader(onLine: (line: string) => void): (bytes: Uint8Array) => void {
  const decoder = new TextDecoder();
  let buffered = '';
  return (bytes) => {
    buffered += decoder.decode(bytes, { stream: true });
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      const line = buffered.slice(0, end).replace(/\r$/u, '');
      buffered = buffered.slice(end + 1);
      if (line.trim() !== '') onLine(line);
    }
  };
}

export interface Connection {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  /** What answers a request or a notification the agent sends. */
  handle(method: string, handler: Handler): void;
  /** Rejects every request still waiting: the program ended. */
  close(reason: string): void;
}

export function connect(
  transport: Transport,
  options: { readonly onProblem?: (problem: string) => void } = {},
): Connection {
  const pending = new Map<number, Pending>();
  const handlers = new Map<string, Handler>();
  let nextId = 1;
  let closed: string | undefined;

  const send = (message: Record<string, unknown>): Promise<void> =>
    // JSON.stringify never writes a raw newline, so one message stays one line.
    transport.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

  async function answer(id: unknown, method: string, params: unknown): Promise<void> {
    const handler = handlers.get(method);
    if (handler === undefined) {
      await send({ id, error: { code: METHOD_NOT_FOUND, message: `no handler for ${method}` } });
      return;
    }
    try {
      const result = await handler(params);
      await send({ id, result: result ?? null });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await send({ id, error: { code: INTERNAL_ERROR, message } });
    }
  }

  function heard(line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      message = parsed as Record<string, unknown>;
    } catch {
      options.onProblem?.(`the agent wrote a line that is not JSON: ${line.slice(0, 200)}`);
      return;
    }
    const { id, method } = message;
    if (typeof method === 'string') {
      if (id === undefined) {
        // A notification: nothing answers it, and a failure stays here.
        void Promise.resolve()
          .then(() => handlers.get(method)?.(message['params']))
          .catch((cause: unknown) => options.onProblem?.(String(cause)));
      } else {
        void answer(id, method, message['params']).catch((cause: unknown) =>
          options.onProblem?.(String(cause)),
        );
      }
      return;
    }
    if (typeof id !== 'number') return;
    const waiting = pending.get(id);
    if (waiting === undefined) return;
    pending.delete(id);
    const error = message['error'] as
      { code?: unknown; message?: unknown; data?: unknown } | undefined;
    if (error !== undefined && error !== null) {
      waiting.reject(
        new RpcError(
          typeof error.code === 'number' ? error.code : INTERNAL_ERROR,
          typeof error.message === 'string' ? error.message : 'the agent answered an error',
          error.data,
        ),
      );
    } else {
      waiting.resolve(message['result']);
    }
  }

  transport.onStdout(lineReader(heard));

  return {
    request(method, params) {
      if (closed !== undefined) return Promise.reject(new Error(closed));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ id, method, params }).catch((cause: unknown) => {
          pending.delete(id);
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        });
      });
    },
    notify(method, params) {
      if (closed !== undefined) return Promise.resolve();
      return send({ method, params });
    },
    handle(method, handler) {
      handlers.set(method, handler);
    },
    close(reason) {
      closed = reason;
      for (const waiting of pending.values()) waiting.reject(new Error(reason));
      pending.clear();
    },
  };
}
