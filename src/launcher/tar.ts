/**
 * The few tar entries an npm tarball holds, read from its bytes. npm packs plain files and folders
 * under one top folder (`package/`), with pax headers for long names. Anything else, such as a link,
 * a device or a FIFO, is refused rather than skipped: the installer writes only what it read,
 * under the folder it chose (TYTO-666).
 */

export interface TarFile {
  /** The path below the top folder, with forward slashes, already checked by `safePath`. */
  readonly path: string;
  readonly data: Uint8Array;
  /** Whether the owner may run it: npm keeps a bin script's mode. */
  readonly executable: boolean;
}

export class UnsafeArchive extends Error {
  readonly code = 'unsafe-archive';
}

const BLOCK = 512;
const decoder = new TextDecoder();

function text(bytes: Uint8Array, start: number, length: number): string {
  const slice = bytes.subarray(start, start + length);
  const end = slice.indexOf(0);
  return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
}

function octal(bytes: Uint8Array, start: number, length: number): number {
  const value = text(bytes, start, length).trim();
  if (!/^[0-7]*$/u.test(value)) throw new UnsafeArchive(`a header field is not octal: ${value}`);
  return value === '' ? 0 : Number.parseInt(value, 8);
}

/** The `path` record of a pax header, if it has one. Records are `<length> <key>=<value>\n`. */
function paxPath(data: Uint8Array): string | undefined {
  const records = decoder.decode(data);
  let at = 0;
  let found: string | undefined;
  while (at < records.length) {
    const space = records.indexOf(' ', at);
    if (space === -1) break;
    const length = Number.parseInt(records.slice(at, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = records.slice(space + 1, at + length - 1);
    const equals = record.indexOf('=');
    if (record.slice(0, equals) === 'path') found = record.slice(equals + 1);
    at += length;
  }
  return found;
}

/**
 * The path below the tarball's top folder, or a refusal: an absolute path, a drive, a `..` or `.`
 * segment, a backslash, a colon (a Windows stream or drive) or a control character never reaches
 * the disk. `undefined` is the top folder itself.
 */
export function safePath(name: string): string | undefined {
  if (name.startsWith('/') || /^[a-z]:/iu.test(name)) {
    throw new UnsafeArchive(`an entry is an absolute path: ${name}`);
  }
  const control = [...name].some((character) => character.charCodeAt(0) < 0x20);
  if (/[\\:]/u.test(name) || control) {
    throw new UnsafeArchive(`an entry's name holds a character Tyto does not write: ${name}`);
  }
  const segments = name.split('/').filter((segment) => segment !== '');
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new UnsafeArchive(`an entry leaves its folder: ${name}`);
  }
  // npm's top folder is `package/`, whatever the package is called; everything is below it.
  const below = segments.slice(1);
  return below.length === 0 ? undefined : below.join('/');
}

/** Every file in an uncompressed tar, in order. Folders are implied by the files' paths. */
export function readTar(bytes: Uint8Array): TarFile[] {
  const files: TarFile[] = [];
  let at = 0;
  let longName: string | undefined;
  while (at + BLOCK <= bytes.length) {
    const header = bytes.subarray(at, at + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = text(header, 345, 155);
    const plain = text(header, 0, 100);
    const name = longName ?? (prefix === '' ? plain : `${prefix}/${plain}`);
    const start = at + BLOCK;
    if (start + size > bytes.length) throw new UnsafeArchive('the archive ends inside an entry');
    const data = bytes.subarray(start, start + size);
    at = start + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x') {
      longName = paxPath(data);
      continue;
    }
    if (type === 'g') continue;
    longName = undefined;
    if (type === '5') {
      safePath(name);
      continue;
    }
    if (type !== '0' && type !== '\u0000' && type !== '7') {
      throw new UnsafeArchive(`an entry is not a plain file or folder (type ${type}): ${name}`);
    }
    const path = safePath(name);
    if (path === undefined) throw new UnsafeArchive(`a file has no name: ${name}`);
    files.push({ path, data: data.slice(), executable: (octal(header, 100, 8) & 0o100) !== 0 });
  }
  return files;
}
