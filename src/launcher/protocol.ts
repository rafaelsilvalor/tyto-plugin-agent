/**
 * What the launcher (`adapter/launch.mjs`) and the plugin's process say to each other, besides
 * ACP. The plugin starts the launcher through `host.process` with one of these first arguments
 * and reads one JSON object per line on its stdout. Any other arguments run the adapter itself.
 *
 * Shared by both bundles, so it imports nothing.
 */

/** Answers one `StatusLine` and exits. */
export const STATUS_ARGUMENT = '--tyto-status';
/** Installs the pinned adapter, answering `ProgressLine`s and one `InstalledLine` or `FailedLine`. */
export const INSTALL_ARGUMENT = '--tyto-install';

/**
 * Where the person's `claude` stands: found, missing, or only an old npm shim that runs `cli.js`,
 * which the adapter cannot start (TYTO-667).
 */
export type ClaudeFound = 'found' | 'missing' | 'shim';

export interface StatusLine {
  readonly tyto: 'status';
  /** Tyto set `TYTO_PROGRAM_DATA` (Tyto 0.18 and later, ADR 0187). */
  readonly data: boolean;
  readonly installed: boolean;
  /** An earlier pin already in the data folder: the person accepted a download before. */
  readonly previous: string | null;
  readonly version: string;
  readonly bytes: number;
  /** The registry's host, which the panel names before the person accepts. */
  readonly source: string;
  readonly claude: ClaudeFound;
}

export interface ProgressLine {
  readonly tyto: 'progress';
  readonly done: number;
  readonly total: number;
}

export interface InstalledLine {
  readonly tyto: 'installed';
  readonly version: string;
}

export type InstallFailureCode =
  'integrity' | 'network' | 'unsafe-archive' | 'lock' | 'disk' | 'no-data';

export interface FailedLine {
  readonly tyto: 'failed';
  readonly code: InstallFailureCode;
  readonly message: string;
}

export type LauncherLine = StatusLine | ProgressLine | InstalledLine | FailedLine;

/**
 * The exit code of a launcher that could not run the adapter (missing, no data folder, no
 * `claude`), after one line on stderr saying why. 78 is `EX_CONFIG`.
 */
export const NOT_READY_EXIT = 78;
