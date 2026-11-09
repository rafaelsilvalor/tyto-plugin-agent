import { readFileSync } from 'node:fs';

import type { Browser, Frame } from 'playwright-core';

/**
 * The panel page as Tyto's window shows it, in the system Chrome, for the tests that look at
 * what the page draws.
 *
 * A host page does what Tyto's window does to a panel (read in Tyto's `apps/desktop`, not
 * measured there): a sandboxed iframe from another origin, on a white backdrop in both themes
 * (`--tyto-plugin-page`), in a document whose scheme is `light dark`. It answers the page's
 * `call`s with what the test hands it: `open` with the status and the history, and the first
 * `read` with the entries, every later one with none.
 */

const PANEL = new URL('../panel/', import.meta.url);

export interface PageScript {
  readonly scheme?: 'light' | 'dark';
  readonly status: Record<string, unknown>;
  readonly history?: readonly { readonly role: string; readonly text: string }[];
  readonly entries?: readonly Record<string, unknown>[];
  /** The frame's size in CSS pixels; Tyto's panel is about this. */
  readonly width?: number;
  readonly height?: number;
}

function host(script: PageScript): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{color-scheme:light dark}
body{margin:0}
iframe{border:0;width:${String(script.width ?? 420)}px;height:${String(script.height ?? 560)}px;background:#ffffff}
</style></head><body>
<iframe sandbox="allow-scripts" src="https://panel.test/index.html"></iframe>
<script>
const status = ${JSON.stringify(script.status)};
const history = ${JSON.stringify(script.history ?? [])};
let entries = ${JSON.stringify(script.entries ?? [])};
const answers = {
  open: () => ({ ...status, history }),
  read: () => { const sent = entries; entries = []; return { entries: sent, status }; },
};
window.addEventListener('message', (event) => {
  const m = event.data;
  if (!m || m.tyto !== 'panel' || m.type !== 'request') return;
  const answer = answers[m.args[0]];
  event.source.postMessage(answer
    ? { tyto: 'panel', type: 'response', id: m.id, ok: true, value: answer() }
    : { tyto: 'panel', type: 'response', id: m.id, ok: false, message: 'unknown' }, '*');
});
</script></body></html>`;
}

/** Opens the page in a new context of `browser` and answers its frame once it has loaded. */
export async function openPanelPage(browser: Browser, script: PageScript): Promise<Frame> {
  const context = await browser.newContext({ colorScheme: script.scheme ?? 'light' });
  await context.route('https://tyto.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: host(script) }),
  );
  await context.route('https://panel.test/**', (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    return route.fulfill({
      contentType: name.endsWith('.js') ? 'text/javascript' : 'text/html',
      body: readFileSync(new URL(name, PANEL)),
    });
  });
  const page = await context.newPage();
  await page.goto('https://tyto.test/');
  const frame = page.frames().find((candidate) => candidate.url().startsWith('https://panel.test'));
  if (frame === undefined) throw new Error('the panel frame never loaded');
  return frame;
}
