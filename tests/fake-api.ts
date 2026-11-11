import type { ApiHost } from '../src/api/conversation.js';
import type { CredentialFetchInit } from '../src/api/client.js';

/**
 * A fake Claude API and a fake Tyto host for the API driver's tests (TYTO-661).
 *
 * The API answers with Messages API responses in the shape the API documents, written by hand
 * and served in order: **not recorded from a live call**, since no key was used. The driver talks
 * to it through the real SDK and the real `apiFetch`, so what is tested is the request the SDK
 * sends and how the driver reads the answer.
 *
 * The host keeps the person's key the way Tyto does: only the host knows it, and it is added to a
 * request when `credentialHeaders` asks for it. `SECRET` is a probe: every test that looks for it
 * outside the host's own request is the point.
 */

export const SECRET = 'sk-ant-probe-3c9e0d71';

export interface SentRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly credentialHeaders: Readonly<Record<string, string>> | undefined;
  readonly body: Record<string, unknown>;
}

export interface Answer {
  readonly status?: number;
  readonly body: unknown;
}

let messageNumber = 0;

/** A Messages API response, as the API sends it. */
export function message(
  content: readonly Record<string, unknown>[],
  stopReason: string,
  usage: Partial<Record<string, number>> = {},
  model = 'claude-haiku-5-5',
): Answer {
  messageNumber += 1;
  return {
    body: {
      id: `msg_fake_${String(messageNumber)}`,
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        ...usage,
      },
    },
  };
}

export const TOOLS = [
  {
    name: 'check_brief',
    description: 'Checks a brief and lists its problems.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'propose_edit',
    description: 'Proposes an edit of the brief in front.',
    inputSchema: { type: 'object', properties: { edits: { type: 'array' } } },
  },
  {
    name: 'export',
    description: 'Exports a brief.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export interface FakeHost {
  readonly host: ApiHost;
  readonly sent: SentRequest[];
  readonly calls: { name: string; input: unknown }[];
  readonly logged: string[];
  readonly records: Map<string, string>;
  /** Every value the plugin handed the host's config or storage, for the leak check. */
  readonly written: unknown[];
  /** Whether the plugin ever asked for a credential's value. */
  readonly credentialsRead: string[];
}

export interface FakeHostOptions {
  readonly answers: Answer[];
  readonly settings?: Record<string, unknown>;
  /** No `storage`: a Tyto before 0.19. */
  readonly oldTyto?: boolean;
  /** No window tools: a Tyto before 0.19. */
  readonly noTools?: boolean;
  /** The person has stored no key. */
  readonly noKey?: boolean;
  readonly records?: Map<string, string>;
}

export function fakeHost(options: FakeHostOptions): FakeHost {
  const sent: SentRequest[] = [];
  const calls: { name: string; input: unknown }[] = [];
  const logged: string[] = [];
  const written: unknown[] = [];
  const credentialsRead: string[] = [];
  const records = options.records ?? new Map<string, string>();
  const answers = [...options.answers];
  const log = (line: string) => logged.push(line);

  const fetch = (url: string, init: CredentialFetchInit = {}) => {
    const headers = { ...init.headers };
    if (init.credentialHeaders !== undefined) {
      for (const [header, key] of Object.entries(init.credentialHeaders)) {
        // As Tyto refuses it (ADR 0191): a header set both ways is a mistake, not a choice.
        if (Object.keys(headers).some((name) => name.toLowerCase() === header.toLowerCase())) {
          return Promise.reject(
            new TypeError(
              `host.fetch was given '${header}' both as a header and as a credential header.`,
            ),
          );
        }
        if (key !== 'anthropic-api-key' || options.noKey === true) {
          return Promise.reject(
            Object.assign(new Error(`Plugin 'agent' asked for credential '${key}'`), {
              code: 'E_CREDENTIAL_MISSING',
            }),
          );
        }
        headers[header] = SECRET;
      }
    }
    sent.push({
      url,
      headers,
      credentialHeaders: init.credentialHeaders,
      body: JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>,
    });
    const answer =
      answers.shift() ?? message([{ type: 'text', text: 'no more answers' }], 'end_turn');
    const status = headers['x-api-key'] === SECRET ? (answer.status ?? 200) : 401;
    return Promise.resolve({
      url,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      ok: status >= 200 && status < 300,
      headers: { 'content-type': 'application/json', 'request-id': 'req_fake' },
      body: new TextEncoder().encode(JSON.stringify(answer.body)),
      text: () => Promise.resolve(JSON.stringify(answer.body)),
      json: () => Promise.resolve(answer.body),
    });
  };

  const window = {
    agentServer: () => Promise.reject(new Error('not this test')),
    ...(options.noTools === true
      ? {}
      : {
          tools: () => Promise.resolve(TOOLS),
          callTool: (name: string, input: Record<string, unknown>) => {
            calls.push({ name, input });
            return Promise.resolve({
              content: [{ type: 'text', text: `${name}: 2 problems` }],
              isError: false,
            });
          },
        }),
  };

  const settings = options.settings ?? {};
  const host = {
    config: () => {
      written.push(settings);
      return settings;
    },
    log: { debug: log, info: log, warn: log, error: log },
    fetch,
    window,
    credentials: Object.assign(
      (key: string) => {
        credentialsRead.push(key);
        return Promise.resolve(SECRET);
      },
      { set: () => Promise.resolve(), delete: () => Promise.resolve(true) },
    ),
    ...(options.oldTyto === true
      ? {}
      : {
          storage: {
            get: (key: string) => {
              const json = records.get(key);
              if (json === undefined) return Promise.resolve(undefined);
              try {
                return Promise.resolve(JSON.parse(json) as unknown);
              } catch {
                return Promise.reject(
                  Object.assign(new Error('unreadable'), { code: 'E_PLUGIN_STORAGE' }),
                );
              }
            },
            set: (key: string, value: unknown) => {
              written.push(value);
              records.set(key, JSON.stringify(value));
              return Promise.resolve();
            },
            delete: (key: string) => Promise.resolve(records.delete(key)),
          },
        }),
  } as unknown as ApiHost;

  return { host, sent, calls, logged, records, written, credentialsRead };
}
