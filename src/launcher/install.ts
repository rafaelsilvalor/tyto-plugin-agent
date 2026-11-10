import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import type { InstallFailureCode } from './protocol.js';
import { readTar } from './tar.js';

/**
 * The adapter's copy in the plugin's data folder (Tyto ADR 0187), fetched from npm at the version
 * `adapter/lock.json` pins. Nothing of it is ever in this repository: the lock holds names,
 * versions, addresses and the registry's sha512 for each package, and every byte downloaded is
 * checked against it before it is written (ADR 0187 decision 3).
 *
 * ```
 * <data>/claude-agent-acp/
 *   <version>/                 a whole install, renamed into place only once complete
 *     .tyto-installed.json     the lock's digest it was installed from
 *     node_modules/…
 *   .staging-<id>/             an install in progress, or one that died; removed by the next
 * ```
 */

export interface LockedPackage {
  /** Where it goes below the version folder, as npm's lock says: `node_modules/<name>…`. */
  readonly path: string;
  readonly version: string;
  readonly resolved: string;
  readonly integrity: string;
}

export interface AdapterLock {
  readonly adapter: { readonly name: string; readonly version: string };
  /** The adapter's program below the version folder. */
  readonly entry: string;
  /** Every package's address starts with this. */
  readonly registry: string;
  /** What the install takes on disk, measured by the generator: what the panel tells the person. */
  readonly bytes: number;
  readonly packages: readonly LockedPackage[];
}

export class InstallError extends Error {
  constructor(
    readonly code: InstallFailureCode,
    message: string,
  ) {
    super(message);
  }
}

const PACKAGE_NAME = '(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*';
/** `node_modules/<name>`, nested as npm nests a second version: no other path is written. */
const INSTALL_PATH = new RegExp(
  `^node_modules/${PACKAGE_NAME}(?:/node_modules/${PACKAGE_NAME})*$`,
  'u',
);
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/u;

/** The lock, checked: anything the installer would write or fetch outside its rules is refused. */
export function parseLock(source: string): AdapterLock {
  const fail = (why: string): never => {
    throw new InstallError('lock', `adapter/lock.json ${why}`);
  };
  let value: Partial<AdapterLock>;
  try {
    value = JSON.parse(source) as Partial<AdapterLock>;
  } catch {
    return fail('is not JSON');
  }
  const registry = value.registry;
  if (typeof registry !== 'string' || !registry.startsWith('https://') || !registry.endsWith('/')) {
    fail('names no https registry ending in /');
  }
  if (typeof value.adapter?.name !== 'string' || typeof value.adapter.version !== 'string') {
    fail('names no adapter');
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(value.adapter?.version ?? ''))
    fail('pins no x.y.z version');
  if (
    typeof value.entry !== 'string' ||
    !/^node_modules\/[a-zA-Z0-9@._/-]+\.js$/u.test(value.entry)
  ) {
    fail('names no entry inside node_modules');
  }
  if (typeof value.bytes !== 'number' || !Number.isInteger(value.bytes) || value.bytes <= 0) {
    fail('says no size');
  }
  if (!Array.isArray(value.packages) || value.packages.length === 0) fail('lists no package');
  const seen = new Set<string>();
  for (const item of value.packages ?? []) {
    if (typeof item.path !== 'string' || !INSTALL_PATH.test(item.path)) {
      fail(`installs a package at a path it may not: ${String(item.path)}`);
    }
    if (seen.has(item.path)) fail(`lists ${item.path} twice`);
    seen.add(item.path);
    if (typeof item.resolved !== 'string' || !item.resolved.startsWith(registry as string)) {
      fail(`fetches ${item.path} from outside ${String(registry)}`);
    }
    if (typeof item.integrity !== 'string' || !SHA512.test(item.integrity)) {
      fail(`pins ${item.path} by no sha512`);
    }
    if (typeof item.version !== 'string') fail(`gives ${item.path} no version`);
  }
  return value as AdapterLock;
}

/** The digest an install records, so a lock that changed under the same version installs anew. */
export function lockDigest(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

export function adapterRoot(dataFolder: string): string {
  return join(dataFolder, 'claude-agent-acp');
}

const MARKER = '.tyto-installed.json';

export interface InstalledState {
  /** The pinned version is installed from this very lock. */
  readonly installed: boolean;
  /** Another version found in the folder: an earlier pin the person already accepted. */
  readonly previous: string | null;
  /** The adapter's program, when installed. */
  readonly entry: string | null;
}

export function installedState(
  lock: AdapterLock,
  digest: string,
  dataFolder: string,
): InstalledState {
  const root = adapterRoot(dataFolder);
  const folder = join(root, lock.adapter.version);
  let installed: boolean;
  try {
    const marker = JSON.parse(readFileSync(join(folder, MARKER), 'utf8')) as { digest?: unknown };
    installed = marker.digest === digest && existsSync(join(folder, lock.entry));
  } catch {
    installed = false;
  }
  let previous: string | null = null;
  if (!installed && existsSync(root)) {
    try {
      // Synchronous on purpose: the status answer is one short program run.
      for (const name of readdirSync(root)) {
        if (name !== lock.adapter.version && existsSync(join(root, name, MARKER))) previous = name;
      }
    } catch {
      previous = null;
    }
  }
  return { installed, previous, entry: installed ? join(folder, lock.entry) : null };
}

export interface Progress {
  readonly done: number;
  readonly total: number;
}

export interface InstallIo {
  /** The bytes at `url`; throws for anything but a 200. */
  download(url: string): Promise<Uint8Array>;
}

/** The registry's sha512 of `bytes`, as npm writes it: `sha512-<base64>`. */
export function integrityOf(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

/** How many tarballs download at once: enough to hide latency, few enough for a slow line. */
const PARALLEL = 6;

/**
 * Installs the pinned adapter into the data folder: every tarball downloaded, checked against the
 * lock's sha512, unpacked under a staging folder, which is renamed into place only once every
 * package is in. A failure removes the staging folder, so nothing half-installed is ever run.
 * Afterwards every other version is removed: one copy, the pinned one.
 */
export async function install(
  lock: AdapterLock,
  digest: string,
  dataFolder: string,
  io: InstallIo,
  onProgress: (progress: Progress) => void,
): Promise<string> {
  const root = adapterRoot(dataFolder);
  const staging = join(root, `.staging-${randomUUID()}`);
  const target = join(root, lock.adapter.version);
  const total = lock.packages.length;
  let done = 0;
  try {
    await mkdir(staging, { recursive: true });
    const queue = [...lock.packages];
    let failure: { readonly cause: unknown } | undefined;
    const worker = async (): Promise<void> => {
      for (
        let item = queue.shift();
        item !== undefined && failure === undefined;
        item = queue.shift()
      ) {
        try {
          await installOne(item, staging, io);
        } catch (cause) {
          failure ??= { cause };
          return;
        }
        done += 1;
        onProgress({ done, total });
      }
    };
    // Every worker has stopped writing before the staging folder is removed: one that went on
    // after another failed would put files back into a folder already deleted.
    await Promise.all(Array.from({ length: Math.min(PARALLEL, total) }, worker));
    if (failure !== undefined) throw failure.cause;
    await writeFile(
      join(staging, MARKER),
      `${JSON.stringify({ digest, version: lock.adapter.version })}\n`,
    );
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  } catch (cause) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (cause instanceof InstallError) throw cause;
    const code = (cause as { code?: unknown } | null)?.code;
    if (code === 'unsafe-archive')
      throw new InstallError('unsafe-archive', (cause as Error).message);
    throw new InstallError('disk', cause instanceof Error ? cause.message : String(cause));
  }
  // What an earlier pin or a dead install left. A file a running adapter holds open on Windows
  // stays until next time; the new version is in place either way.
  for (const name of await readdir(root)) {
    if (name !== lock.adapter.version) {
      await rm(join(root, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return join(target, lock.entry);
}

async function installOne(item: LockedPackage, staging: string, io: InstallIo): Promise<void> {
  let packed: Uint8Array;
  try {
    packed = await io.download(item.resolved);
  } catch (cause) {
    throw new InstallError(
      'network',
      `${item.resolved} did not download: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const found = integrityOf(packed);
  if (found !== item.integrity) {
    throw new InstallError(
      'integrity',
      `${item.resolved} is not the file the plugin pins: its sha512 is ${found}, not ${item.integrity}`,
    );
  }
  const folder = join(staging, ...item.path.split('/'));
  for (const file of readTar(gunzipSync(packed))) {
    const path = join(folder, ...file.path.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.data);
    if (file.executable) await chmod(path, 0o755);
  }
}
