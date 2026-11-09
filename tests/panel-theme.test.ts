import { type Browser, type Frame, type Page, chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openPanelPage } from './panel-page.js';

/**
 * The panel page's colours in both of Tyto's themes, measured on rendered pixels.
 *
 * The page runs in the system Chrome (`channel: 'chrome'`, which GitHub's Ubuntu runners
 * carry), in the host page `openPanelPage` stands in for Tyto's window with, which answers the
 * page's `call`s with a fixed conversation. Each line the person must read is photographed, and
 * the contrast between its background (its most common pixel) and its most distant pixel must
 * reach 4.5:1, WCAG's floor for body text.
 *
 * On Tyto 0.17.0's dark theme, 9 November 2026, every line was light text on that white
 * backdrop: readable only when selected.
 */

const PROBLEM = {
  kind: 'not-logged-in',
  message: 'Claude is not signed in. It uses its own login: Tyto never sees or stores it.',
  steps: ['open a terminal in Tyto and run: claude /login'],
};
const STATUS = {
  agent: 'Claude',
  running: true,
  busy: false,
  window: 'connected',
  folder: '/home/ana/work',
  problem: PROBLEM,
};
const ENTRIES = [
  { seq: 1, kind: 'user', text: 'monta o brief' },
  { seq: 2, kind: 'text', text: 'Hello, world' },
  { seq: 3, kind: 'tool', id: 't1', title: 'read_brief', status: 'completed' },
  { seq: 4, kind: 'notice', text: 'The agent ended.' },
];

/** What each line is: its selector in the page, and what it says. */
const LINES = [
  ['the agent name', 'header strong'],
  ['the window badge', '#window'],
  ['the New button', '#reset'],
  ['the person’s message', '.message.user'],
  ['the agent’s reply', '.message.agent'],
  ['a tool line', '.tool'],
  ['a notice', '.notice'],
  ['the problem', '.problem > div'],
  ['the problem’s step', '.problem code'],
] as const;

let browser: Browser;
let decoder: Page;

beforeAll(async () => {
  browser = await chromium.launch({ channel: 'chrome' });
  decoder = await browser.newPage();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

/** The part of a browser page `contrastOf` uses; this project's types carry no DOM. */
interface Pixels {
  readonly width: number;
  readonly height: number;
}
interface PageGlobals {
  createImageBitmap(blob: Blob): Promise<Pixels>;
  OffscreenCanvas: new (
    width: number,
    height: number,
  ) => {
    getContext(kind: '2d'): {
      drawImage(image: Pixels, x: number, y: number): void;
      getImageData(
        x: number,
        y: number,
        width: number,
        height: number,
      ): { data: Uint8ClampedArray };
    } | null;
  };
  document: { body: { innerText: string } };
}

/** Contrast between a PNG's most common pixel and the pixel farthest from it, decoded by Chrome. */
async function contrastOf(png: Buffer): Promise<number> {
  return decoder.evaluate(async (base64) => {
    const page = globalThis as unknown as PageGlobals;
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
    const image = await page.createImageBitmap(blob);
    const canvas = new page.OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, image.width, image.height);
    const channel = (value: number) => {
      const c = value / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (at: number) =>
      0.2126 * channel(data[at]!) +
      0.7152 * channel(data[at + 1]!) +
      0.0722 * channel(data[at + 2]!);
    const counts = new Map<number, number>();
    for (let at = 0; at < data.length; at += 4) {
      const key = (data[at]! << 16) | (data[at + 1]! << 8) | data[at + 2]!;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const [background] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const backgroundAt = (() => {
      for (let at = 0; at < data.length; at += 4) {
        if (((data[at]! << 16) | (data[at + 1]! << 8) | data[at + 2]!) === background) return at;
      }
      return 0;
    })();
    const base = luminance(backgroundAt);
    let best = 1;
    for (let at = 0; at < data.length; at += 4) {
      const other = luminance(at);
      const ratio = (Math.max(base, other) + 0.05) / (Math.min(base, other) + 0.05);
      if (ratio > best) best = ratio;
    }
    return best;
  }, png.toString('base64'));
}

async function panelIn(scheme: 'light' | 'dark'): Promise<Frame> {
  const frame = await openPanelPage(browser, { scheme, status: STATUS, entries: ENTRIES });
  await frame.waitForSelector('.notice');
  await frame.waitForSelector('.problem');
  return frame;
}

describe.each(['light', 'dark'] as const)('the panel in the %s theme', (scheme) => {
  let frame: Frame;
  beforeAll(async () => {
    frame = await panelIn(scheme);
  }, 30_000);

  it.each(LINES)('%s is readable', async (_name, selector) => {
    const png = await (await frame.$(selector))!.screenshot();
    const contrast = await contrastOf(png);
    process.stdout.write(`${scheme} ${selector}: ${contrast.toFixed(2)}:1\n`);
    expect(contrast).toBeGreaterThanOrEqual(4.5);
  });

  it('shows the problem once', async () => {
    const text = await frame.evaluate(
      () => (globalThis as unknown as PageGlobals).document.body.innerText,
    );
    expect(text.split(PROBLEM.message)).toHaveLength(2);
  });
});
