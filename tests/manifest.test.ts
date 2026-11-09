import { readFileSync } from 'node:fs';

import { testPlugin } from '@tyto/plugin-api/testing';
import { describe, expect, it } from 'vitest';

const manifest = readFileSync(new URL('../tyto-plugin.json', import.meta.url), 'utf8');
// The committed bundle, as Tyto loads it: a URL, so the type checker does not look for types.
const entry = new URL('../dist/index.js', import.meta.url).href;

describe('the manifest', () => {
  it('installs and activates against the contract this repository is built with', async () => {
    const harness = await testPlugin({ manifest, load: () => import(entry) });
    if (!harness.ok) throw new Error(harness.error.map((item) => item.message).join('\n'));
    expect(harness.value.manifest.name).toBe('agent');
    await harness.value.close();
  });
});
