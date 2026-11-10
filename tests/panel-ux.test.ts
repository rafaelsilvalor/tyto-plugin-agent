import { type Browser, type Frame, chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { callsOf, openPanelPage, tell } from './panel-page.js';

/**
 * TYTO-660, in the system Chrome: the context chip, the working state with Stop, Enter to send,
 * and the panel in Tyto's language. Before it (tyto-plugin-agent 0.1.0, 10 November 2026) the
 * panel named no brief, Stop was a small button beside a disabled Send, only Ctrl+Enter sent,
 * and every word was English.
 */

const STATUS = {
  agent: 'Claude',
  running: true,
  busy: false,
  window: 'connected',
  folder: '/home/ana/work',
  problem: null,
};

const BRIEF = [
  '---',
  'template: news-da-semana',
  'formats: [grid, story]',
  '---',
  '::titulo Oi',
].join('\n');

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ channel: 'chrome' });
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

interface Shown {
  readonly textContent: string | null;
  readonly hidden: boolean;
  readonly disabled: boolean;
  readonly placeholder: string;
  value: string;
  focus(): void;
  dispatchEvent(event: unknown): boolean;
  getBoundingClientRect(): { readonly left: number; readonly top: number };
}
interface PageGlobals {
  readonly document: {
    querySelector(selector: string): Shown | null;
    readonly documentElement: { readonly lang: string };
  };
  KeyboardEvent: new (type: string, init: Record<string, unknown>) => unknown;
}

/** Reads `selector`'s text, or null when absent. */
function textOf(frame: Frame, selector: string): Promise<string | null> {
  return frame.evaluate(
    (wanted) =>
      (globalThis as unknown as PageGlobals).document.querySelector(wanted)?.textContent ?? null,
    selector,
  );
}

function chip(frame: Frame): Promise<string | null> {
  return textOf(frame, '#context');
}

async function waitForText(frame: Frame, selector: string, expected: string): Promise<void> {
  await frame.waitForFunction(
    ([wanted, text]) =>
      (globalThis as unknown as PageGlobals).document.querySelector(wanted!)?.textContent === text,
    [selector, expected],
    { timeout: 5_000, polling: 25 },
  );
}

describe('the context chip', () => {
  it('says no brief is in front until Tyto says one is', async () => {
    const frame = await openPanelPage(browser, { status: STATUS });
    await frame.waitForSelector('#context .context-brief');
    expect(await chip(frame)).toBe('no brief in front');
  });

  it('names the template from the brief’s text when Tyto sends only the text (Tyto 0.17)', async () => {
    const frame = await openPanelPage(browser, { status: STATUS });
    await frame.waitForSelector('#context .context-brief');
    await tell(frame, { event: 'document', text: BRIEF });
    await waitForText(frame, '#context', 'news-da-semana');
  });

  it('names the brief, its template and the format shown when Tyto sends them', async () => {
    const frame = await openPanelPage(browser, { status: STATUS });
    await frame.waitForSelector('#context .context-brief');
    await tell(frame, { event: 'document', text: BRIEF, name: 'mca-67256.brief', format: 'grid' });
    await waitForText(frame, '#context', 'mca-67256 · news-da-semana · grid');
  });

  it('says no brief is in front for a text with no template', async () => {
    const frame = await openPanelPage(browser, { status: STATUS });
    await frame.waitForSelector('#context .context-brief');
    await tell(frame, { event: 'document', text: BRIEF, name: 'a.brief', format: 'grid' });
    await waitForText(frame, '#context', 'a · news-da-semana · grid');
    await tell(frame, { event: 'document', text: '# notes', name: 'notes.md', format: null });
    await waitForText(frame, '#context', 'no brief in front');
  });

  it('says when the agent has no Tyto tools', async () => {
    const frame = await openPanelPage(browser, {
      status: { ...STATUS, window: 'missing' },
    });
    await frame.waitForSelector('#context .context-reach');
    await tell(frame, { event: 'document', text: BRIEF, name: 'a.brief', format: 'grid' });
    await waitForText(frame, '.context-brief', 'a · news-da-semana · grid');
    expect(await textOf(frame, '.context-reach')).toBe('the agent has no Tyto tools');
  });
});

/** Types `text` into the input and presses a key with the given modifiers, as an event. */
async function press(frame: Frame, text: string, init: Record<string, unknown>): Promise<boolean> {
  return frame.evaluate(
    ([value, options]) => {
      const page = globalThis as unknown as PageGlobals;
      const input = page.document.querySelector('#input')!;
      input.value = value as string;
      input.focus();
      const event = new page.KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        ...(options as Record<string, unknown>),
      });
      // `dispatchEvent` answers false when a listener called preventDefault: the Enter was taken.
      return !input.dispatchEvent(event);
    },
    [text, init] as const,
  );
}

describe('Enter', () => {
  it('sends with Enter and with Ctrl+Enter, and adds a line with Shift+Enter', async () => {
    const frame = await openPanelPage(browser, { status: STATUS });
    await frame.waitForSelector('#context .context-brief');

    expect(await press(frame, 'a line', { shiftKey: true })).toBe(false);
    expect(await press(frame, 'composing', { isComposing: true })).toBe(false);
    expect(await callsOf(frame)).toEqual([]);

    expect(await press(frame, 'first', {})).toBe(true);
    await frame.waitForFunction(
      () => (globalThis as unknown as PageGlobals).document.querySelector('#input')!.value === '',
    );
    expect(await callsOf(frame)).toEqual([['send', 'first']]);
  });

  it('sends with Ctrl+Enter, as before', async () => {
    const frame = await openPanelPage(browser, { status: STATUS });
    await frame.waitForSelector('#context .context-brief');
    expect(await press(frame, 'second', { ctrlKey: true })).toBe(true);
    await frame.waitForFunction(
      () => (globalThis as unknown as PageGlobals).document.querySelector('#input')!.value === '',
    );
    expect(await callsOf(frame)).toEqual([['send', 'second']]);
  });
});

describe('a running turn', () => {
  it('shows what the agent is doing, and Stop where Send was', async () => {
    const frame = await openPanelPage(browser, { status: STATUS });
    await frame.waitForSelector('#context .context-brief');
    const sendAt = await frame.evaluate(() =>
      (globalThis as unknown as PageGlobals).document
        .querySelector('#send')!
        .getBoundingClientRect(),
    );
    await press(frame, 'check it', {});
    await waitForText(frame, '.working-text', 'thinking…');
    const seen = await frame.evaluate(() => {
      const page = globalThis as unknown as PageGlobals;
      const stop = page.document.querySelector('#stop')!;
      return {
        send: page.document.querySelector('#send')!.hidden,
        stop: stop.hidden,
        at: stop.getBoundingClientRect(),
        input: page.document.querySelector('#input')!.disabled,
      };
    });
    expect(seen).toMatchObject({ send: true, stop: false, input: false });
    expect(seen.at).toEqual(sendAt);

    // The box stays editable for the next message, and Enter does not send it while one runs.
    expect(await press(frame, 'next one', {})).toBe(true);
    expect(await callsOf(frame)).toEqual([['send', 'check it']]);

    await frame.click('#stop');
    await waitForText(frame, '.working-text', 'stopping…');
    expect(await callsOf(frame)).toEqual([['send', 'check it'], ['cancel']]);
  });

  it('names the Tyto tool the agent is using', async () => {
    const frame = await openPanelPage(browser, {
      status: { ...STATUS, busy: true },
      entries: [
        { seq: 1, kind: 'user', text: 'check it' },
        {
          seq: 2,
          kind: 'tool',
          id: 't1',
          title: 'Tyto · check the brief',
          status: 'in_progress',
          tyto: 'check_brief',
        },
      ],
    });
    await waitForText(frame, '.working-text', 'using Tyto · check the brief…');
    // Seen in the real window: the line kept the English name after a switch to Portuguese.
    await tell(frame, { event: 'language', language: 'pt-BR' });
    await waitForText(frame, '.working-text', 'usando Tyto · verificar o brief…');
  });

  it('says it waits for the person while a permission is asked', async () => {
    const frame = await openPanelPage(browser, {
      status: { ...STATUS, busy: true },
      entries: [
        {
          seq: 1,
          kind: 'permission',
          id: 'p1',
          title: 'propose_edit',
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        },
      ],
    });
    await waitForText(frame, '.working-text', 'waiting for your answer…');
  });
});

describe('the language', () => {
  it('follows Tyto’s language when Tyto says it, and back', async () => {
    const frame = await openPanelPage(browser, { status: STATUS, locale: 'en-US' });
    await frame.waitForSelector('#context .context-brief');
    expect(await textOf(frame, '#send')).toBe('Send');

    await tell(frame, { event: 'language', language: 'pt-BR' });
    await waitForText(frame, '#send', 'Enviar');
    const shown = await frame.evaluate(() => {
      const page = globalThis as unknown as PageGlobals;
      return {
        lang: page.document.documentElement.lang,
        stop: page.document.querySelector('#stop')!.textContent,
        reset: page.document.querySelector('#reset')!.textContent,
        placeholder: page.document.querySelector('#input')!.placeholder,
        chip: page.document.querySelector('#context')!.textContent,
      };
    });
    expect(shown).toEqual({
      lang: 'pt-BR',
      stop: 'Parar',
      reset: 'Nova',
      placeholder: 'Pergunte ao agente… (Enter envia, Shift+Enter quebra a linha)',
      chip: 'nenhum brief na frente',
    });

    await tell(frame, { event: 'language', language: 'en' });
    await waitForText(frame, '#send', 'Send');
  });

  it('falls back to the browser’s language when Tyto says none (Tyto 0.17)', async () => {
    const frame = await openPanelPage(browser, { status: STATUS, locale: 'pt-BR' });
    await waitForText(frame, '#send', 'Enviar');
  });

  it('ignores a language it has no words for', async () => {
    const frame = await openPanelPage(browser, { status: STATUS, locale: 'en-US' });
    await frame.waitForSelector('#context .context-brief');
    await tell(frame, { event: 'language', language: 'fr' });
    await tell(frame, { event: 'language', language: 'pt-BR' });
    await waitForText(frame, '#send', 'Enviar');
  });

  it('says a problem, its step and a notice in Portuguese from their codes', async () => {
    const frame = await openPanelPage(browser, {
      status: {
        ...STATUS,
        problem: {
          kind: 'not-logged-in',
          message: 'Claude is not signed in. It uses its own login: Tyto never sees or stores it.',
          steps: ['open a terminal in Tyto and run: claude /login'],
          params: { label: 'Claude', login: 'claude /login' },
        },
      },
      entries: [
        {
          seq: 1,
          kind: 'notice',
          code: 'ended',
          params: { exit: '1' },
          text: 'The agent ended (exit 1). Your next message starts it again.',
        },
      ],
      locale: 'pt-BR',
    });
    await frame.waitForSelector('.notice');
    await frame.waitForSelector('.problem');
    expect(await textOf(frame, '.problem .said')).toBe(
      'O Claude não está conectado. Ele usa o próprio login: o Tyto nunca o vê nem o guarda.',
    );
    expect(await textOf(frame, '.problem code')).toBe(
      'abra um terminal no Tyto e rode: claude /login',
    );
    expect(await textOf(frame, '.notice')).toBe(
      'O agente encerrou (saída 1). A sua próxima mensagem o inicia de novo.',
    );

    // A switch redraws the problem in place, once.
    await tell(frame, { event: 'language', language: 'en' });
    await waitForText(
      frame,
      '.problem .said',
      'Claude is not signed in. It uses its own login: Tyto never sees or stores it.',
    );
    expect(
      await frame.evaluate(
        () =>
          (
            globalThis as unknown as {
              document: { querySelectorAll(selector: string): ArrayLike<unknown> };
            }
          ).document.querySelectorAll('.problem').length,
      ),
    ).toBe(1);
  });
});
