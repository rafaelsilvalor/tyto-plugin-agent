import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { findClaude } from './claude.js';
import {
  type AdapterLock,
  InstallError,
  install,
  installedState,
  lockDigest,
  parseLock,
} from './install.js';
import {
  INSTALL_ARGUMENT,
  type LauncherLine,
  NOT_READY_EXIT,
  STATUS_ARGUMENT,
} from './protocol.js';

/**
 * `adapter/launch.mjs`: the program `process:claude-agent-acp` runs (Tyto ADR 0184 `programs`).
 * It is this plugin's own code, committed and small. The adapter it runs is not: it is fetched
 * from npm into the plugin's data folder at the version `adapter/lock.json` pins (TYTO-666, ADR
 * 0187), the way Zed installs it.
 *
 * - `--tyto-status`: one line saying what is installed and whether `claude` is there.
 * - `--tyto-install`: download, check and unpack the pinned adapter, saying how far it got.
 * - anything else: run the adapter with those arguments (ACP on stdio, or `--cli auth login` in a
 *   Tyto terminal), with `CLAUDE_CODE_EXECUTABLE` set to the person's own `claude`.
 */

/** Tyto's name for the plugin's data folder (`PROGRAM_DATA_VARIABLE`, ADR 0187). */
export const DATA_VARIABLE = 'TYTO_PROGRAM_DATA';

function say(line: LauncherLine): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function notReady(reason: string): never {
  process.stderr.write(`tyto-plugin-agent: ${reason}\n`);
  process.exit(NOT_READY_EXIT);
}

async function download(url: string): Promise<Uint8Array> {
  let last: unknown;
  // One retry: a registry hiccup should not cost the person a second click.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (response.status !== 200) throw new Error(`HTTP ${String(response.status)}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (cause) {
      last = cause;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export async function main(argv: readonly string[]): Promise<void> {
  const lockSource = readFileSync(new URL('./lock.json', import.meta.url), 'utf8');
  let lock: AdapterLock;
  try {
    lock = parseLock(lockSource);
  } catch (cause) {
    if (argv[0] === INSTALL_ARGUMENT) {
      say({ tyto: 'failed', code: 'lock', message: (cause as Error).message });
      process.exit(1);
    }
    return notReady((cause as Error).message);
  }
  const digest = lockDigest(lockSource);
  const data = process.env[DATA_VARIABLE];
  const hasData = typeof data === 'string' && data !== '';

  if (argv[0] === STATUS_ARGUMENT) {
    const state = hasData ? installedState(lock, digest, data) : undefined;
    say({
      tyto: 'status',
      data: hasData,
      installed: state?.installed ?? false,
      previous: state?.previous ?? null,
      version: lock.adapter.version,
      bytes: lock.bytes,
      source: new URL(lock.registry).host,
      claude: findClaude(process.platform, process.env).found,
    });
    return;
  }

  if (argv[0] === INSTALL_ARGUMENT) {
    if (!hasData) {
      say({
        tyto: 'failed',
        code: 'no-data',
        message: `Tyto gave this program no data folder (${DATA_VARIABLE}): it needs Tyto 0.18 or later`,
      });
      process.exit(1);
    }
    try {
      await install(lock, digest, data, { download }, ({ done, total }) =>
        say({ tyto: 'progress', done, total }),
      );
      say({ tyto: 'installed', version: lock.adapter.version });
    } catch (cause) {
      const failure =
        cause instanceof InstallError
          ? cause
          : new InstallError('disk', cause instanceof Error ? cause.message : String(cause));
      say({ tyto: 'failed', code: failure.code, message: failure.message });
      process.exit(1);
    }
    return;
  }

  if (!hasData) notReady(`no data folder (${DATA_VARIABLE}): this plugin needs Tyto 0.18 or later`);
  const state = installedState(lock, digest, data);
  if (state.entry === null) notReady(`the adapter ${lock.adapter.version} is not downloaded yet`);
  const claude = findClaude(process.platform, process.env);
  if (claude.path === undefined)
    notReady(`claude is ${claude.found === 'shim' ? 'only an npm shim' : 'not on PATH'}`);
  process.env['CLAUDE_CODE_EXECUTABLE'] = claude.path;
  // The adapter reads `process.argv` as its own bin would: `node <file> <args…>`.
  process.argv = [process.argv[0] ?? 'node', state.entry, ...argv];
  await import(pathToFileURL(state.entry).href);
}
