// The agent panel's page. It runs in a sandboxed frame with no network (Tyto ADR 0045) and
// reaches its plugin only through `call` on the bridge (ADR 0173). Nothing is pushed to it, so
// it asks for what is new (`read {after}`) a few times a second while a turn runs, and every few
// seconds otherwise, to hear that the agent ended.
//
// Everything the agent says is set as text, never as HTML.

const FAST_MS = 250;
const IDLE_MS = 3000;

const pending = new Map();
let nextId = 1;

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message === null || typeof message !== 'object' || message.tyto !== 'panel') return;
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
const windowBadge = document.getElementById('window');

let after = 0;
let busy = false;
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

const WINDOW_TEXT = {
  connected: 'sees the window',
  missing: 'no Tyto tools',
  off: 'window off (agentsListen)',
  unavailable: 'no window',
  unknown: 'window: …',
};

function showStatus(status) {
  agentName.textContent = status.agent;
  windowBadge.textContent = WINDOW_TEXT[status.window] ?? status.window;
  busy = status.busy;
  sendButton.disabled = busy;
  stopButton.hidden = !busy;
}

let shownProblem = null;
function showProblem(problem) {
  const key = problem === null ? null : `${problem.kind}:${problem.message}`;
  if (key === shownProblem) return;
  shownProblem = key;
  if (problem === null) return;
  const box = element('div', 'problem');
  showMarkdown(box.appendChild(element('div', 'said')), problem.message);
  for (const step of problem.steps) box.appendChild(element('code', '', step));
  append(box);
}

function permissionBox(entry) {
  const box = element('div', 'permission');
  box.id = `permission-${entry.id}`;
  box.appendChild(element('div', '', `The agent asks to use ${entry.title}.`));
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
      const text = `${entry.title || 'tool'} — ${entry.status || 'pending'}`;
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
      append(permissionBox(entry));
      break;
    case 'answered': {
      const box = document.getElementById(`permission-${entry.id}`);
      if (box !== null) {
        for (const button of box.querySelectorAll('button')) button.disabled = true;
        box.appendChild(element('div', 'meta', `Answered: ${entry.name}`));
      }
      break;
    }
    case 'notice':
      currentReply = null;
      append(element('div', 'notice', entry.text));
      break;
    case 'end':
      currentReply = null;
      if (entry.reason !== 'end_turn') append(element('div', 'meta', `Stopped: ${entry.reason}`));
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
  } catch (cause) {
    append(element('div', 'notice', `The panel could not reach the plugin: ${cause.message}`));
  }
  timer = setTimeout(poll, busy ? FAST_MS : IDLE_MS);
}

async function send() {
  const text = input.value;
  if (text.trim() === '' || busy) return;
  const answer = await call('send', { text });
  if (!answer.accepted) {
    append(element('div', 'notice', answer.reason));
    return;
  }
  input.value = '';
  busy = true;
  void poll();
}

sendButton.addEventListener('click', () => void send());
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void send();
  }
});
stopButton.addEventListener('click', () => void call('cancel').then(() => poll()));
document.getElementById('reset').addEventListener('click', async () => {
  await call('reset');
  log.replaceChildren();
  tools.clear();
  currentReply = null;
  shownProblem = null;
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
    if (status.history.length > 0) append(element('div', 'meta', 'Earlier in this folder ↑'));
    showStatus(status);
    showProblem(status.problem);
  } catch (cause) {
    append(element('div', 'notice', `The panel could not reach the plugin: ${cause.message}`));
  }
  void poll();
}

void openPanel();
