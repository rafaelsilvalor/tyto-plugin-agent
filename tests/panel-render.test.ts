import { type Browser, type Frame, chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openPanelPage } from './panel-page.js';

/**
 * What the panel page draws from the plugin's answers, in the system Chrome: the agent's
 * markdown, an agent's attempt at markup, tool lines, and the box that says the agent has no
 * Tyto tools. Tyto 0.17.0, 9 November 2026: markdown showed raw (`**`, ```` ```diff ````) and
 * tool lines said only "tool — completed".
 */

const STATUS = {
  agent: 'Claude',
  running: true,
  busy: false,
  window: 'connected',
  folder: '/home/ana/work',
  problem: null,
};

const REPLY = [
  '## Plan',
  '',
  'The brief has **two slides** and one *italic* note; run `tyto check`.',
  '',
  '- first item',
  '- second **bold** item',
  '',
  '1. one',
  '2. two',
  '',
  '> quoted line',
  '',
  'See [the docs](https://example.com/docs).',
  '',
  '```diff',
  '@@ -1,2 +1,2 @@',
  '-title: old',
  '+title: new',
  ' kept',
  '```',
].join('\n');

/** What an agent might write to break out of text; none of it may become markup. */
const ATTACK = [
  '<img src=x onerror="globalThis.hacked = 1">',
  '<script>globalThis.hacked = 2</script>',
  '**<b>bold</b>** [click](javascript:globalThis.hacked=3)',
  '`<iframe src="https://evil.test"></iframe>`',
].join('\n\n');

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ channel: 'chrome' });
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

interface Node {
  readonly tagName: string;
  readonly className: string;
  readonly textContent: string | null;
  readonly children: ArrayLike<Node>;
  querySelectorAll(selector: string): ArrayLike<Node>;
  querySelector(selector: string): Node | null;
}
/** The page's globals, inside `evaluate`; this project's types carry no DOM. */
interface PageGlobals {
  readonly document: { querySelector(selector: string): Node | null };
  readonly hacked?: unknown;
}

/** A reply streamed in pieces, as the plugin hands it over: never whole in one entry. */
function streamed(text: string, from: number): Record<string, unknown>[] {
  const pieces: Record<string, unknown>[] = [];
  for (let at = 0; at < text.length; at += 7) {
    pieces.push({ seq: from + pieces.length, kind: 'text', text: text.slice(at, at + 7) });
  }
  return pieces;
}

describe('an agent reply', () => {
  let frame: Frame;
  beforeAll(async () => {
    frame = await openPanelPage(browser, {
      status: STATUS,
      entries: [{ seq: 1, kind: 'user', text: 'oi' }, ...streamed(REPLY, 2)],
    });
    await frame.waitForSelector('.message.agent pre');
  }, 30_000);

  it('renders its markdown as elements, not as raw marks', async () => {
    const shape = await frame.evaluate(() => {
      const reply = (globalThis as unknown as PageGlobals).document.querySelector(
        '.message.agent',
      ) as Node;
      const tags = (selector: string) =>
        Array.from(reply.querySelectorAll(selector)).map((node) => node.textContent);
      return {
        heading: tags('.heading.level-2'),
        strong: tags('strong'),
        em: tags('em'),
        code: tags('p code'),
        items: tags('ul > li'),
        ordered: tags('ol > li'),
        quote: tags('blockquote'),
        text: reply.textContent,
      };
    });
    expect(shape).toMatchObject({
      heading: ['Plan'],
      strong: ['two slides', 'bold'],
      em: ['italic'],
      code: ['tyto check'],
      items: ['first item', 'second bold item'],
      ordered: ['one', 'two'],
      quote: ['quoted line'],
    });
    expect(shape.text).not.toContain('**');
    expect(shape.text).not.toContain('```');
  });

  it('colours a diff block by line', async () => {
    const rows = await frame.evaluate(() => {
      const block = (globalThis as unknown as PageGlobals).document.querySelector(
        'pre code',
      ) as Node;
      return {
        language: block.className,
        rows: Array.from(block.children).map((row) => [row.className, row.textContent]),
      };
    });
    expect(rows).toEqual({
      language: 'language-diff',
      rows: [
        ['hunk', '@@ -1,2 +1,2 @@\n'],
        ['removed', '-title: old\n'],
        ['added', '+title: new\n'],
        ['', ' kept\n'],
      ],
    });
  });

  it('shows a link as text with its address, and no anchor', async () => {
    const link = await frame.evaluate(() => {
      const reply = (globalThis as unknown as PageGlobals).document.querySelector(
        '.message.agent',
      ) as Node;
      return {
        anchors: reply.querySelectorAll('a').length,
        text: reply.querySelector('.link')?.textContent,
        address: reply.querySelector('.address')?.textContent,
      };
    });
    expect(link).toEqual({ anchors: 0, text: 'the docs', address: ' (https://example.com/docs)' });
  });
});

describe('markup an agent writes', () => {
  it('stays text: no element, no script run', async () => {
    const frame = await openPanelPage(browser, {
      status: STATUS,
      entries: [{ seq: 1, kind: 'user', text: 'oi' }, ...streamed(ATTACK, 2)],
    });
    await frame.waitForFunction(() =>
      (globalThis as unknown as PageGlobals).document
        .querySelector('.message.agent')
        ?.textContent?.includes('evil.test'),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const seen = await frame.evaluate(() => {
      const page = globalThis as unknown as PageGlobals as PageGlobals;
      const reply = page.document.querySelector('.message.agent') as Node;
      return {
        made: ['img', 'script', 'b', 'iframe', 'a'].map(
          (tag) => reply.querySelectorAll(tag).length,
        ),
        hacked: page.hacked ?? null,
        text: reply.textContent,
      };
    });
    expect(seen.made).toEqual([0, 0, 0, 0, 0]);
    expect(seen.hacked).toBeNull();
    expect(seen.text).toContain('<img src=x onerror="globalThis.hacked = 1">');
    expect(seen.text).toContain('<script>globalThis.hacked = 2</script>');
    expect(seen.text).toContain('<b>bold</b>');
  });
});

describe('the header and the log', () => {
  it('say the agent has no Tyto tools, with the message rendered once', async () => {
    const message =
      "Claude started without Tyto's tools, so it cannot see the brief in front or act on it. Ask your organisation's admin to allow the MCP server `tyto`; Tyto does not work around that policy.";
    const frame = await openPanelPage(browser, {
      status: {
        ...STATUS,
        window: 'missing',
        problem: { kind: 'no-tools', message, steps: [] },
      },
    });
    await frame.waitForSelector('.problem');
    const seen = await frame.evaluate(() => {
      const page = globalThis as unknown as PageGlobals as PageGlobals;
      const box = page.document.querySelector('.problem') as Node;
      return {
        badge: page.document.querySelector('#window')?.textContent,
        boxes: page.document.querySelector('#log')!.querySelectorAll('.problem').length,
        code: Array.from(box.querySelectorAll('code')).map((node) => node.textContent),
        text: box.textContent,
      };
    });
    expect(seen).toEqual({
      badge: 'no Tyto tools',
      boxes: 1,
      code: ['tyto'],
      text: message.replaceAll('`', ''),
    });
  });

  it('show a tool line with the name the plugin gives it', async () => {
    const frame = await openPanelPage(browser, {
      status: STATUS,
      entries: [
        { seq: 1, kind: 'tool', id: 't1', title: 'Tyto · describe a template', status: 'pending' },
        {
          seq: 2,
          kind: 'tool',
          id: 't1',
          title: 'Tyto · describe a template',
          status: 'completed',
        },
      ],
    });
    await frame.waitForSelector('.tool');
    const lines = await frame.evaluate(() =>
      Array.from(
        (globalThis as unknown as PageGlobals as PageGlobals).document
          .querySelector('#log')!
          .querySelectorAll('.tool'),
      ).map((node) => node.textContent),
    );
    expect(lines).toEqual(['Tyto · describe a template — completed']);
  });
});

describe('the history of earlier conversations', () => {
  // Reported on Tyto 0.17.0 (9 November 2026) as "the top of the history is cut off". Not
  // reproduced here at 420×560, 300×260, 260×180 or 800×300, nor in the real window: this
  // guards the layout (nothing above the log's top, no message shrunk) rather than proving a fix.
  it.each([
    [420, 560],
    [260, 180],
  ])('starts at the top of the log, every message whole, at %i×%i', async (width, height) => {
    const history = Array.from({ length: 40 }, (_, at) => ({
      role: at % 2 === 0 ? 'user' : 'agent',
      text: `message ${String(at)} ${'palavra '.repeat((at % 7) * 6 + 3)}`,
    }));
    const frame = await openPanelPage(browser, { status: STATUS, history, width, height });
    await frame.waitForSelector('.meta');
    const layout = await frame.evaluate(() => {
      interface Box {
        readonly top: number;
        readonly height: number;
      }
      interface Shown {
        scrollTop: number;
        readonly scrollHeight: number;
        readonly firstElementChild: Shown | null;
        readonly children: ArrayLike<Shown>;
        getBoundingClientRect(): Box;
      }
      const log = (
        globalThis as unknown as { document: { getElementById(id: string): Shown } }
      ).document.getElementById('log');
      log.scrollTop = 0;
      const top = log.getBoundingClientRect().top;
      const children = Array.from(log.children);
      return {
        first: log.firstElementChild!.getBoundingClientRect().top - top,
        shrunk: children.filter(
          (child) => child.scrollHeight > child.getBoundingClientRect().height + 1,
        ).length,
        count: children.length,
      };
    });
    expect(layout.first).toBeGreaterThanOrEqual(0);
    expect(layout.shrunk).toBe(0);
    expect(layout.count).toBe(41);
  });
});
