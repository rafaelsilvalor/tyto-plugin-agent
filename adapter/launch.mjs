// src/launcher/launch.ts
import { readFileSync as readFileSync2 } from "fs";
import { pathToFileURL } from "url";

// src/launcher/claude.ts
import { statSync } from "fs";
import { posix, win32 } from "path";
function findClaude(platform, environment, isFile = (path) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false) {
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  const search = Object.entries(environment).find(
    ([key]) => (windows ? key.toUpperCase() : key) === "PATH"
  )?.[1] ?? "";
  let shim = false;
  for (const folder of search.split(windows ? ";" : ":")) {
    if (folder === "" || !path.isAbsolute(folder)) continue;
    if (windows) {
      const binary = path.join(folder, "claude.exe");
      if (isFile(binary)) return { found: "found", path: binary };
      if (isFile(path.join(folder, "claude.cmd")) || isFile(path.join(folder, "claude")))
        shim = true;
    } else {
      const binary = path.join(folder, "claude");
      if (isFile(binary)) return { found: "found", path: binary };
    }
  }
  return { found: shim ? "shim" : "missing" };
}

// src/launcher/install.ts
import { createHash, randomUUID } from "crypto";
import { existsSync, readFileSync, readdirSync } from "fs";
import { chmod, mkdir, readdir, rename, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { gunzipSync } from "zlib";

// src/launcher/tar.ts
var UnsafeArchive = class extends Error {
  code = "unsafe-archive";
};
var BLOCK = 512;
var decoder = new TextDecoder();
function text(bytes, start, length) {
  const slice = bytes.subarray(start, start + length);
  const end = slice.indexOf(0);
  return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
}
function octal(bytes, start, length) {
  const value = text(bytes, start, length).trim();
  if (!/^[0-7]*$/u.test(value)) throw new UnsafeArchive(`a header field is not octal: ${value}`);
  return value === "" ? 0 : Number.parseInt(value, 8);
}
function paxPath(data) {
  const records = decoder.decode(data);
  let at = 0;
  let found;
  while (at < records.length) {
    const space = records.indexOf(" ", at);
    if (space === -1) break;
    const length = Number.parseInt(records.slice(at, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = records.slice(space + 1, at + length - 1);
    const equals = record.indexOf("=");
    if (record.slice(0, equals) === "path") found = record.slice(equals + 1);
    at += length;
  }
  return found;
}
function safePath(name) {
  if (name.startsWith("/") || /^[a-z]:/iu.test(name)) {
    throw new UnsafeArchive(`an entry is an absolute path: ${name}`);
  }
  const control = [...name].some((character) => character.charCodeAt(0) < 32);
  if (/[\\:]/u.test(name) || control) {
    throw new UnsafeArchive(`an entry's name holds a character Tyto does not write: ${name}`);
  }
  const segments = name.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    throw new UnsafeArchive(`an entry leaves its folder: ${name}`);
  }
  const below = segments.slice(1);
  return below.length === 0 ? void 0 : below.join("/");
}
function readTar(bytes) {
  const files = [];
  let at = 0;
  let longName;
  while (at + BLOCK <= bytes.length) {
    const header = bytes.subarray(at, at + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = text(header, 345, 155);
    const plain = text(header, 0, 100);
    const name = longName ?? (prefix === "" ? plain : `${prefix}/${plain}`);
    const start = at + BLOCK;
    if (start + size > bytes.length) throw new UnsafeArchive("the archive ends inside an entry");
    const data = bytes.subarray(start, start + size);
    at = start + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      longName = paxPath(data);
      continue;
    }
    if (type === "g") continue;
    longName = void 0;
    if (type === "5") {
      safePath(name);
      continue;
    }
    if (type !== "0" && type !== "\0" && type !== "7") {
      throw new UnsafeArchive(`an entry is not a plain file or folder (type ${type}): ${name}`);
    }
    const path = safePath(name);
    if (path === void 0) throw new UnsafeArchive(`a file has no name: ${name}`);
    files.push({ path, data: data.slice(), executable: (octal(header, 100, 8) & 64) !== 0 });
  }
  return files;
}

// src/launcher/install.ts
var InstallError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
  code;
};
var PACKAGE_NAME = "(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*";
var INSTALL_PATH = new RegExp(
  `^node_modules/${PACKAGE_NAME}(?:/node_modules/${PACKAGE_NAME})*$`,
  "u"
);
var SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/u;
function parseLock(source) {
  const fail = (why) => {
    throw new InstallError("lock", `adapter/lock.json ${why}`);
  };
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return fail("is not JSON");
  }
  const registry = value.registry;
  if (typeof registry !== "string" || !registry.startsWith("https://") || !registry.endsWith("/")) {
    fail("names no https registry ending in /");
  }
  if (typeof value.adapter?.name !== "string" || typeof value.adapter.version !== "string") {
    fail("names no adapter");
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(value.adapter?.version ?? ""))
    fail("pins no x.y.z version");
  if (typeof value.entry !== "string" || !/^node_modules\/[a-zA-Z0-9@._/-]+\.js$/u.test(value.entry)) {
    fail("names no entry inside node_modules");
  }
  if (typeof value.bytes !== "number" || !Number.isInteger(value.bytes) || value.bytes <= 0) {
    fail("says no size");
  }
  if (!Array.isArray(value.packages) || value.packages.length === 0) fail("lists no package");
  const seen = /* @__PURE__ */ new Set();
  for (const item of value.packages ?? []) {
    if (typeof item.path !== "string" || !INSTALL_PATH.test(item.path)) {
      fail(`installs a package at a path it may not: ${String(item.path)}`);
    }
    if (seen.has(item.path)) fail(`lists ${item.path} twice`);
    seen.add(item.path);
    if (typeof item.resolved !== "string" || !item.resolved.startsWith(registry)) {
      fail(`fetches ${item.path} from outside ${String(registry)}`);
    }
    if (typeof item.integrity !== "string" || !SHA512.test(item.integrity)) {
      fail(`pins ${item.path} by no sha512`);
    }
    if (typeof item.version !== "string") fail(`gives ${item.path} no version`);
  }
  return value;
}
function lockDigest(source) {
  return createHash("sha256").update(source).digest("hex");
}
function adapterRoot(dataFolder) {
  return join(dataFolder, "claude-agent-acp");
}
var MARKER = ".tyto-installed.json";
function installedState(lock, digest, dataFolder) {
  const root = adapterRoot(dataFolder);
  const folder = join(root, lock.adapter.version);
  let installed;
  try {
    const marker = JSON.parse(readFileSync(join(folder, MARKER), "utf8"));
    installed = marker.digest === digest && existsSync(join(folder, lock.entry));
  } catch {
    installed = false;
  }
  let previous = null;
  if (!installed && existsSync(root)) {
    try {
      for (const name of readdirSync(root)) {
        if (name !== lock.adapter.version && existsSync(join(root, name, MARKER))) previous = name;
      }
    } catch {
      previous = null;
    }
  }
  return { installed, previous, entry: installed ? join(folder, lock.entry) : null };
}
function integrityOf(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}
var PARALLEL = 6;
async function install(lock, digest, dataFolder, io, onProgress) {
  const root = adapterRoot(dataFolder);
  const staging = join(root, `.staging-${randomUUID()}`);
  const target = join(root, lock.adapter.version);
  const total = lock.packages.length;
  let done = 0;
  try {
    await mkdir(staging, { recursive: true });
    const queue = [...lock.packages];
    let failure;
    const worker = async () => {
      for (let item = queue.shift(); item !== void 0 && failure === void 0; item = queue.shift()) {
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
    await Promise.all(Array.from({ length: Math.min(PARALLEL, total) }, worker));
    if (failure !== void 0) throw failure.cause;
    await writeFile(
      join(staging, MARKER),
      `${JSON.stringify({ digest, version: lock.adapter.version })}
`
    );
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  } catch (cause) {
    await rm(staging, { recursive: true, force: true }).catch(() => void 0);
    if (cause instanceof InstallError) throw cause;
    const code = cause?.code;
    if (code === "unsafe-archive")
      throw new InstallError("unsafe-archive", cause.message);
    throw new InstallError("disk", cause instanceof Error ? cause.message : String(cause));
  }
  for (const name of await readdir(root)) {
    if (name !== lock.adapter.version) {
      await rm(join(root, name), { recursive: true, force: true }).catch(() => void 0);
    }
  }
  return join(target, lock.entry);
}
async function installOne(item, staging, io) {
  let packed;
  try {
    packed = await io.download(item.resolved);
  } catch (cause) {
    throw new InstallError(
      "network",
      `${item.resolved} did not download: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
  const found = integrityOf(packed);
  if (found !== item.integrity) {
    throw new InstallError(
      "integrity",
      `${item.resolved} is not the file the plugin pins: its sha512 is ${found}, not ${item.integrity}`
    );
  }
  const folder = join(staging, ...item.path.split("/"));
  for (const file of readTar(gunzipSync(packed))) {
    const path = join(folder, ...file.path.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.data);
    if (file.executable) await chmod(path, 493);
  }
}

// src/launcher/protocol.ts
var STATUS_ARGUMENT = "--tyto-status";
var INSTALL_ARGUMENT = "--tyto-install";
var NOT_READY_EXIT = 78;

// src/launcher/launch.ts
var DATA_VARIABLE = "TYTO_PROGRAM_DATA";
function say(line) {
  process.stdout.write(`${JSON.stringify(line)}
`);
}
function notReady(reason) {
  process.stderr.write(`tyto-plugin-agent: ${reason}
`);
  process.exit(NOT_READY_EXIT);
}
async function download(url) {
  let last;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(12e4) });
      if (response.status !== 200) throw new Error(`HTTP ${String(response.status)}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (cause) {
      last = cause;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
async function main(argv) {
  const lockSource = readFileSync2(new URL("./lock.json", import.meta.url), "utf8");
  let lock;
  try {
    lock = parseLock(lockSource);
  } catch (cause) {
    if (argv[0] === INSTALL_ARGUMENT) {
      say({ tyto: "failed", code: "lock", message: cause.message });
      process.exit(1);
    }
    return notReady(cause.message);
  }
  const digest = lockDigest(lockSource);
  const data = process.env[DATA_VARIABLE];
  const hasData = typeof data === "string" && data !== "";
  if (argv[0] === STATUS_ARGUMENT) {
    const state2 = hasData ? installedState(lock, digest, data) : void 0;
    say({
      tyto: "status",
      data: hasData,
      installed: state2?.installed ?? false,
      previous: state2?.previous ?? null,
      version: lock.adapter.version,
      bytes: lock.bytes,
      source: new URL(lock.registry).host,
      claude: findClaude(process.platform, process.env).found
    });
    return;
  }
  if (argv[0] === INSTALL_ARGUMENT) {
    if (!hasData) {
      say({
        tyto: "failed",
        code: "no-data",
        message: `Tyto gave this program no data folder (${DATA_VARIABLE}): it needs Tyto 0.18 or later`
      });
      process.exit(1);
    }
    try {
      await install(
        lock,
        digest,
        data,
        { download },
        ({ done, total }) => say({ tyto: "progress", done, total })
      );
      say({ tyto: "installed", version: lock.adapter.version });
    } catch (cause) {
      const failure = cause instanceof InstallError ? cause : new InstallError("disk", cause instanceof Error ? cause.message : String(cause));
      say({ tyto: "failed", code: failure.code, message: failure.message });
      process.exit(1);
    }
    return;
  }
  if (!hasData) notReady(`no data folder (${DATA_VARIABLE}): this plugin needs Tyto 0.18 or later`);
  const state = installedState(lock, digest, data);
  if (state.entry === null) notReady(`the adapter ${lock.adapter.version} is not downloaded yet`);
  const claude = findClaude(process.platform, process.env);
  if (claude.path === void 0)
    notReady(`claude is ${claude.found === "shim" ? "only an npm shim" : "not on PATH"}`);
  process.env["CLAUDE_CODE_EXECUTABLE"] = claude.path;
  process.argv = [process.argv[0] ?? "node", state.entry, ...argv];
  await import(pathToFileURL(state.entry).href);
}

// src/launcher/entry.ts
await main(process.argv.slice(2));
