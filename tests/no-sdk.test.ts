import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Nothing of Anthropic's Claude Agent SDK is ever in this repository (TYTO-666, after TYTO-662).
 * The SDK is not open source: its licence keeps every right with Anthropic, and nothing in
 * Anthropic's terms allows copying it into a public repository. The launcher downloads it from npm
 * into the person's own Tyto folder instead, and the lock names it only by address and hash.
 *
 * This reads every file git tracks, as CI checks it out. Patterns are built from pieces so this file
 * does not match itself.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\u0000')
  .filter((path) => path !== '');

const SDK = ['claude', 'agent', 'sdk'].join('-');
const LICENCE = [`© ${'Anthropic'} PBC`, ['All', 'rights', 'reserved'].join(' ')];
const CODE = /\.(?:[cm]?js|ts|json|node|wasm)$/u;
/** The largest file this repository holds on purpose is the plugin's bundle, 24 KB. */
const LIMIT = 1024 * 1024;

describe('the repository holds no SDK code', () => {
  it('tracks no node_modules folder, and no file under a path named after the SDK', () => {
    expect(tracked.filter((path) => /(?:^|\/)node_modules\//u.test(path))).toEqual([]);
    expect(tracked.filter((path) => path.includes(SDK))).toEqual([]);
  });

  it('tracks no file carrying the SDK’s licence text', () => {
    const carrying = tracked.filter((path) => {
      const text = readFileSync(`${root}/${path}`, 'latin1');
      return LICENCE.some((marker) => text.includes(marker));
    });
    expect(carrying).toEqual([]);
  });

  it('names the SDK in code only in the lock, and as an address, never its source', () => {
    const naming = tracked.filter(
      (path) =>
        CODE.test(path) &&
        path !== 'adapter/lock.json' &&
        !path.endsWith('.test.ts') &&
        readFileSync(`${root}/${path}`, 'utf8').includes(`@anthropic-ai/${SDK}`),
    );
    expect(naming).toEqual([]);
  });

  it('tracks no file over 1 MiB: a bundled SDK would be several', () => {
    expect(tracked.filter((path) => statSync(`${root}/${path}`).size > LIMIT)).toEqual([]);
  });
});
