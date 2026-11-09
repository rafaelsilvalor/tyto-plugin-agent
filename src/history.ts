import type { PluginHost } from '@tyto/plugin-api';

/**
 * The conversation per folder, in the plugin's private cache (Tyto ADR 0138): kept by Tyto
 * outside every workspace, and holding what was said and nothing else. No credential is ever
 * written here; the agent keeps its own login.
 *
 * Keyed by the folder the agent runs in, which the host reports (`PluginProcess.cwd`), hashed so
 * the key stays short and says nothing readable about the person's folders.
 */

export interface HistoryMessage {
  readonly role: 'user' | 'agent';
  readonly text: string;
}

/** The last messages kept per folder: enough to scroll back, small enough to read at once. */
export const HISTORY_LIMIT = 50;
/** One message's ceiling, so a long answer cannot grow an entry without bound. */
const MESSAGE_LIMIT = 20_000;

/** FNV-1a, 32 bits, as hex: a stable short key with no crypto import. */
export function folderKey(folder: string): string {
  let hash = 0x811c9dc5;
  for (const unit of new TextEncoder().encode(folder)) {
    hash ^= unit;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `history/${hash.toString(16).padStart(8, '0')}`;
}

interface Stored {
  readonly folder: string;
  readonly messages: readonly HistoryMessage[];
}

export async function loadHistory(
  host: Pick<PluginHost, 'cache'>,
  folder: string,
): Promise<readonly HistoryMessage[]> {
  const entry = await host.cache.get(folderKey(folder));
  if (entry === undefined) return [];
  try {
    const stored = JSON.parse(new TextDecoder().decode(entry.bytes)) as Partial<Stored>;
    // Two folders could share a hash: the folder is stored beside the messages and compared.
    if (stored.folder !== folder || !Array.isArray(stored.messages)) return [];
    return stored.messages.filter(
      (message): message is HistoryMessage =>
        (message?.role === 'user' || message?.role === 'agent') && typeof message.text === 'string',
    );
  } catch {
    return [];
  }
}

export async function saveHistory(
  host: Pick<PluginHost, 'cache'>,
  folder: string,
  messages: readonly HistoryMessage[],
): Promise<void> {
  const kept = messages
    .slice(-HISTORY_LIMIT)
    .map((message) => ({ role: message.role, text: message.text.slice(0, MESSAGE_LIMIT) }));
  const stored: Stored = { folder, messages: kept };
  await host.cache.put(folderKey(folder), JSON.stringify(stored));
}
