import { defineConfig } from 'tsup';

/**
 * Two committed bundles, because Tyto installs a plugin by copying its folder and never builds
 * it; CI fails when either differs from a fresh build of `src/`.
 *
 * - `dist/index.js`: the plugin's process, one ES module with no imports, for any runtime.
 * - `adapter/launch.mjs`: the plugin's own program (Tyto ADR 0184 `programs`), on Tyto's Node,
 *   which fetches and runs the Claude ACP adapter (TYTO-666). It imports only Node's built-ins.
 */
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'es2022',
    platform: 'neutral',
    bundle: true,
    splitting: false,
    sourcemap: false,
    dts: false,
    minify: false,
    clean: true,
  },
  {
    entry: { launch: 'src/launcher/entry.ts' },
    outDir: 'adapter',
    outExtension: () => ({ js: '.mjs' }),
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    bundle: true,
    splitting: false,
    sourcemap: false,
    dts: false,
    minify: false,
    // `adapter/` also holds the committed lock.
    clean: false,
  },
]);
