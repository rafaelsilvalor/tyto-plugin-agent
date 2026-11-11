import { type Browser, type Frame, chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { callsOf, openPanelPage, requestsOf } from './panel-page.js';

/**
 * TYTO-661, in the system Chrome: the API driver's page. The key goes from the field straight to
 * Tyto's keychain and never to the plugin; the picker switches agents; each call's tokens and
 * cost show as a line.
 */

const KEY = 'sk-ant-page-probe-81d2';

const NO_KEY = {
  agent: 'Modelador · Claude Haiku 5.5',
  running: true,
  busy: false,
  window: 'connected',
  folder: null,
  agents: [
    { name: 'Modelador', model: 'claude-haiku-5-5' },
    { name: 'Revisor', model: 'claude-opus-5-5' },
  ],
  agentName: 'Modelador',
  problem: {
    kind: 'no-key',
    message: 'Enter your Claude API key.',
    steps: [],
    params: {},
    canEnterKey: true,
  },
};

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ channel: 'chrome' });
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

interface Field {
  value: string;
  readonly type: string;
  readonly hidden: boolean;
  readonly textContent: string | null;
  readonly options: { readonly length: number };
  dispatchEvent(event: unknown): boolean;
  click(): void;
}
interface PageGlobals {
  readonly document: {
    querySelector(selector: string): Field | null;
    querySelectorAll(selector: string): { readonly length: number };
  };
  Event: new (type: string) => unknown;
}

function until(frame: Frame, check: string): Promise<unknown> {
  return frame.waitForFunction(check, undefined, { timeout: 5000 });
}

describe('the API driver’s page', () => {
  it('stores the key in Tyto’s keychain itself, never through the plugin, and empties the field', async () => {
    const frame = await openPanelPage(browser, {
      status: NO_KEY,
      afterKey: { ...NO_KEY, problem: null },
    });
    await until(frame, "document.querySelector('.key input') !== null");
    expect(
      await frame.evaluate(() => {
        const page = globalThis as unknown as PageGlobals;
        return page.document.querySelector('.key input')!.type;
      }),
    ).toBe('password');
    await frame.evaluate((key) => {
      const page = globalThis as unknown as PageGlobals;
      page.document.querySelector('.key input')!.value = key;
      page.document.querySelector('.key button')!.click();
    }, KEY);
    await until(frame, "document.querySelector('.key input').value === ''");
    await frame.waitForFunction(
      () =>
        [
          ...(
            globalThis as unknown as {
              document: { querySelectorAll(s: string): { textContent: string }[] };
            }
          ).document.querySelectorAll('.notice'),
        ].some((n) => n.textContent.includes('keychain')),
      undefined,
      { timeout: 5000 },
    );
    const requests = await requestsOf(frame);
    expect(requests.filter(([capability]) => capability === 'storeCredential')).toEqual([
      ['storeCredential', ['anthropic-api-key', KEY]],
    ]);
    // Nothing the page asked of the plugin carries the key.
    const toPlugin = requests.filter(([capability]) => capability === 'call');
    expect(JSON.stringify(toPlugin)).not.toContain(KEY);
    expect(await callsOf(frame)).toContainEqual(['keySaved']);
  });

  it('offers the agents as a picker, and switching asks the plugin', async () => {
    const frame = await openPanelPage(browser, { status: { ...NO_KEY, problem: null } });
    await until(frame, "!document.querySelector('#pick').hidden");
    expect(
      await frame.evaluate(() => {
        const page = globalThis as unknown as PageGlobals;
        return page.document.querySelector('#pick')!.options.length;
      }),
    ).toBe(2);
    await frame.evaluate(() => {
      const page = globalThis as unknown as PageGlobals;
      const pick = page.document.querySelector('#pick')!;
      pick.value = 'Revisor';
      pick.dispatchEvent(new page.Event('change'));
    });
    await until(frame, "document.querySelector('#pick').value === 'Revisor'");
    expect(await callsOf(frame)).toContainEqual(['useAgent', 'Revisor']);
  });

  it('hides the picker for an agent program, which is one agent', async () => {
    const frame = await openPanelPage(browser, {
      status: {
        agent: 'Claude',
        running: true,
        busy: false,
        window: 'connected',
        folder: null,
        problem: null,
      },
    });
    await until(frame, "document.querySelector('#agent').textContent === 'Claude'");
    expect(
      await frame.evaluate(() => {
        const page = globalThis as unknown as PageGlobals;
        return page.document.querySelector('#pick')!.hidden;
      }),
    ).toBe(true);
  });

  it('shows each call’s tokens and estimated cost against the month', async () => {
    const frame = await openPanelPage(browser, {
      status: { ...NO_KEY, problem: null },
      entries: [
        {
          seq: 1,
          kind: 'usage',
          model: 'claude-haiku-5-5',
          inputTokens: 1200,
          outputTokens: 80,
          cacheReadTokens: 900,
          cacheWriteTokens: 0,
          cost: '0.0003',
          month: '0.42',
          cap: '10.00',
        },
      ],
    });
    await until(frame, "document.querySelector('.usage') !== null");
    expect(
      await frame.evaluate(() => {
        const page = globalThis as unknown as PageGlobals;
        return page.document.querySelector('.usage')!.textContent;
      }),
    ).toBe(
      'claude-haiku-5-5 · 1200 in (900 cached, 0 written) · 80 out · ~US$0.0003 · month US$0.42 of US$10.00',
    );
  });
});
