import { statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

import type { ClaudeFound } from './protocol.js';

/**
 * The person's own `claude`, found on `PATH` the way a shell finds it, for
 * `CLAUDE_CODE_EXECUTABLE`. Without it the adapter runs the SDK's own binary, a 331 MB package the
 * launcher never downloads (TYTO-657 measured it), so a missing `claude` is a refusal, not a
 * fallback.
 *
 * On Windows only `claude.exe` is used: the SDK starts the executable without a shell, and an npm
 * `claude.cmd` is a script only `cmd.exe` runs. One found without an `.exe` is reported as `shim`.
 */
export function findClaude(
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>>,
  isFile: (path: string) => boolean = (path) =>
    statSync(path, { throwIfNoEntry: false })?.isFile() ?? false,
): { readonly found: ClaudeFound; readonly path?: string } {
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
      if (isFile(binary)) return { found: 'found', path: binary };
      if (isFile(path.join(folder, 'claude.cmd')) || isFile(path.join(folder, 'claude')))
        shim = true;
    } else {
      const binary = path.join(folder, 'claude');
      if (isFile(binary)) return { found: 'found', path: binary };
    }
  }
  return { found: shim ? 'shim' : 'missing' };
}
