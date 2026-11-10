// Writes adapter/lock.json for a new pin of the Claude ACP adapter (TYTO-666).
//
//   node scripts/lock-adapter.mjs 0.104.1
//
// For maintainers only; nothing a person installs runs it. It installs the adapter with npm into a
// temporary folder, the way the launcher will lay it out (no optional packages, so not the SDK's
// 331 MB platform binaries, and no install scripts, which the launcher never runs), then records
// every package's path, version, address and the registry's sha512, and the size on disk the
// panel tells the person before they accept. Only that list is committed: never a package's code.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADAPTER = '@agentclientprotocol/claude-agent-acp';
const REGISTRY = 'https://registry.npmjs.org/';

const version = process.argv[2];
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(version ?? '')) {
  console.error('usage: node scripts/lock-adapter.mjs <x.y.z>');
  process.exit(2);
}

function sizeOf(folder) {
  let bytes = 0;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) bytes += sizeOf(path);
    else if (entry.isFile() && entry.name !== '.package-lock.json') bytes += statSync(path).size;
  }
  return bytes;
}

const work = mkdtempSync(join(tmpdir(), 'tyto-lock-adapter-'));
try {
  writeFileSync(join(work, 'package.json'), '{"name":"lock-adapter","private":true}\n');
  // `shell` on Windows only: npm is a .cmd there. The arguments are this script's own.
  execFileSync(
    'npm',
    [
      'install',
      '--omit=optional',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `--registry=${REGISTRY}`,
      `${ADAPTER}@${version}`,
    ],
    { cwd: work, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  const npmLock = JSON.parse(readFileSync(join(work, 'package-lock.json'), 'utf8'));
  const packages = [];
  for (const [path, item] of Object.entries(npmLock.packages)) {
    if (path === '' || item.optional === true) continue;
    if (item.hasInstallScript === true) throw new Error(`${path} has an install script`);
    if (item.link === true) throw new Error(`${path} is a link`);
    if (!String(item.integrity).startsWith('sha512-')) throw new Error(`${path} has no sha512`);
    if (!String(item.resolved).startsWith(REGISTRY)) throw new Error(`${path} is not from npm`);
    packages.push({
      path,
      version: item.version,
      resolved: item.resolved,
      integrity: item.integrity,
    });
  }
  const adapter = npmLock.packages[`node_modules/${ADAPTER}`];
  const bin = typeof adapter.bin === 'string' ? adapter.bin : adapter.bin['claude-agent-acp'];
  const entry = `node_modules/${ADAPTER}/${bin.replace(/^\.\//u, '')}`;
  statSync(join(work, entry));
  const bytes = sizeOf(join(work, 'node_modules'));

  // One package per line, so a new pin reads as a short diff.
  const lines = packages.map((item) => `    ${JSON.stringify(item)}`).join(',\n');
  const text = `{
  "adapter": ${JSON.stringify({ name: ADAPTER, version })},
  "entry": ${JSON.stringify(entry)},
  "registry": ${JSON.stringify(REGISTRY)},
  "bytes": ${String(bytes)},
  "packages": [
${lines}
  ]
}
`;
  writeFileSync(new URL('../adapter/lock.json', import.meta.url), text);
  process.stdout.write(
    `adapter/lock.json: ${ADAPTER}@${version}, ${String(packages.length)} packages, ${String(bytes)} bytes\n`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
