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
 * `read` with the entries, every later one with none. `send` is accepted and makes the status
 * busy; `send`, `cancel` and `login` are kept in `globalThis.calls` of the host page, for a test
 * to read, and so is every `open` after a `login`, which answers `afterLogin` when given.
 * `tell` posts what Tyto's window posts unasked (`document`, `language`).
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
  /** The browser's language, which the page falls back to when Tyto says none. */
  readonly locale?: string;
  /** What `login` answers; `{ opened: true }` when absent. */
  readonly login?: Record<string, unknown>;
  /** The status `open` answers once `login` was called: the person signed in meanwhile. */
  readonly afterLogin?: Record<string, unknown>;
  /**
   * The statuses successive `read`s answer once `download` was called (TYTO-666), the last one
   * kept; `open` then answers the last one too.
   */
  readonly afterDownload?: readonly Record<string, unknown>[];
}

function host(script: PageScript): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{color-scheme:light dark}
body{margin:0}
iframe{border:0;width:${String(script.width ?? 420)}px;height:${String(script.height ?? 560)}px;background:#ffffff}
</style></head><body>
<iframe sandbox="allow-scripts" src="https://panel.test/index.html"></iframe>
<script>
let status = ${JSON.stringify(script.status)};
globalThis.calls = [];
const history = ${JSON.stringify(script.history ?? [])};
let entries = ${JSON.stringify(script.entries ?? [])};
const login = ${JSON.stringify(script.login ?? { opened: true })};
const afterLogin = ${JSON.stringify(script.afterLogin ?? null)};
const afterDownload = ${JSON.stringify(script.afterDownload ?? [])};
const answers = {
  open: () => {
    if (calls.some((c) => c[0] === 'login')) { calls.push(['open']); if (afterLogin) status = afterLogin; }
    if (calls.some((c) => c[0] === 'download')) calls.push(['open']);
    return { ...status, history };
  },
  login: () => { calls.push(['login']); return login; },
  download: () => { calls.push(['download']); return { started: true }; },
  read: () => {
    if (calls.some((c) => c[0] === 'download') && afterDownload.length > 0) {
      status = afterDownload.length > 1 ? afterDownload.shift() : afterDownload[0];
    }
    const sent = entries; entries = []; return { entries: sent, status };
  },
  send: (params) => { calls.push(['send', params.text]); status = { ...status, busy: true }; return { accepted: true }; },
  cancel: () => { calls.push(['cancel']); return status; },
};
window.addEventListener('message', (event) => {
  const m = event.data;
  if (!m || m.tyto !== 'panel' || m.type !== 'request') return;
  const answer = answers[m.args[0]];
  event.source.postMessage(answer
    ? { tyto: 'panel', type: 'response', id: m.id, ok: true, value: answer(m.args[1] || {}) }
    : { tyto: 'panel', type: 'response', id: m.id, ok: false, message: 'unknown' }, '*');
});
</script></body></html>`;
}

/** Opens the page in a new context of `browser` and answers its frame once it has loaded. */
export async function openPanelPage(browser: Browser, script: PageScript): Promise<Frame> {
  const context = await browser.newContext({
    colorScheme: script.scheme ?? 'light',
    ...(script.locale === undefined ? {} : { locale: script.locale }),
  });
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

/** Posts to the panel what Tyto's window posts unasked: `{ event: 'document', … }` and the like. */
export async function tell(frame: Frame, event: Record<string, unknown>): Promise<void> {
  await frame.page().evaluate((message) => {
    const host = globalThis as unknown as {
      document: {
        querySelector(
          selector: string,
        ): { contentWindow: { postMessage(message: unknown, target: string): void } } | null;
      };
    };
    host.document
      .querySelector('iframe')!
      .contentWindow.postMessage({ tyto: 'panel', type: 'event', ...message }, '*');
  }, event);
}

/** What the page asked the plugin to do (`send`, `cancel`), in order. */
export async function callsOf(frame: Frame): Promise<unknown[][]> {
  return frame.page().evaluate(() => (globalThis as unknown as { calls: unknown[][] }).calls);
}
