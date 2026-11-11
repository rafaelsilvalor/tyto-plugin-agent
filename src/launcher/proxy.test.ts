import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { DATA_VARIABLE } from './launch.js';
import { useEnvironmentProxy } from './proxy.js';

/**
 * The launcher behind a proxy (TYTO-667), against a local CONNECT proxy that writes down every
 * tunnel it is asked for and refuses it. The target is a closed port on this machine, so nothing
 * leaves it, and reaching it directly fails with `ECONNREFUSED`: what the proxy saw is the proof.
 */

const undo: (() => void)[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const restore of undo.splice(0)) restore();
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

async function listening(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function proxyServer(): Promise<{ readonly url: string; readonly tunnels: string[] }> {
  const tunnels: string[] = [];
  const server = createServer();
  server.on('connect', (request, socket) => {
    tunnels.push(request.url ?? '');
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  return { url: `http://127.0.0.1:${String(await listening(server))}`, tunnels };
}

/** A port nothing listens on: one a server had, closed again. */
async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await listening(server);
  servers.pop();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function reach(url: string): Promise<string> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return 'answered';
  } catch (cause) {
    return String((cause as { cause?: { code?: unknown } }).cause?.code ?? 'failed');
  }
}

function using(environment: Record<string, string>): void {
  const restore = useEnvironmentProxy(environment);
  if (restore !== undefined) undo.push(restore);
}

describe('useEnvironmentProxy', () => {
  it('sends fetch through the proxy HTTPS_PROXY names, in either spelling', async () => {
    const proxy = await proxyServer();
    const target = `127.0.0.1:${String(await closedPort())}`;

    expect(await reach(`https://${target}/package.tgz`)).toBe('ECONNREFUSED');
    expect(proxy.tunnels).toEqual([]);

    using({ HTTPS_PROXY: proxy.url });
    await reach(`https://${target}/package.tgz`);
    expect(proxy.tunnels).toEqual([target]);

    for (const restore of undo.splice(0)) restore();
    using({ https_proxy: proxy.url });
    await reach(`https://${target}/package.tgz`);
    expect(proxy.tunnels).toEqual([target, target]);
  });

  it('goes direct to a host NO_PROXY lists', async () => {
    const proxy = await proxyServer();
    const port = await closedPort();
    using({ HTTPS_PROXY: proxy.url, NO_PROXY: '127.0.0.1' });
    expect(await reach(`https://127.0.0.1:${String(port)}/package.tgz`)).toBe('ECONNREFUSED');
    expect(proxy.tunnels).toEqual([]);
  });

  it('touches nothing without a proxy variable, or on a Node without the function', () => {
    const calls: unknown[] = [];
    const spy = (environment: unknown) => {
      calls.push(environment);
      return () => undefined;
    };
    expect(useEnvironmentProxy({ PATH: '/bin', NO_PROXY: 'x', HTTPS_PROXY: '' }, spy)).toBe(
      undefined,
    );
    expect(calls).toEqual([]);
    expect(useEnvironmentProxy({ HTTPS_PROXY: 'http://proxy:3128' }, null)).toBe(undefined);
    expect(useEnvironmentProxy({ http_proxy: 'http://proxy:3128' }, spy)).toBeTypeOf('function');
    expect(calls).toEqual([{ http_proxy: 'http://proxy:3128' }]);
  });
});

describe('the built launcher, behind a proxy', () => {
  it('asks the proxy for the registry when it downloads, as Tyto starts it', async () => {
    const proxy = await proxyServer();
    const data = mkdtempSync(join(tmpdir(), 'tyto-agent-proxy-'));
    try {
      // Only what ADR 0182 passes a plugin's program: no NODE_USE_ENV_PROXY.
      const said = await new Promise<string>((resolve) => {
        execFile(
          process.execPath,
          [fileURLToPath(new URL('../../adapter/launch.mjs', import.meta.url)), '--tyto-install'],
          { env: { PATH: '', HTTPS_PROXY: proxy.url, [DATA_VARIABLE]: data }, timeout: 60_000 },
          (_error, stdout) => resolve(stdout),
        );
      });
      expect(proxy.tunnels.length).toBeGreaterThan(0);
      expect(new Set(proxy.tunnels)).toEqual(new Set(['registry.npmjs.org:443']));
      // The proxy refused every tunnel, so the install failed, saying it was the network.
      expect(said).toContain('"code":"network"');
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  }, 90_000);
});
