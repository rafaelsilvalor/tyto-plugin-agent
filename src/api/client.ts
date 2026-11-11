import type Anthropic from '@anthropic-ai/sdk';
import type { PluginHost } from '@tyto/plugin-api';

/**
 * The Claude API client, over the host's network (TYTO-661).
 *
 * **The plugin never holds the person's key.** The key is a credential the panel's page stores
 * straight into Tyto's keychain (`credentials:anthropic-api-key`, Tyto ADR 0134), and every
 * request asks the host to put it in the `x-api-key` header itself (`credentialHeaders`, Tyto ADR
 * 0191), only for `api.anthropic.com`, which the manifest names. The SDK is given a placeholder,
 * so it resolves no credential of its own, and the placeholder's header is dropped here before
 * the request leaves.
 *
 * The plugin's process has no `fetch` (Tyto ADR 0049): the SDK gets this one, built on
 * `host.fetch`, which answers a response whole. So a request is never streamed, and the SDK's
 * request timeout cannot cut a request the host is still making.
 */

export const API_KEY_CREDENTIAL = 'anthropic-api-key';
export const API_HOST = 'api.anthropic.com';
/** What the SDK is told its key is. Never sent: `apiFetch` drops the header it lands in. */
const PLACEHOLDER = 'set-by-tyto-host';

/** `host.fetch` with the field Tyto 0.20 added; typed here so the plugin builds on 0.18's types. */
export interface CredentialFetchInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  readonly credentialHeaders?: Readonly<Record<string, string>>;
}

export type HostFetch = (
  url: string,
  init?: CredentialFetchInit,
) => ReturnType<PluginHost['fetch']>;

/** Statuses whose response has no body, which `Response` refuses one for. */
const NO_BODY = new Set([101, 204, 205, 304]);

/** A `fetch` for the SDK, on the host's network, with the key added by the host. */
export function apiFetch(fetch: HostFetch): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    delete headers['x-api-key'];
    delete headers['authorization'];
    const body = init?.body === undefined || init.body === null ? undefined : await request.text();
    const answer = await fetch(request.url, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      credentialHeaders: { 'x-api-key': API_KEY_CREDENTIAL },
    });
    return new Response(NO_BODY.has(answer.status) ? null : answer.body, {
      status: answer.status,
      statusText: answer.statusText,
      headers: answer.headers,
    });
  };
}

/** The SDK, loaded only when the API driver runs: the panel's ACP driver never pays for it. */
export async function apiClient(fetch: HostFetch): Promise<Anthropic> {
  const { Anthropic: Client } = await import('../vendor/anthropic-sdk.js');
  return new Client({
    apiKey: PLACEHOLDER,
    fetch: apiFetch(fetch),
    // The host answers whole: a retry is the SDK's, on a 429 or a 5xx, at most twice.
    maxRetries: 2,
  });
}
