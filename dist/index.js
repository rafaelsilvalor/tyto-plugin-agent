// src/acp/connection.ts
var RpcError = class extends Error {
  code;
  data;
  constructor(code, message, data) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
};
var AUTH_REQUIRED = -32e3;
var METHOD_NOT_FOUND = -32601;
var INTERNAL_ERROR = -32603;
function lineReader(onLine) {
  const decoder = new TextDecoder();
  let buffered = "";
  return (bytes) => {
    buffered += decoder.decode(bytes, { stream: true });
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const line = buffered.slice(0, end).replace(/\r$/u, "");
      buffered = buffered.slice(end + 1);
      if (line.trim() !== "") onLine(line);
    }
  };
}
function connect(transport, options = {}) {
  const pending = /* @__PURE__ */ new Map();
  const handlers = /* @__PURE__ */ new Map();
  let nextId = 1;
  let closed;
  const send = (message) => (
    // JSON.stringify never writes a raw newline, so one message stays one line.
    transport.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}
`)
  );
  async function answer(id, method, params) {
    const handler = handlers.get(method);
    if (handler === void 0) {
      await send({ id, error: { code: METHOD_NOT_FOUND, message: `no handler for ${method}` } });
      return;
    }
    try {
      const result = await handler(params);
      await send({ id, result: result ?? null });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await send({ id, error: { code: INTERNAL_ERROR, message } });
    }
  }
  function heard(line) {
    let message;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      message = parsed;
    } catch {
      options.onProblem?.(`the agent wrote a line that is not JSON: ${line.slice(0, 200)}`);
      return;
    }
    const { id, method } = message;
    if (typeof method === "string") {
      if (id === void 0) {
        void Promise.resolve().then(() => handlers.get(method)?.(message["params"])).catch((cause) => options.onProblem?.(String(cause)));
      } else {
        void answer(id, method, message["params"]).catch(
          (cause) => options.onProblem?.(String(cause))
        );
      }
      return;
    }
    if (typeof id !== "number") return;
    const waiting = pending.get(id);
    if (waiting === void 0) return;
    pending.delete(id);
    const error = message["error"];
    if (error !== void 0 && error !== null) {
      waiting.reject(
        new RpcError(
          typeof error.code === "number" ? error.code : INTERNAL_ERROR,
          typeof error.message === "string" ? error.message : "the agent answered an error",
          error.data
        )
      );
    } else {
      waiting.resolve(message["result"]);
    }
  }
  transport.onStdout(lineReader(heard));
  return {
    request(method, params) {
      if (closed !== void 0) return Promise.reject(new Error(closed));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ id, method, params }).catch((cause) => {
          pending.delete(id);
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        });
      });
    },
    notify(method, params) {
      if (closed !== void 0) return Promise.resolve();
      return send({ method, params });
    },
    handle(method, handler) {
      handlers.set(method, handler);
    },
    close(reason) {
      closed = reason;
      for (const waiting of pending.values()) waiting.reject(new Error(reason));
      pending.clear();
    }
  };
}

// src/launcher/protocol.ts
var STATUS_ARGUMENT = "--tyto-status";
var INSTALL_ARGUMENT = "--tyto-install";

// src/adapter.ts
async function runLines(host, program, args, onLine) {
  const started = await host.process.start(program, [...args]);
  const decoder = new TextDecoder();
  let buffered = "";
  started.onStdout((bytes) => {
    buffered += decoder.decode(bytes, { stream: true });
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const text = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      if (text === "") continue;
      try {
        const line = JSON.parse(text);
        if (typeof line === "object" && line !== null && typeof line.tyto === "string")
          onLine(line);
      } catch {
      }
    }
  });
  const exit = await started.exited;
  return exit.code;
}
async function adapterStatus(host, program) {
  let status;
  await runLines(host, program, [STATUS_ARGUMENT], (line) => {
    if (line.tyto === "status") status = line;
  });
  return status;
}
async function installAdapter(host, program, onProgress) {
  let outcome;
  const exit = await runLines(host, program, [INSTALL_ARGUMENT], (line) => {
    if (line.tyto === "progress") onProgress(line.done, line.total);
    else if (line.tyto === "installed") outcome = { installed: true };
    else if (line.tyto === "failed")
      outcome = { installed: false, code: line.code, message: line.message };
  });
  return outcome ?? {
    installed: false,
    code: "unknown",
    message: `the download ended without saying how (exit ${String(exit)})`
  };
}
function megabytes(bytes) {
  return String(Math.max(1, Math.round(bytes / 1e6)));
}

// src/drivers.ts
var CLAUDE_AUTH_REPORT = {
  notification: "_auth/status_update",
  signedOut(params) {
    const kind = params?.authStatus?.kind;
    if (kind === "none") return true;
    return typeof kind === "string" ? false : void 0;
  }
};
var CLAUDE_SERVER_REPORT = {
  sessionMeta: { claudeCode: { emitRawSDKMessages: [{ type: "system", subtype: "init" }] } },
  notification: "_claude/sdkMessage",
  servers(params) {
    const message = params?.message;
    if (message?.["type"] !== "system" || message["subtype"] !== "init") return void 0;
    const servers = message["mcp_servers"];
    if (!Array.isArray(servers)) return [];
    return servers.filter(
      (server) => typeof server?.name === "string"
    ).map((server) => ({
      name: server.name,
      status: typeof server.status === "string" ? server.status : ""
    }));
  }
};
var DRIVERS = [
  {
    id: "claude",
    label: "Claude",
    // The ACP adapter for Claude Code, which drives the person's own `claude` CLI and its login:
    // github.com/agentclientprotocol/claude-agent-acp. Fetched from npm on first use at the
    // version adapter/lock.json pins, never committed (TYTO-666).
    program: "claude-agent-acp",
    args: [],
    downloads: true,
    // The adapter's subscription sign-in: it runs the Claude CLI's own login (TYTO-657).
    preferredLogin: "claude-ai-login",
    serverReport: CLAUDE_SERVER_REPORT,
    authReport: CLAUDE_AUTH_REPORT
  }
];
var SETTINGS = [
  {
    id: "agent",
    form: { type: "string", enum: DRIVERS.map((driver) => driver.id) },
    default: "claude",
    description: "Which agent the panel talks to.",
    options: DRIVERS.map((driver) => ({ value: driver.id, description: driver.label }))
  },
  {
    id: "args",
    form: { type: "array", items: { type: "string", minLength: 1 } },
    default: [],
    description: "Extra arguments for the agent's program, after the ones the plugin passes. Tyto refuses an argument with a quote, %, ^, &, |, <, >, (, ) or ! in it."
  }
];
var RAW_RECORD = {
  safeParse: (value) => ({ success: true, data: value })
};
function chosenAgent(host) {
  const raw = host.config(RAW_RECORD);
  const driver = DRIVERS.find((candidate) => candidate.id === raw?.agent) ?? DRIVERS[0];
  const extra = Array.isArray(raw?.args) ? raw.args.filter((arg) => typeof arg === "string" && arg !== "") : [];
  return { driver, args: [...driver.args, ...extra] };
}

// src/history.ts
var HISTORY_LIMIT = 50;
var MESSAGE_LIMIT = 2e4;
function folderKey(folder) {
  let hash = 2166136261;
  for (const unit of new TextEncoder().encode(folder)) {
    hash ^= unit;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `history/${hash.toString(16).padStart(8, "0")}`;
}
async function loadHistory(host, folder) {
  const entry = await host.cache.get(folderKey(folder));
  if (entry === void 0) return [];
  try {
    const stored = JSON.parse(new TextDecoder().decode(entry.bytes));
    if (stored.folder !== folder || !Array.isArray(stored.messages)) return [];
    return stored.messages.filter(
      (message) => (message?.role === "user" || message?.role === "agent") && typeof message.text === "string"
    );
  } catch {
    return [];
  }
}
async function saveHistory(host, folder, messages) {
  const kept = messages.slice(-HISTORY_LIMIT).map((message) => ({ role: message.role, text: message.text.slice(0, MESSAGE_LIMIT) }));
  const stored = { folder, messages: kept };
  await host.cache.put(folderKey(folder), JSON.stringify(stored));
}

// src/conversation.ts
function loginMethodOf(initialized, preferred) {
  const methods = initialized?.authMethods;
  if (!Array.isArray(methods)) return void 0;
  const usable = methods.map((method) => method).filter(
    (method) => method.type === "terminal" && typeof method.id === "string" && Array.isArray(method.args) && method.args.every((arg) => typeof arg === "string")
  ).map((method) => ({
    id: method.id,
    name: typeof method.name === "string" ? method.name : method.id,
    args: method.args
  }));
  return usable.find((method) => method.id === preferred) ?? usable[0];
}
var READ_LIMIT = 200;
var PROTOCOL_VERSION = 1;
var CLIENT_INFO = { name: "tyto-plugin-agent", version: "0.1.0" };
function codeOf(cause) {
  const code = cause?.code;
  return typeof code === "string" ? code : void 0;
}
function messageOf(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}
function startProblem(choice, cause) {
  const { driver } = choice;
  switch (codeOf(cause)) {
    // The program is the plugin's own launcher (ADR 0184), so a missing one is a broken install,
    // never a program the person forgot to put on PATH.
    case "E_PROCESS_SCRIPT_MISSING":
    case "E_PROCESS_NOT_FOUND":
      return {
        kind: "script-missing",
        message: `The agent plugin's own program, ${driver.program}, is missing from its folder. Reinstall the plugin.`,
        steps: [],
        params: { label: driver.label, program: driver.program }
      };
    case "E_PROCESS_RESTRICTED":
      return {
        kind: "restricted",
        message: "The folder open in Tyto is restricted, and Tyto starts no program in a restricted folder. Trust the folder to talk to an agent here.",
        steps: []
      };
    case "E_PROCESS_UNAVAILABLE":
      return {
        kind: "no-programs",
        message: "This Tyto starts no programs for plugins; the agent panel works in the desktop app.",
        steps: []
      };
    default:
      return { kind: "failed", message: messageOf(cause), steps: [] };
  }
}
function loginProblem(choice, method) {
  const label = choice.driver.label;
  return method === void 0 ? {
    kind: "not-logged-in",
    message: `${label} is not signed in, and its adapter offers no sign-in Tyto can open in a terminal. Sign ${label} in yourself, then press New. Tyto never sees or stores the login.`,
    steps: [],
    params: { label },
    canLogIn: false
  } : {
    kind: "not-logged-in",
    message: `${label} is not signed in. Log in opens a Tyto terminal where ${label}'s own sign-in runs and your browser opens on its page; Tyto never sees or stores the login.`,
    steps: [],
    params: { label },
    canLogIn: true
  };
}
function adapterProblem(choice, status) {
  const label = choice.driver.label;
  if (!status.data) {
    return {
      kind: "old-tyto",
      message: `The agent panel needs Tyto 0.18 or later, which gives a plugin's program a folder to download ${label}'s adapter into. Update Tyto.`,
      steps: [],
      params: { label }
    };
  }
  if (status.claude !== "found") {
    return {
      kind: "no-claude",
      message: status.claude === "shim" ? `${label} Code was found only as an npm shim (claude.cmd), which the adapter cannot start. Install ${label} Code natively, so that claude.exe is on your PATH, then press New.` : `${label} Code is not installed: the panel talks to your own \`claude\`, and it is not on your PATH. Install ${label} Code, then press New.`,
      steps: [],
      params: { label, found: status.claude }
    };
  }
  if (!status.installed) {
    const size = megabytes(status.bytes);
    return {
      kind: "not-downloaded",
      message: `${label}'s adapter is not downloaded yet. **Download** fetches @agentclientprotocol/claude-agent-acp ${status.version} from ${status.source}, about ${size} MB on disk, into Tyto's folder for this plugin, and checks every file against the hash this plugin pins. It includes Anthropic's Claude Agent SDK, under Anthropic's own terms.`,
      steps: [],
      params: { label, version: status.version, size, source: status.source },
      canDownload: true
    };
  }
  return void 0;
}
function downloadingProblem(choice, done, total) {
  const label = choice.driver.label;
  return {
    kind: "downloading",
    message: `Downloading ${label}'s adapter: ${String(done)} of ${String(total)} packages.`,
    steps: [],
    params: { label, done: String(done), total: String(total) }
  };
}
function downloadFailedProblem(choice, outcome) {
  const label = choice.driver.label;
  return {
    kind: "download-failed",
    message: `${label}'s adapter did not download, and nothing was installed (${outcome.code}): ${outcome.message}. Press New to try again.`,
    steps: [],
    params: { label, code: outcome.code, reason: outcome.message }
  };
}
var WINDOW_SERVER = "tyto";
function toolsProblem(choice, servers) {
  const label = choice.driver.label;
  const server = servers.find((candidate) => candidate.name === WINDOW_SERVER);
  if (server === void 0) {
    return {
      kind: "no-tools",
      message: `${label} started without Tyto's tools, so it cannot see the brief in front or act on it. The likely cause is an MCP server allowlist in your Claude Code settings (often set by your organisation, as allowedMcpServers) that does not list \`tyto\`. Ask your organisation's admin to allow the MCP server \`tyto\`; Tyto does not work around that policy.`,
      steps: [],
      params: { label }
    };
  }
  if (server.status === "connected" || server.status === "pending") return void 0;
  return {
    kind: "no-tools",
    message: `${label} has Tyto's tools configured, but they did not connect (status: ${server.status || "unknown"}), so it cannot see the brief in front or act on it. Press New to start again; if it happens again, Claude Code's MCP log for \`tyto\` says why.`,
    steps: [],
    params: { label, status: server.status || "unknown" }
  };
}
var TYTO_TOOLS = {
  list_templates: "list templates",
  describe_template: "describe a template",
  check_brief: "check the brief",
  render_preview: "render a preview",
  brief_in_front: "read the brief in front",
  selection: "read the selection",
  open_file: "open a file",
  show_format: "show a format",
  propose_edit: "propose an edit",
  proposal_status: "check a proposal"
};
function toolTitle(name, title) {
  const match = /^mcp__(.+?)__(.+)$/u.exec(name);
  if (match !== null) {
    const [, server, tool] = match;
    if (server === WINDOW_SERVER) return `Tyto \xB7 ${TYTO_TOOLS[tool] ?? tool.replaceAll("_", " ")}`;
    return `${server} \xB7 ${tool}`;
  }
  return title !== "" ? title : name;
}
function tytoTool(name) {
  const match = /^mcp__(.+?)__(.+)$/u.exec(name);
  return match !== null && match[1] === WINDOW_SERVER ? match[2] : void 0;
}
function toolNameOf(update) {
  if (typeof update["name"] === "string") return update["name"];
  const meta = update["_meta"];
  const named = meta?.claudeCode?.toolName;
  return typeof named === "string" ? named : "";
}
function conversation(host) {
  const entries = [];
  let seq = 0;
  let running;
  let starting;
  let busy = false;
  let problem = null;
  let window = "unknown";
  let folder = null;
  let loginMethod;
  let downloading;
  let messages = [];
  let reply = "";
  const permissions = /* @__PURE__ */ new Map();
  const toolTitles = /* @__PURE__ */ new Map();
  const tytoTools = /* @__PURE__ */ new Map();
  const push = (entry) => {
    seq += 1;
    entries.push({ ...entry, seq });
  };
  const status = () => ({
    agent: chosenAgent(host).driver.label,
    running: running !== void 0,
    busy,
    window,
    problem,
    folder
  });
  function update(params) {
    const update2 = params?.update;
    if (update2 === void 0) return;
    const kind = update2["sessionUpdate"];
    const content = update2["content"];
    const text = content?.type === "text" && typeof content.text === "string" ? content.text : "";
    if (kind === "agent_message_chunk" && text !== "") {
      reply += text;
      push({ kind: "text", text });
    } else if (kind === "agent_thought_chunk" && text !== "") {
      push({ kind: "thought", text });
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const id = String(update2["toolCallId"] ?? "");
      const name = toolNameOf(update2);
      const named = toolTitle(name, typeof update2["title"] === "string" ? update2["title"] : "");
      if (named !== "") toolTitles.set(id, named);
      const tyto = tytoTool(name);
      if (tyto !== void 0) tytoTools.set(id, tyto);
      push({
        kind: "tool",
        id,
        title: toolTitles.get(id) ?? "",
        status: typeof update2["status"] === "string" ? update2["status"] : "",
        ...tytoTools.has(id) ? { tyto: tytoTools.get(id) } : {}
      });
    } else if (kind === "plan" && Array.isArray(update2["entries"])) {
      push({
        kind: "plan",
        entries: update2["entries"].map((item) => ({
          content: String(item.content ?? ""),
          status: String(item.status ?? "")
        }))
      });
    }
  }
  function askPermission(params) {
    const request = params;
    const options = Array.isArray(request?.options) ? request.options.filter((option) => typeof option["optionId"] === "string").map((option) => ({
      optionId: String(option["optionId"]),
      name: String(option["name"] ?? option["optionId"]),
      kind: String(option["kind"] ?? "")
    })) : [];
    const id = `p${String(seq + 1)}`;
    push({
      kind: "permission",
      id,
      title: String(request?.toolCall?.title ?? request?.toolCall?.toolCallId ?? "a tool"),
      options
    });
    return new Promise((resolve) => {
      permissions.set(id, (optionId) => {
        permissions.delete(id);
        const chosen = options.find((option) => option.optionId === optionId);
        push({
          kind: "answered",
          id,
          name: chosen?.name ?? "cancelled",
          cancelled: chosen === void 0
        });
        resolve({
          outcome: chosen === void 0 ? { outcome: "cancelled" } : { outcome: "selected", optionId: chosen.optionId }
        });
      });
    });
  }
  function cancelPermissions() {
    for (const settle of [...permissions.values()]) settle(null);
  }
  async function windowServers() {
    try {
      const server = await host.window.agentServer();
      window = "connected";
      return [server];
    } catch (cause) {
      const code = codeOf(cause);
      window = code === "E_WINDOW_AGENTS_OFF" ? "off" : "unavailable";
      if (code === "E_WINDOW_AGENTS_OFF") {
        push({
          kind: "notice",
          code: "agents-off",
          text: "Tyto does not let agents connect (setting agentsListen), so the agent cannot see the brief in front or propose edits. Turn it on and start a new conversation."
        });
      }
      return [];
    }
  }
  function download() {
    if (downloading !== void 0) return { started: false, code: "running" };
    const choice = chosenAgent(host);
    problem = downloadingProblem(choice, 0, 0);
    downloading = installAdapter(host, choice.driver.program, (done, total) => {
      problem = downloadingProblem(choice, done, total);
    }).catch((cause) => ({
      installed: false,
      code: "unknown",
      message: startProblem(choice, cause).message
    })).then((outcome) => {
      problem = outcome.installed ? null : downloadFailedProblem(choice, outcome);
    }).finally(() => {
      downloading = void 0;
    });
    return { started: true };
  }
  async function prepared(choice) {
    if (downloading !== void 0) return false;
    let found;
    try {
      found = await adapterStatus(host, choice.driver.program);
    } catch (cause) {
      problem = startProblem(choice, cause);
      return false;
    }
    if (found === void 0) {
      problem = {
        kind: "failed",
        message: "The agent plugin's launcher said nothing about the adapter.",
        steps: []
      };
      return false;
    }
    if (!found.installed && found.data && found.claude === "found" && found.previous !== null) {
      download();
      return false;
    }
    const standing = adapterProblem(choice, found);
    if (standing !== void 0) {
      problem = standing;
      return false;
    }
    return true;
  }
  async function start() {
    const choice = chosenAgent(host);
    if (choice.driver.downloads && !await prepared(choice)) return void 0;
    let program;
    try {
      program = await host.process.start(choice.driver.program, choice.args);
    } catch (cause) {
      problem = startProblem(choice, cause);
      return void 0;
    }
    folder = program.cwd;
    let stderr = "";
    program.onStderr((bytes) => {
      stderr = (stderr + new TextDecoder().decode(bytes)).slice(-4e3);
    });
    const connection = connect(program, {
      onProblem: (text) => host.log.warn(text)
    });
    connection.handle("session/update", update);
    connection.handle("session/request_permission", askPermission);
    let signedOut = false;
    const auth = choice.driver.authReport;
    if (auth !== void 0) {
      connection.handle(auth.notification, (params) => {
        const said = auth.signedOut(params);
        if (said === void 0) return;
        signedOut = said;
        if (said) problem = loginProblem(choice, loginMethod);
        else if (problem?.kind === "not-logged-in") problem = null;
      });
    }
    const report = choice.driver.serverReport;
    if (report !== void 0) {
      connection.handle(report.notification, (params) => {
        const servers = report.servers(params);
        if (servers === void 0 || window === "off" || window === "unavailable") return;
        const missing = toolsProblem(choice, servers);
        if (missing !== void 0) {
          problem = missing;
          window = "missing";
        } else if (problem?.kind === "no-tools") {
          problem = null;
          window = "connected";
        }
      });
    }
    void program.exited.then((exit) => {
      connection.close("the agent ended");
      cancelPermissions();
      if (running?.program === program) {
        running = void 0;
        busy = false;
        const code = String(exit.code ?? exit.signal);
        push({
          kind: "notice",
          code: "ended",
          params: { exit: code },
          text: `The agent ended (exit ${code}). Your next message starts it again.`
        });
        if (stderr.trim() !== "") host.log.info(`agent stderr: ${stderr.trim()}`);
      }
    });
    try {
      const initialized = await connection.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          auth: { terminal: true }
        },
        clientInfo: CLIENT_INFO
      });
      loginMethod = loginMethodOf(initialized, choice.driver.preferredLogin);
      const created = await connection.request("session/new", {
        cwd: program.cwd,
        mcpServers: await windowServers(),
        ...report === void 0 ? {} : { _meta: report.sessionMeta }
      });
      if (typeof created?.sessionId !== "string")
        throw new Error("session/new answered no sessionId");
      problem = signedOut ? loginProblem(choice, loginMethod) : null;
      messages = [...await loadHistory(host, program.cwd).catch(() => [])];
      return { program, connection, sessionId: created.sessionId, choice };
    } catch (cause) {
      problem = cause instanceof RpcError && cause.code === AUTH_REQUIRED ? loginProblem(choice, loginMethod) : { kind: "failed", message: messageOf(cause), steps: [] };
      await program.kill();
      return void 0;
    }
  }
  async function ensure() {
    if (running !== void 0) return running;
    starting ??= start().finally(() => {
      starting = void 0;
    });
    running = await starting;
    return running;
  }
  async function turn(text) {
    reply = "";
    try {
      const agent = await ensure();
      if (agent === void 0) {
        if (problem === null)
          push({ kind: "notice", code: "not-started", text: "The agent did not start." });
        return;
      }
      const answer = await agent.connection.request("session/prompt", {
        sessionId: agent.sessionId,
        prompt: [{ type: "text", text }]
      });
      push({ kind: "end", reason: String(answer?.stopReason ?? "end_turn") });
    } catch (cause) {
      if (cause instanceof RpcError && cause.code === AUTH_REQUIRED) {
        problem = loginProblem(chosenAgent(host), loginMethod);
      } else {
        const said = messageOf(cause);
        push({
          kind: "notice",
          code: "turn-failed",
          params: { message: said },
          text: `The turn failed: ${said}`
        });
      }
    } finally {
      busy = false;
      if (folder !== null && reply !== "") {
        messages.push({ role: "user", text }, { role: "agent", text: reply });
        await saveHistory(host, folder, messages).catch(
          (cause) => host.log.warn(`the conversation was not saved: ${messageOf(cause)}`)
        );
      }
    }
  }
  return {
    async open() {
      if (problem?.kind === "not-logged-in" && running !== void 0) {
        const ending = running;
        running = void 0;
        await ending.program.kill();
      }
      await ensure();
      return { ...status(), history: messages };
    },
    send(text) {
      if (busy) {
        return {
          accepted: false,
          code: "busy",
          reason: "A turn is running; wait for it or stop it."
        };
      }
      if (text.trim() === "") {
        return { accepted: false, code: "empty", reason: "The message is empty." };
      }
      busy = true;
      push({ kind: "user", text });
      void turn(text);
      return { accepted: true };
    },
    read(after) {
      const next = entries.filter((entry) => entry.seq > after).slice(0, READ_LIMIT);
      return { entries: next, status: status() };
    },
    answer(permission, optionId) {
      const settle = permissions.get(permission);
      if (settle === void 0) return { answered: false };
      settle(optionId);
      return { answered: true };
    },
    async cancel() {
      cancelPermissions();
      if (running !== void 0 && busy) {
        await running.connection.notify("session/cancel", { sessionId: running.sessionId });
      }
    },
    async reset() {
      cancelPermissions();
      const ending = running;
      running = void 0;
      busy = false;
      entries.length = 0;
      toolTitles.clear();
      tytoTools.clear();
      messages = [];
      problem = null;
      window = "unknown";
      if (ending !== void 0) await ending.program.kill();
    },
    download,
    async login() {
      const method = loginMethod;
      if (method === void 0) return { opened: false, code: "no-method" };
      const choice = chosenAgent(host);
      try {
        await host.terminal.open(choice.driver.program, [...choice.args, ...method.args]);
        return { opened: true };
      } catch (cause) {
        switch (codeOf(cause)) {
          case "E_TERMINAL_LIMIT":
            return { opened: false, code: "already-open" };
          case "E_PROCESS_RESTRICTED":
            return { opened: false, code: "restricted" };
          case "E_TERMINAL_UNAVAILABLE":
            return { opened: false, code: "no-terminal" };
          default:
            return { opened: false, code: "failed", reason: messageOf(cause) };
        }
      }
    },
    status
  };
}

// src/index.ts
var ok = (value) => ({ ok: true, value, diagnostics: [] });
function numberOf(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function stringOf(value) {
  return typeof value === "string" ? value : "";
}
function activate(host) {
  const chat = conversation(host);
  const registered = [
    ...SETTINGS.map((setting) => host.registerConfiguration(setting)),
    host.registerPanel({
      id: "agent",
      title: "Agent",
      location: "right",
      entry: "panel/index.html",
      async call({ method, params }) {
        const given = params ?? {};
        switch (method) {
          case "open":
            return ok(await chat.open());
          case "send":
            return ok(chat.send(stringOf(given["text"])));
          case "read":
            return ok(chat.read(numberOf(given["after"])));
          case "answer":
            return ok(
              chat.answer(
                stringOf(given["id"]),
                typeof given["optionId"] === "string" ? given["optionId"] : null
              )
            );
          case "cancel":
            await chat.cancel();
            return ok(chat.status());
          case "reset":
            await chat.reset();
            return ok(chat.status());
          case "login":
            return ok(await chat.login());
          case "download":
            return ok(chat.download());
          default:
            return ok({ unknown: method });
        }
      }
    })
  ];
  return {
    dispose() {
      void chat.reset();
      for (const registration of registered) registration.dispose();
    }
  };
}
export {
  activate
};
