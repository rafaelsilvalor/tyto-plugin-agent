import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { PROGRAM_DATA_VARIABLE } from '@tyto/plugin-api';
import { afterEach, describe, expect, it } from 'vitest';

import { findClaude, shimTarget } from './claude.js';
import {
  type AdapterLock,
  InstallError,
  install,
  installedState,
  integrityOf,
  lockDigest,
  parseLock,
} from './install.js';
import { DATA_VARIABLE } from './launch.js';
import { readTar } from './tar.js';

/**
 * The launcher (`adapter/launch.mjs`, TYTO-666) on a real temp disk, with tarballs built here and a
 * download that never leaves the process: what it writes, what it refuses, and that nothing is
 * left half-installed. The registry is never reached.
 */

interface TarEntry {
  readonly name: string;
  readonly data?: string;
  /** `0` a file (the default), `5` a folder, `2` a link, `x` a pax header. */
  readonly type?: string;
  readonly mode?: number;
}

function header(name: string, size: number, type: string, mode: number): Uint8Array {
  const block = new Uint8Array(512);
  const put = (text: string, at: number) => block.set(new TextEncoder().encode(text), at);
  put(name, 0);
  put(`${mode.toString(8).padStart(7, '0')}\u0000`, 100);
  put(`${size.toString(8).padStart(11, '0')}\u0000`, 124);
  put(type, 156);
  put('ustar\u000000', 257);
  return block;
}

/** An npm-shaped tarball: every name under `package/`, gzipped. */
function tarball(entries: readonly TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const data = new TextEncoder().encode(entry.data ?? '');
    parts.push(header(entry.name, data.length, entry.type ?? '0', entry.mode ?? 0o644));
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data);
    parts.push(padded);
  }
  parts.push(new Uint8Array(1024));
  const size = parts.reduce((total, part) => total + part.length, 0);
  const tar = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    tar.set(part, at);
    at += part.length;
  }
  return gzipSync(tar);
}

const REGISTRY = 'https://registry.example/';

function lockOf(
  packages: Record<string, Uint8Array>,
  version = '1.2.3',
): { lock: AdapterLock; source: string } {
  const lock: AdapterLock = {
    adapter: { name: 'adapter', version },
    entry: 'node_modules/adapter/dist/index.js',
    registry: REGISTRY,
    bytes: 1000,
    packages: Object.entries(packages).map(([path, bytes]) => ({
      path,
      version: '1.0.0',
      resolved: `${REGISTRY}${path}.tgz`,
      integrity: integrityOf(bytes),
    })),
  };
  return { lock, source: JSON.stringify(lock) };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'tyto-agent-launcher-'));
  roots.push(root);
  return root;
}

/** A download from the tarballs given, by address; anything else is a 404. */
function serving(files: Record<string, Uint8Array>) {
  const asked: string[] = [];
  return {
    asked,
    io: {
      download: (url: string) => {
        asked.push(url);
        const path = url.slice(REGISTRY.length, -'.tgz'.length);
        const bytes = files[path];
        return bytes === undefined ? Promise.reject(new Error('HTTP 404')) : Promise.resolve(bytes);
      },
    },
  };
}

const ADAPTER = tarball([
  { name: 'package/', type: '5' },
  { name: 'package/package.json', data: '{"name":"adapter"}' },
  { name: 'package/dist/index.js', data: 'export {};', mode: 0o755 },
]);
const NESTED = tarball([{ name: 'package/index.js', data: 'module.exports = 2;' }]);

describe('install', () => {
  it('writes every package where the lock says, nested ones too, and marks it installed', async () => {
    const data = temp();
    const files = {
      'node_modules/adapter': ADAPTER,
      'node_modules/a/node_modules/content-type': NESTED,
    };
    const { lock, source } = lockOf(files);
    const progress: number[] = [];
    const entry = await install(lock, lockDigest(source), data, serving(files).io, ({ done }) =>
      progress.push(done),
    );
    const version = join(data, 'claude-agent-acp', '1.2.3');
    expect(entry).toBe(join(version, 'node_modules', 'adapter', 'dist', 'index.js'));
    expect(readFileSync(entry, 'utf8')).toBe('export {};');
    expect(
      readFileSync(
        join(version, 'node_modules', 'a', 'node_modules', 'content-type', 'index.js'),
        'utf8',
      ),
    ).toBe('module.exports = 2;');
    expect(progress.sort()).toEqual([1, 2]);
    expect(installedState(lock, lockDigest(source), data)).toEqual({
      installed: true,
      previous: null,
      entry,
    });
    // Only the version folder is left: no staging.
    expect(readdirSync(join(data, 'claude-agent-acp'))).toEqual(['1.2.3']);
  });

  it('keeps a half-done install out of the version folder until every package is in', async () => {
    const data = temp();
    const files = {
      'node_modules/adapter': ADAPTER,
      'node_modules/a/node_modules/content-type': NESTED,
    };
    const { lock, source } = lockOf(files);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delivered = 0;
    const installing = install(
      lock,
      lockDigest(source),
      data,
      {
        // The first package arrives at once, the second waits: a launcher killed now leaves this.
        download: async (url) => {
          delivered += 1;
          if (delivered > 1) await held;
          return serving(files).io.download(url);
        },
      },
      () => undefined,
    );
    for (let tries = 0; tries < 100 && delivered < 2; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(existsSync(join(data, 'claude-agent-acp', '1.2.3'))).toBe(false);
    expect(installedState(lock, lockDigest(source), data).installed).toBe(false);
    release();
    await installing;
    expect(installedState(lock, lockDigest(source), data).installed).toBe(true);
  });

  it('installs anew when the lock changed under the same version', async () => {
    const data = temp();
    const files = { 'node_modules/adapter': ADAPTER };
    const { lock, source } = lockOf(files);
    await install(lock, lockDigest(source), data, serving(files).io, () => undefined);
    expect(installedState(lock, lockDigest(`${source} `), data).installed).toBe(false);
  });

  it('names an earlier pin as previous, and removes it once the new one is in', async () => {
    const data = temp();
    const files = { 'node_modules/adapter': ADAPTER };
    const old = lockOf(files, '1.0.0');
    await install(old.lock, lockDigest(old.source), data, serving(files).io, () => undefined);
    const next = lockOf(files, '1.2.3');
    expect(installedState(next.lock, lockDigest(next.source), data)).toMatchObject({
      installed: false,
      previous: '1.0.0',
    });
    await install(next.lock, lockDigest(next.source), data, serving(files).io, () => undefined);
    expect(readdirSync(join(data, 'claude-agent-acp'))).toEqual(['1.2.3']);
  });

  /** Runs an install that must fail, and answers its code; nothing may be left behind. */
  async function refused(files: Record<string, Uint8Array>, served = files): Promise<string> {
    const data = temp();
    const { lock, source } = lockOf(files);
    let code = 'installed';
    try {
      await install(lock, lockDigest(source), data, serving(served).io, () => undefined);
    } catch (cause) {
      code = cause instanceof InstallError ? cause.code : String(cause);
    }
    expect(readdirSync(join(data, 'claude-agent-acp'))).toEqual([]);
    return code;
  }

  it('refuses a tarball whose sha512 is not the one pinned, and writes nothing', async () => {
    const pinned = { 'node_modules/adapter': ADAPTER };
    const other = { 'node_modules/adapter': NESTED };
    expect(await refused(pinned, other)).toBe('integrity');
  });

  it('refuses a download that fails, and writes nothing', async () => {
    expect(await refused({ 'node_modules/adapter': ADAPTER }, {})).toBe('network');
  });

  it('refuses a tarball with a link, a .. or an absolute path, and writes nothing', async () => {
    const link = tarball([{ name: 'package/evil', type: '2' }]);
    const up = tarball([{ name: 'package/../../escape.js', data: 'x' }]);
    const absolute = tarball([{ name: '/etc/escape.js', data: 'x' }]);
    const drive = tarball([{ name: 'C:/escape.js', data: 'x' }]);
    for (const bad of [link, up, absolute, drive]) {
      expect(await refused({ 'node_modules/adapter': ADAPTER, 'node_modules/bad': bad })).toBe(
        'unsafe-archive',
      );
    }
  });
});

describe('readTar', () => {
  it('reads a long name from a pax header', () => {
    const long = `package/${'a'.repeat(120)}.js`;
    const record = ` path=${long}\n`;
    const length = record.length + String(record.length + 3).length;
    const files = readTar(
      new Uint8Array(
        execFileSync(process.execPath, [
          '-e',
          `process.stdout.write(require('zlib').gunzipSync(Buffer.from(process.argv[1],'base64')))`,
          Buffer.from(
            tarball([
              { name: 'PaxHeader', type: 'x', data: `${String(length)}${record}` },
              { name: 'package/short.js', data: 'long' },
            ]),
          ).toString('base64'),
        ]),
      ),
    );
    expect(files.map((file) => file.path)).toEqual([`${'a'.repeat(120)}.js`]);
  });
});

describe('parseLock', () => {
  const good = lockOf({ 'node_modules/adapter': ADAPTER }).lock;
  const refusal = (lock: unknown): string => {
    try {
      parseLock(JSON.stringify(lock));
      return 'accepted';
    } catch (cause) {
      return (cause as Error).message;
    }
  };

  it('accepts what the generator writes', () => {
    expect(refusal(good)).toBe('accepted');
  });

  it('refuses an address off the registry, a hash that is not sha512, a path out, plain http', () => {
    const one = good.packages[0];
    expect(
      refusal({ ...good, packages: [{ ...one, resolved: 'https://elsewhere/x.tgz' }] }),
    ).toMatch(/from outside/u);
    expect(refusal({ ...good, packages: [{ ...one, integrity: 'sha1-abc' }] })).toMatch(
      /no sha512/u,
    );
    expect(refusal({ ...good, packages: [{ ...one, path: 'node_modules/../escape' }] })).toMatch(
      /may not/u,
    );
    expect(refusal({ ...good, registry: 'http://registry.example/' })).toMatch(/https registry/u);
  });

  it('accepts the committed lock: the pinned adapter, every package from npm, by sha512', () => {
    const source = readFileSync(new URL('../../adapter/lock.json', import.meta.url), 'utf8');
    const lock = parseLock(source);
    expect(lock.adapter.name).toBe('@agentclientprotocol/claude-agent-acp');
    expect(lock.registry).toBe('https://registry.npmjs.org/');
    expect(
      lock.packages.some((item) => item.path === 'node_modules/@anthropic-ai/claude-agent-sdk'),
    ).toBe(true);
    // Never the SDK's platform binaries: the person's own claude runs instead.
    expect(lock.packages.filter((item) => item.path.includes('claude-agent-sdk-'))).toEqual([]);
  });
});

describe('findClaude', () => {
  /** A disk of empty files, and shims whose text is given. */
  const disk = (files: readonly string[], shims: Readonly<Record<string, string>> = {}) => ({
    isFile: (path: string) => files.includes(path) || path in shims,
    readText: (path: string) => shims[path],
  });

  /** What npm's cmd-shim writes for each bin, as measured with npm 11 on 2026-11-11 (TYTO-667). */
  const EXE_SHIM = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
  ].join('\r\n');
  const SCRIPT_SHIM = [
    '@ECHO off',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ].join('\r\n');
  const NPM_EXE = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
  const NPM_SHIM = 'C:\\npm\\claude.cmd';

  it('takes claude.exe on Windows, from Path in any case, in PATH order with shims', () => {
    expect(
      findClaude(
        'win32',
        { Path: 'C:\\npm;C:\\bin' },
        disk(['C:\\bin\\claude.exe', NPM_EXE], { [NPM_SHIM]: EXE_SHIM }),
      ),
    ).toEqual({ found: 'found', path: NPM_EXE });
    expect(
      findClaude(
        'win32',
        { PATH: 'C:\\bin;C:\\npm' },
        disk(['C:\\bin\\claude.exe', NPM_EXE], { [NPM_SHIM]: EXE_SHIM }),
      ),
    ).toEqual({ found: 'found', path: 'C:\\bin\\claude.exe' });
    expect(findClaude('win32', { PATH: 'C:\\npm' }, disk([]))).toEqual({ found: 'missing' });
  });

  it('follows an npm shim to the claude.exe it starts, reading it and never running it', () => {
    expect(
      findClaude('win32', { PATH: 'C:\\npm' }, disk([NPM_EXE], { [NPM_SHIM]: EXE_SHIM })),
    ).toEqual({ found: 'found', path: NPM_EXE });
    // The shim names an .exe that is not there.
    expect(findClaude('win32', { PATH: 'C:\\npm' }, disk([], { [NPM_SHIM]: EXE_SHIM }))).toEqual({
      found: 'shim',
    });
  });

  it('refuses a shim that runs cli.js, or points outside its own node_modules', () => {
    const script = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
    expect(
      findClaude(
        'win32',
        { PATH: 'C:\\npm' },
        disk([script, 'C:\\npm\\node.exe'], { [NPM_SHIM]: SCRIPT_SHIM }),
      ),
    ).toEqual({ found: 'shim' });
    for (const outside of [
      '"%dp0%\\..\\elsewhere\\node_modules\\claude.exe" %*',
      '"%dp0%\\node_modules\\..\\..\\Windows\\claude.exe" %*',
      '"%dp0%\\claude.exe" %*',
    ]) {
      expect(
        shimTarget('C:\\npm', outside, () => true),
        outside,
      ).toBeUndefined();
    }
    // A bare `claude` (the POSIX shim npm also writes) is no program Windows starts.
    expect(findClaude('win32', { PATH: 'C:\\npm' }, disk(['C:\\npm\\claude']))).toEqual({
      found: 'shim',
    });
  });

  it('takes claude on POSIX, and skips a relative PATH entry', () => {
    expect(
      findClaude('linux', { PATH: 'bin:/usr/bin' }, disk(['bin/claude', '/usr/bin/claude'])),
    ).toEqual({
      found: 'found',
      path: '/usr/bin/claude',
    });
  });
});

describe('the built launcher, as a program', () => {
  const launcher = new URL('../../adapter/launch.mjs', import.meta.url);

  it('reads its data folder from the variable Tyto sets', () => {
    expect(DATA_VARIABLE).toBe(PROGRAM_DATA_VARIABLE);
  });

  it('answers its status, and that a Tyto without a data folder is too old', () => {
    const data = temp();
    const status = (environment: Record<string, string>) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [launcher.pathname.replace(/^\/([a-z]:)/iu, '$1'), '--tyto-status'],
          {
            env: { PATH: '', ...environment },
            encoding: 'utf8',
          },
        ),
      ) as Record<string, unknown>;
    expect(status({ [DATA_VARIABLE]: data })).toMatchObject({
      tyto: 'status',
      data: true,
      installed: false,
      previous: null,
      source: 'registry.npmjs.org',
      claude: 'missing',
    });
    expect(status({})).toMatchObject({ data: false, installed: false });
    // A status writes nothing into the data folder.
    expect(existsSync(join(data, 'claude-agent-acp'))).toBe(false);
  });

  it('refuses to run an adapter it has not downloaded, saying why', () => {
    const data = temp();
    mkdirSync(join(data, 'claude-agent-acp'), { recursive: true });
    writeFileSync(join(data, 'claude-agent-acp', 'stray'), '');
    let code = 0;
    let said = '';
    try {
      execFileSync(process.execPath, [launcher.pathname.replace(/^\/([a-z]:)/iu, '$1')], {
        env: { PATH: '', [DATA_VARIABLE]: data },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (cause) {
      code = (cause as { status: number }).status;
      said = String((cause as { stderr: string }).stderr);
    }
    expect(code).toBe(78);
    expect(said).toContain('is not downloaded yet');
  });
});
