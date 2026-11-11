/**
 * Anthropic's TypeScript SDK (`@anthropic-ai/sdk`, Apache-2.0), built on its own into
 * `dist/vendor/anthropic-sdk.js`, minified, with its licence beside it
 * (`dist/vendor/anthropic-sdk.LICENSE.txt`). `dist/index.js` imports it only when the API driver
 * runs, so the plugin's own bundle stays small and readable. See tsup.config.ts.
 */
export { default as Anthropic } from '@anthropic-ai/sdk';
