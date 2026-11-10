// The agent panel's page. It runs in a sandboxed frame with no network (Tyto ADR 0045) and
// reaches its plugin only through `call` on the bridge (ADR 0173). Nothing is pushed to it, so
// it asks for what is new (`read {after}`) a few times a second while a turn runs, and every few
// seconds otherwise, to hear that the agent ended.
//
// Everything the agent says is set as text, never as HTML.
//
// Tyto also tells the page, unasked, what the document in front is (`document`: its text, and
// since Tyto 0.18 its name and the format the preview shows) and the window's language
// (`language`, since 0.18). The page draws the context chip from the first and speaks the second;
// on an older Tyto it reads the template from the brief's text and the language from the browser.

/* global WORDS */

const FAST_MS = 250;
const IDLE_MS = 3000;

const pending = new Map();
let nextId = 1;

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message === null || typeof message !== 'object' || message.tyto !== 'panel') return;
  if (message.type === 'event') {
    heard(message);
    return;
  }
  if (message.type !== 'response') return;
  const waiting = pending.get(message.id);
  if (waiting === undefined) return;
  pending.delete(message.id);
  if (message.ok) waiting.resolve(message.value);
  else waiting.reject(new Error(message.message || message.code || 'refused'));
});

/** Asks the plugin's process; resolves with its answer's value. */
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.parent.postMessage(
      { tyto: 'panel', type: 'request', id, capability: 'call', args: [method, params ?? {}] },
      '*',
    );
  });
}

const log = document.getElementById('log');
const input = document.getElementById('input');
const sendButton = document.getElementById('send');
const stopButton = document.getElementById('stop');
const agentName = document.getElementById('agent');
const resetButton = document.getElementById('reset');
const context = document.getElementById('context');
const working = document.getElementById('working');

let after = 0;
let busy = false;
/** The last status the plugin answered; the chip and the working line read it. */
let lastStatus = null;
/** The tools the agent is using now, by call id, while they run; named when shown. */
const running = new Map();
/** Permissions the agent asked for and the person has not answered. */
const waiting = new Set();
let stopping = false;

/** `en` or `pt-BR`: Tyto's, once it says; until then the browser's, which is the system's. */
let language = /^pt\b/iu.test(navigator.language) ? 'pt-BR' : 'en';
const say = () => WORDS[language];

/** The document in front, as Tyto last told it; `null` before it says anything. */
let front = null;
let currentReply = null;
let timer = null;
const tools = new Map();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Markdown, the part an agent writes: paragraphs, headings, lists, quotes, fenced code (a
// `diff` block colours its lines), and inline bold, italic, code and links. Every node is made
// with createElement and filled with textContent, never innerHTML, so the agent's text cannot
// become markup: a `<script>` it writes shows as text. A link shows its text and its address and
// is not a link; the frame could not follow it anyway (sandbox, no network).

const INLINE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\s](?:[^*]*[^*\s])?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/u;

/** Appends `text`'s inline markdown to `parent`. */
function inline(parent, text) {
  let rest = text;
  for (let match = INLINE.exec(rest); match !== null; match = INLINE.exec(rest)) {
    if (match.index > 0) parent.appendChild(document.createTextNode(rest.slice(0, match.index)));
    if (match[1] !== undefined) {
      parent.appendChild(element('code', '', match[2]));
    } else if (match[3] !== undefined || match[4] !== undefined) {
      inline(parent.appendChild(element('strong')), match[3] ?? match[4]);
    } else if (match[5] !== undefined) {
      inline(parent.appendChild(element('em')), match[5]);
    } else {
      inline(parent.appendChild(element('span', 'link')), match[6]);
      parent.appendChild(element('span', 'address', ` (${match[7]})`));
    }
    rest = rest.slice(match.index + match[0].length);
  }
  if (rest !== '') parent.appendChild(document.createTextNode(rest));
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/u;
const HEADING = /^(#{1,6})\s+(.*)$/u;
const ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/u;
const QUOTE = /^\s*>\s?(.*)$/u;

/** A fenced block's code; a `diff` block marks each line added, removed or a hunk. */
function codeBlock(language, rows) {
  const code = element('code', language === '' ? '' : `language-${language}`);
  if (language !== 'diff' && language !== 'patch') {
    code.textContent = rows.join('\n');
    return code;
  }
  for (const row of rows) {
    const kind = row.startsWith('+')
      ? 'added'
      : row.startsWith('-')
        ? 'removed'
        : row.startsWith('@@')
          ? 'hunk'
          : '';
    code.appendChild(element('span', kind, `${row}\n`));
  }
  return code;
}

/** `text` as markdown, in a fragment of plain DOM nodes. */
function markdown(text) {
  const fragment = document.createDocumentFragment();
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  let paragraph = [];
  let list = null;
  const endBlock = () => {
    if (paragraph.length > 0) inline(fragment.appendChild(element('p')), paragraph.join('\n'));
    paragraph = [];
    list = null;
  };
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at];
    const fence = FENCE.exec(line);
    const heading = HEADING.exec(line);
    const item = ITEM.exec(line);
    const quote = QUOTE.exec(line);
    if (fence !== null) {
      endBlock();
      const rows = [];
      // An unclosed fence runs to the end, as it does while the reply still streams.
      for (at += 1; at < lines.length && !lines[at].trim().startsWith(fence[1]); at += 1) {
        rows.push(lines[at]);
      }
      fragment.appendChild(element('pre')).appendChild(codeBlock(fence[2].toLowerCase(), rows));
    } else if (heading !== null) {
      endBlock();
      inline(fragment.appendChild(element('p', `heading level-${heading[1].length}`)), heading[2]);
    } else if (item !== null) {
      if (paragraph.length > 0) endBlock();
      const tag = item[1] === undefined ? 'ol' : 'ul';
      if (list === null || list.tagName.toLowerCase() !== tag) {
        list = fragment.appendChild(element(tag));
        if (tag === 'ol' && item[2] !== '1') list.start = Number(item[2]);
      }
      inline(list.appendChild(element('li')), item[3]);
    } else if (quote !== null) {
      const last = fragment.lastChild;
      const open = paragraph.length === 0 && list === null && last?.nodeName === 'BLOCKQUOTE';
      endBlock();
      const block = open ? last : fragment.appendChild(element('blockquote'));
      if (quote[1].trim() !== '') inline(block.appendChild(element('p')), quote[1]);
    } else if (line.trim() === '') {
      endBlock();
    } else {
      list = null;
      paragraph.push(line);
    }
  }
  endBlock();
  return fragment;
}

/** Puts `text`, as markdown, in `node`, in place of what it held. */
function showMarkdown(node, text) {
  node.replaceChildren(markdown(text));
}

function append(node) {
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.appendChild(node);
  if (atBottom) log.scrollTop = log.scrollHeight;
}

/** The template a brief names in its front matter, or null. */
function templateOf(text) {
  const head = /^\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(text);
  if (head === null) return null;
  const named = /^template:[ \t]*["']?([^"'\s#]+)/mu.exec(head[1]);
  return named === null ? null : named[1];
}

/** The context chip: the brief in front, its template and format, and what the agent lacks. */
function showContext() {
  const words = say();
  const template = front === null ? null : templateOf(front.text);
  const name = front?.name ? front.name.replace(/\.brief$/u, '') : null;
  const parts = template === null ? [] : [name, template, front?.format ?? null];
  const brief = element(
    'span',
    template === null ? 'context-brief empty' : 'context-brief',
    template === null ? words.noBrief : parts.filter((part) => part).join(' · '),
  );
  const nodes = [brief];
  const reach = words.reach[lastStatus?.window];
  if (reach !== undefined) nodes.push(element('span', 'context-reach', reach));
  const title = `${words.contextTitle}: ${nodes.map((node) => node.textContent).join(' — ')}`;
  // Every read redraws the status, four times a second in a turn: the chip is replaced only
  // when what it says changed, so it is not a new element under the pointer each time.
  const said = `${brief.className}|${title}`;
  if (context.dataset.said === said) return;
  context.dataset.said = said;
  context.replaceChildren(...nodes);
  context.title = title;
}

/** A tool's name as a line says it: Tyto's own in the page's language. */
function toolName(entry) {
  if (entry.tyto === undefined) return entry.title || 'tool';
  return `Tyto · ${say().tools[entry.tyto] ?? entry.tyto.replaceAll('_', ' ')}`;
}

/** What the agent is doing, above the input, while a turn runs. */
function showWorking() {
  const words = say();
  working.hidden = !busy;
  if (!busy) return;
  const tools = [...running.values()];
  working.querySelector('.working-text').textContent = stopping
    ? words.stopping
    : waiting.size > 0
      ? words.waiting
      : tools.length > 0
        ? words.using(toolName(tools[tools.length - 1]))
        : words.thinking;
}

/** The words the page writes itself, again in the page's language. */
function showWords() {
  const words = say();
  document.documentElement.lang = language;
  if (lastStatus === null) agentName.textContent = words.agent;
  resetButton.textContent = words.newConversation;
  resetButton.title = words.newTitle;
  input.placeholder = words.placeholder;
  sendButton.textContent = words.send;
  stopButton.textContent = words.stop;
  stopButton.title = words.stopTitle;
  showContext();
  showWorking();
  if (shownProblem !== null) showProblem(lastStatus?.problem ?? null, true);
}

function showStatus(status) {
  lastStatus = status;
  agentName.textContent = status.agent;
  busy = status.busy;
  if (!busy) {
    stopping = false;
    running.clear();
    waiting.clear();
  }
  // Stop takes Send's place while a turn runs: one button, always under the person's hand.
  sendButton.hidden = busy;
  stopButton.hidden = !busy;
  showContext();
  showWorking();
}

/** What Tyto says unasked: the document in front, and its language. */
function heard(message) {
  if (message.event === 'document' && typeof message.text === 'string') {
    front = {
      text: message.text,
      name: typeof message.name === 'string' ? message.name : null,
      format: typeof message.format === 'string' ? message.format : null,
    };
    showContext();
  } else if (message.event === 'language' && Object.hasOwn(WORDS, message.language)) {
    language = message.language;
    showWords();
  }
}

let shownProblem = null;
let problemBox = null;

/** A problem in the page's language, from its kind and names; the process's English otherwise. */
function problemWords(problem) {
  const words = say();
  const params = problem.params;
  const known = params === undefined ? undefined : words.problems[problem.kind];
  const message =
    known === undefined ? problem.message : known({ ...params, canLogIn: problem.canLogIn });
  return { message, steps: problem.steps };
}

/**
 * Whether the person went to sign in from this panel (TYTO-657): the panel then tries again when
 * they come back to it, and says so once it worked.
 */
let signingIn = false;

/** Opens the agent's own sign-in in a Tyto terminal; the plugin never sees what runs there. */
async function logIn() {
  try {
    const answer = await call('login');
    if (answer.opened) {
      signingIn = true;
      append(element('div', 'notice', say().loginOpened));
      return;
    }
    const refused = say().loginRefusals[answer.code];
    append(
      element(
        'div',
        'notice',
        typeof refused === 'function' ? refused(answer.reason ?? '') : (refused ?? answer.reason),
      ),
    );
  } catch (cause) {
    append(element('div', 'notice', say().unreachable(cause.message)));
  }
}

/** Starts the agent again after a sign-in, and says whether it is signed in now. */
async function tryAgain() {
  try {
    const status = await call('open');
    showStatus(status);
    if (status.problem === null) {
      signingIn = false;
      shownProblem = null;
      append(element('div', 'notice', say().signedIn(status.agent)));
    } else {
      // Said again at the bottom, so a press of Try again that changed nothing still answers.
      shownProblem = null;
      showProblem(status.problem);
    }
  } catch (cause) {
    append(element('div', 'notice', say().unreachable(cause.message)));
  }
}

// Coming back to the panel after signing in: the person clicks into it, or the window returns.
const cameBack = () => {
  if (signingIn && lastStatus?.problem?.kind === 'not-logged-in') void tryAgain();
};
window.addEventListener('focus', cameBack);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') cameBack();
});

/** Shows the status's problem once; `again` redraws the one shown, in another language. */
function showProblem(problem, again = false) {
  const key = problem === null ? null : `${problem.kind}:${problem.message}`;
  if (key === shownProblem && !again) return;
  shownProblem = key;
  if (problem === null) return;
  const { message, steps } = problemWords(problem);
  const box = element('div', 'problem');
  showMarkdown(box.appendChild(element('div', 'said')), message);
  for (const step of steps) box.appendChild(element('code', '', step));
  if (problem.kind === 'not-logged-in' && problem.canLogIn === true) {
    const choices = element('div', 'choices');
    const login = element('button', 'primary', say().logIn(problem.params?.label ?? ''));
    login.addEventListener('click', () => void logIn());
    const retry = element('button', '', say().tryAgain);
    retry.addEventListener('click', () => void tryAgain());
    choices.append(login, retry);
    box.appendChild(choices);
  }
  if (problem.kind === 'not-downloaded' && problem.canDownload === true) {
    const choices = element('div', 'choices');
    const download = element('button', 'primary', say().download);
    download.addEventListener('click', () => void startDownload(download));
    choices.append(download);
    box.appendChild(choices);
  }
  box.dataset.kind = problem.kind;
  // A download's progress replaces its own line rather than adding one per package.
  const inPlace =
    again || (problem.kind === 'downloading' && problemBox?.dataset.kind === 'downloading');
  if (inPlace && problemBox !== null && problemBox.isConnected) problemBox.replaceWith(box);
  else append(box);
  problemBox = box;
}

/** Starts the download the person accepted (TYTO-666); `poll` follows its progress. */
async function startDownload(button) {
  button.disabled = true;
  try {
    const answer = await call('download');
    if (answer.started || answer.code === 'running') void poll();
  } catch (cause) {
    button.disabled = false;
    append(element('div', 'notice', say().unreachable(cause.message)));
  }
}

/** Whether the last status was a download: when it ends, the panel starts the agent by itself. */
let wasDownloading = false;

function followDownload(status) {
  const downloading = status.problem?.kind === 'downloading';
  if (wasDownloading && !downloading && status.problem === null) {
    append(element('div', 'notice', say().downloaded(status.agent)));
    void tryAgain();
  }
  wasDownloading = downloading;
}

function permissionBox(entry) {
  const box = element('div', 'permission');
  box.id = `permission-${entry.id}`;
  box.appendChild(element('div', '', say().asks(entry.title)));
  const choices = element('div', 'choices');
  for (const option of entry.options) {
    const button = element('button', option.kind.startsWith('allow') ? 'primary' : '', option.name);
    button.addEventListener('click', () => {
      for (const other of choices.querySelectorAll('button')) other.disabled = true;
      void call('answer', { id: entry.id, optionId: option.optionId });
    });
    choices.appendChild(button);
  }
  box.appendChild(choices);
  return box;
}

function show(entry) {
  switch (entry.kind) {
    case 'user':
      currentReply = null;
      append(element('div', 'message user', entry.text));
      break;
    case 'text':
      if (currentReply === null) {
        currentReply = { node: element('div', 'message agent'), text: '' };
        append(currentReply.node);
      }
      // The whole reply again, so a bold or a code block split across pieces renders once whole.
      currentReply.text += entry.text;
      showMarkdown(currentReply.node, currentReply.text);
      if (log.scrollHeight - log.scrollTop - log.clientHeight < 80)
        log.scrollTop = log.scrollHeight;
      break;
    case 'thought':
      append(element('div', 'thought', entry.text));
      break;
    case 'tool': {
      const status = entry.status || 'pending';
      const text = `${toolName(entry)} — ${say().toolStatus[status] ?? status}`;
      if (status === 'pending' || status === 'in_progress') running.set(entry.id, entry);
      else running.delete(entry.id);
      const known = tools.get(entry.id);
      if (known !== undefined) known.textContent = text;
      else {
        const line = element('div', 'tool', text);
        tools.set(entry.id, line);
        append(line);
      }
      currentReply = null;
      break;
    }
    case 'plan':
      append(
        element(
          'div',
          'meta',
          entry.entries.map((item) => `• ${item.content} (${item.status})`).join('\n'),
        ),
      );
      break;
    case 'permission':
      currentReply = null;
      waiting.add(entry.id);
      append(permissionBox(entry));
      break;
    case 'answered': {
      waiting.delete(entry.id);
      const box = document.getElementById(`permission-${entry.id}`);
      if (box !== null) {
        for (const button of box.querySelectorAll('button')) button.disabled = true;
        box.appendChild(
          element('div', 'meta', say().answered(entry.cancelled ? say().cancelled : entry.name)),
        );
      }
      break;
    }
    case 'notice': {
      currentReply = null;
      const known = entry.code === undefined ? undefined : say().notices[entry.code];
      append(
        element('div', 'notice', known === undefined ? entry.text : known(entry.params ?? {})),
      );
      break;
    }
    case 'end':
      currentReply = null;
      if (entry.reason !== 'end_turn') {
        append(element('div', 'meta', say().stopped(say().reasons[entry.reason] ?? entry.reason)));
      }
      break;
  }
}

async function poll() {
  clearTimeout(timer);
  try {
    const answer = await call('read', { after });
    for (const entry of answer.entries) {
      show(entry);
      after = entry.seq;
    }
    showStatus(answer.status);
    showProblem(answer.status.problem);
    followDownload(answer.status);
  } catch (cause) {
    append(element('div', 'notice', say().unreachable(cause.message)));
  }
  timer = setTimeout(poll, busy || wasDownloading ? FAST_MS : IDLE_MS);
}

async function send() {
  const text = input.value;
  if (text.trim() === '' || busy) return;
  const answer = await call('send', { text });
  if (!answer.accepted) {
    append(element('div', 'notice', say().refusals[answer.code] ?? answer.reason));
    return;
  }
  input.value = '';
  busy = true;
  sendButton.hidden = true;
  stopButton.hidden = false;
  showWorking();
  void poll();
}

sendButton.addEventListener('click', () => void send());
// Enter sends and Shift+Enter adds a line, as in a chat; Ctrl+Enter (Cmd+Enter) still sends.
// An Enter that ends an input method's composition only picks the word, so it sends nothing.
// While a turn runs the box stays editable for the next message, and Enter sends nothing.
input.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
  if (event.shiftKey && !event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  void send();
});
stopButton.addEventListener('click', () => {
  stopping = true;
  showWorking();
  void call('cancel').then(() => poll());
});
resetButton.addEventListener('click', async () => {
  await call('reset');
  log.replaceChildren();
  tools.clear();
  running.clear();
  waiting.clear();
  currentReply = null;
  shownProblem = null;
  problemBox = null;
  void openPanel();
});

async function openPanel() {
  try {
    const status = await call('open');
    for (const message of status.history) {
      const node = element('div', `message earlier ${message.role}`);
      if (message.role === 'agent') showMarkdown(node, message.text);
      else node.textContent = message.text;
      append(node);
    }
    if (status.history.length > 0) append(element('div', 'meta', say().earlier));
    showStatus(status);
    showProblem(status.problem);
    followDownload(status);
  } catch (cause) {
    append(element('div', 'notice', say().unreachable(cause.message)));
  }
  void poll();
}

showWords();
void openPanel();
