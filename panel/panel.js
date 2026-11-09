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

function append(node) {
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.appendChild(node);
  if (atBottom) log.scrollTop = log.scrollHeight;
}

const WINDOW_TEXT = {
  connected: 'sees the window',
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
  box.appendChild(element('div', '', problem.message));
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
        currentReply = element('div', 'message agent', '');
        append(currentReply);
      }
      currentReply.textContent += entry.text;
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
      append(element('div', `message earlier ${message.role}`, message.text));
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
