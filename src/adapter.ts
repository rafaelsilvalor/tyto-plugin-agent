import type { PluginHost } from '@tyto/plugin-api';

import {
  INSTALL_ARGUMENT,
  type InstallFailureCode,
  type LauncherLine,
  STATUS_ARGUMENT,
  type StatusLine,
} from './launcher/protocol.js';

/**
 * The plugin's side of the launcher (`adapter/launch.mjs`, TYTO-666): it asks what is installed,
 * and runs the download the person accepted, reading the launcher's JSON lines through
 * `host.process` (Tyto ADR 0182). The plugin's own process downloads nothing and never sees the
 * files: it cannot (ADR 0049), and the launcher checks every byte against the lock.
 */

type Host = Pick<PluginHost, 'process'>;

/**
 * Starts `program` with `args`, hands each JSON line of its stdout to `onLine`, and resolves with
 * its exit code once it ends. A line that is not JSON is skipped: the launcher writes only JSON
 * there, so anything else is not addressed to the plugin.
 */
async function runLines(
  host: Host,
  program: string,
  args: readonly string[],
  onLine: (line: LauncherLine) => void,
): Promise<number | null> {
  const started = await host.process.start(program, [...args]);
  const decoder = new TextDecoder();
  let buffered = '';
  started.onStdout((bytes) => {
    buffered += decoder.decode(bytes, { stream: true });
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      const text = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      if (text === '') continue;
      try {
        const line = JSON.parse(text) as LauncherLine;
        if (typeof line === 'object' && line !== null && typeof line.tyto === 'string')
          onLine(line);
      } catch {
        // Not JSON: not the launcher's protocol.
      }
    }
  });
  const exit = await started.exited;
  return exit.code;
}

/** What the launcher says is installed, or `undefined` when it said nothing it should. */
export async function adapterStatus(host: Host, program: string): Promise<StatusLine | undefined> {
  let status: StatusLine | undefined;
  await runLines(host, program, [STATUS_ARGUMENT], (line) => {
    if (line.tyto === 'status') status = line;
  });
  return status;
}

export type InstallOutcome =
  | { readonly installed: true }
  | {
      readonly installed: false;
      readonly code: InstallFailureCode | 'unknown';
      readonly message: string;
    };

/** Runs the download the person accepted, saying how far it got. */
export async function installAdapter(
  host: Host,
  program: string,
  onProgress: (done: number, total: number) => void,
): Promise<InstallOutcome> {
  let outcome: InstallOutcome | undefined;
  const exit = await runLines(host, program, [INSTALL_ARGUMENT], (line) => {
    if (line.tyto === 'progress') onProgress(line.done, line.total);
    else if (line.tyto === 'installed') outcome = { installed: true };
    else if (line.tyto === 'failed')
      outcome = { installed: false, code: line.code, message: line.message };
  });
  return (
    outcome ?? {
      installed: false,
      code: 'unknown',
      message: `the download ended without saying how (exit ${String(exit)})`,
    }
  );
}

/** A size in the panel's words: megabytes, rounded, as the person reads it before accepting. */
export function megabytes(bytes: number): string {
  return String(Math.max(1, Math.round(bytes / 1_000_000)));
}
