import { copyFileSync, mkdirSync } from 'node:fs';

import { type Options, defineConfig } from 'tsup';

/**
 * `src/api/client.ts` imports `../vendor/anthropic-sdk.js`; in the bundle that file is
 * `dist/vendor/anthropic-sdk.js`, beside `dist/index.js`, so the import is kept out of the bundle
 * and rewritten to the path it has there.
 */
const VENDOR_SDK: NonNullable<Options['esbuildPlugins']>[number] = {
  name: 'vendor-sdk',
  setup(build) {
    // No `u` flag: esbuild runs the filter as a Go regular expression, which has none.
    build.onResolve({ filter: /\/vendor\/anthropic-sdk\.js$/ }, () => ({
      path: './vendor/anthropic-sdk.js',
      external: true,
    }));
  },
};

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
    // Not cleaned: the SDK's build below writes into `dist/vendor/` at the same time.
    clean: false,
    esbuildPlugins: [VENDOR_SDK],
  },
  {
    // Anthropic's TypeScript SDK (Apache-2.0) for the API driver (TYTO-661): one file of its own,
    // minified (427 KB against 1.3 MB, which the repository's 1 MiB rule refuses), loaded only
    // when the API driver runs, with the SDK's licence copied beside it.
    entry: { 'vendor/anthropic-sdk': 'src/vendor/anthropic-sdk.ts' },
    format: ['esm'],
    target: 'es2022',
    platform: 'neutral',
    bundle: true,
    noExternal: [/.*/u],
    splitting: false,
    sourcemap: false,
    dts: false,
    minify: true,
    clean: false,
    onSuccess: async () => {
      mkdirSync('dist/vendor', { recursive: true });
      copyFileSync(
        'node_modules/@anthropic-ai/sdk/LICENSE',
        'dist/vendor/anthropic-sdk.LICENSE.txt',
      );
      copyFileSync(
        'node_modules/@anthropic-ai/sdk/LICENSE-MIT',
        'dist/vendor/anthropic-sdk.LICENSE-MIT.txt',
      );
    },
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
