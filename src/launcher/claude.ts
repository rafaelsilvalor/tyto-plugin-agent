import { readFileSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

import type { ClaudeFound } from './protocol.js';

/** What the launcher needs of the disk to find `claude`: injected so a test can fake it. */
export interface ClaudeDisk {
  readonly isFile: (path: string) => boolean;
  /** The text of a file, or `undefined` when it cannot be read. */
  readonly readText: (path: string) => string | undefined;
}

const nodeDisk: ClaudeDisk = {
  isFile: (path) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false,
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
};

export interface ClaudeLocation {
  readonly found: ClaudeFound;
  /** The program for `CLAUDE_CODE_EXECUTABLE`, when found. */
  readonly path?: string;
}

/**
 * The person's own `claude`, found on `PATH` the way a shell finds it, for
 * `CLAUDE_CODE_EXECUTABLE`. Without it the adapter runs the SDK's own binary, a 331 MB package the
 * launcher never downloads (TYTO-657 measured it), so a missing `claude` is a refusal, not a
 * fallback.
 *
 * On Windows the SDK starts the executable without a shell, so an npm `claude.cmd` cannot be run
 * as it is. The `.exe` it points at is taken instead (TYTO-667): see `shimTarget`. A shim that
 * points at no `.exe` is reported as `shim`, and the panel refuses with its bilingual message.
 */
export function findClaude(
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>>,
  disk: ClaudeDisk = nodeDisk,
): ClaudeLocation {
  const windows = platform === 'win32';
  const path = windows ? win32 : posix;
  // Windows spells it `Path`, and keys there are not case-sensitive.
  const search =
    Object.entries(environment).find(
      ([key]) => (windows ? key.toUpperCase() : key) === 'PATH',
    )?.[1] ?? '';
  let shim = false;
  for (const folder of search.split(windows ? ';' : ':')) {
    if (folder === '' || !path.isAbsolute(folder)) continue;
    if (windows) {
      const binary = path.join(folder, 'claude.exe');
      if (disk.isFile(binary)) return { found: 'found', path: binary };
      const command = path.join(folder, 'claude.cmd');
      if (disk.isFile(command)) {
        const target = shimTarget(folder, disk.readText(command) ?? '', disk.isFile);
        if (target !== undefined) return { found: 'found', path: target };
        shim = true;
      } else if (disk.isFile(path.join(folder, 'claude'))) {
        shim = true;
      }
    } else {
      const binary = path.join(folder, 'claude');
      if (disk.isFile(binary)) return { found: 'found', path: binary };
    }
  }
  return { found: shim ? 'shim' : 'missing' };
}

/** A quoted `"%dp0%\…"` path in an npm shim: npm's cmd-shim writes its target that way. */
const SHIM_PATH = /"%dp0%\\([^"%]+)"/giu;

/**
 * The `.exe` an npm `claude.cmd` in `folder` starts, read from its text and never by running it:
 * the first `"%dp0%\node_modules\…\<name>.exe"` path that exists. Claude Code's npm package points
 * its shim at `bin\claude.exe` from 2.1.200 on.
 *
 * Up to 2.1.100 at least the shim runs `cli.js` on Node instead. That stays refused: the adapter
 * starts `CLAUDE_CODE_EXECUTABLE` itself, without Node, for the login, the sign-in probe and the
 * logout, and Windows answers `spawn EFTYPE` for a `.js` (measured, TYTO-667). Nothing outside
 * the shim's own `node_modules` is taken, so a shim cannot send the launcher anywhere else.
 */
export function shimTarget(
  folder: string,
  text: string,
  isFile: (path: string) => boolean,
): string | undefined {
  const modules = win32.join(folder, 'node_modules') + win32.sep;
  for (const match of text.matchAll(SHIM_PATH)) {
    const path = win32.resolve(folder, match[1] ?? '');
    if (!path.toLowerCase().startsWith(modules.toLowerCase())) continue;
    if (path.toLowerCase().endsWith('.exe') && isFile(path)) return path;
  }
  return undefined;
}
