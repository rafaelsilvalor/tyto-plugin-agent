import type { Disposable, PanelContribution, PluginHost } from '@tyto/plugin-api';

import { conversation } from './conversation.js';
import { SETTINGS } from './drivers.js';

/** What a panel's `call` answers, read off the contract rather than restated. */
type Answer = Awaited<ReturnType<NonNullable<PanelContribution['call']>>>;

/**
 * An answer with its `diagnostics`, written by hand: an isolated plugin's `{ ok, value }`
 * without them is refused (Tyto `docs/plugin-api.md`, panel). Every value here is plain JSON.
 */
const ok = (value: unknown): Answer => ({ ok: true, value, diagnostics: [] }) as unknown as Answer;

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The agent panel: a page in the window (`panel/index.html`) that asks this process through
 * `call` (Tyto ADR 0173). Every refusal is an answer the page shows, not a diagnostic: the page
 * tells the person what to do, and the host's codes are the plugin's to translate.
 *
 * - `open`: start the agent if needed; the status and this folder's earlier messages.
 * - `send {text}`: start a turn; answered at once.
 * - `read {after}`: the entries after `after`, and the status. The page asks a few times a
 *   second while a turn runs.
 * - `answer {id, optionId}`: the person's choice on a permission the agent asked for; a missing
 *   `optionId` cancels it.
 * - `cancel`: stop the running turn.
 * - `reset`: end the agent and start the next message in a fresh conversation.
 */
export function activate(host: PluginHost): Disposable {
  const chat = conversation(host);
  const registered = [
    ...SETTINGS.map((setting) => host.registerConfiguration(setting)),
    host.registerPanel({
      id: 'agent',
      title: 'Agent',
      location: 'right',
      entry: 'panel/index.html',
      async call({ method, params }) {
        const given = (params ?? {}) as Record<string, unknown>;
        switch (method) {
          case 'open':
            return ok(await chat.open());
          case 'send':
            return ok(chat.send(stringOf(given['text'])));
          case 'read':
            return ok(chat.read(numberOf(given['after'])));
          case 'answer':
            return ok(
              chat.answer(
                stringOf(given['id']),
                typeof given['optionId'] === 'string' ? given['optionId'] : null,
              ),
            );
          case 'cancel':
            await chat.cancel();
            return ok(chat.status());
          case 'reset':
            await chat.reset();
            return ok(chat.status());
          default:
            return ok({ unknown: method });
        }
      },
    }),
  ];
  return {
    dispose() {
      void chat.reset();
      for (const registration of registered) registration.dispose();
    },
  };
}
