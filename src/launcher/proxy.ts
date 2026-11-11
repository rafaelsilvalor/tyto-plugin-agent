import http from 'node:http';

/** `http.setGlobalProxyFromEnv`: Tyto's Node 24.21 has it; an older Node may not. */
type SetGlobalProxy = (environment: Readonly<Record<string, string | undefined>>) => () => void;

const PROXY_VARIABLES = new Set(['HTTPS_PROXY', 'HTTP_PROXY']);

/**
 * Sends the launcher's own requests through the proxy the environment names (TYTO-667). Node's
 * `fetch` reads `HTTPS_PROXY` only when `NODE_USE_ENV_PROXY=1` was set before it started, which
 * Tyto never sets for a plugin's program (ADR 0182 decision 8 passes `HTTP_PROXY`, `HTTPS_PROXY`
 * and `NO_PROXY` through, nothing more). `setGlobalProxyFromEnv` turns the same support on from
 * inside, and honours `NO_PROXY` and the lower-case spellings.
 *
 * Does nothing without a proxy variable, or on a Node that lacks the function. Returns what undoes
 * it, for a test; the launcher never undoes it.
 */
export function useEnvironmentProxy(
  environment: Readonly<Record<string, string | undefined>>,
  setGlobal: SetGlobalProxy | null = (http as { setGlobalProxyFromEnv?: SetGlobalProxy })
    .setGlobalProxyFromEnv ?? null,
): (() => void) | undefined {
  const named = Object.entries(environment).some(
    ([key, value]) => PROXY_VARIABLES.has(key.toUpperCase()) && value !== undefined && value !== '',
  );
  if (!named || typeof setGlobal !== 'function') return undefined;
  return setGlobal(environment);
}
