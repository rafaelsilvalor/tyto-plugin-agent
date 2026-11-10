# tyto-plugin-agent

A [Tyto](https://github.com/rafaelsilvalor/tyto) plugin: a panel in the desktop window where you
chat with an agent CLI over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP).
The agent sees the brief in front of you through Tyto's window tools, and the edits it wants
arrive as proposals you approve or reject. This repository is public and unlicensed.

Tyto knows no provider (Tyto ADR 0011, ADR 0127): everything agent-specific lives here, in its
own repository, and reaches Tyto only through the plugin API.

**0.1.0 talks to Claude only**, through Claude Code's ACP adapter. Other agents that speak ACP
(Codex through `codex-acp`, Gemini CLI through `gemini --acp`) are one row each in
`src/drivers.ts` and one more program to approve; they are not shipped or tested yet.

## Your login, your plan

- **Each person uses their own `claude` login.** The adapter drives the Claude Code CLI on your
  computer, signed in the way you signed it in. Tyto never sees the login, stores no credential
  for this plugin, and passes no API key or token to the program it starts (Tyto ADR 0182).
- **Usage draws from your own plan's limits**, as Claude Code in a terminal does. Anthropic's
  help centre says that with a plan login, the Agent SDK, `claude -p` and third-party apps
  "still draw from your subscription limits", and that the change announced for 15 June 2026
  was paused: <https://support.claude.com/en/articles/15036540>, read on 9 November 2026. Check
  that page for the current terms; they are Anthropic's, not this plugin's.
- Nothing you type goes anywhere but to the agent program on your computer. The plugin keeps the
  conversation per folder in Tyto's private plugin cache, outside every workspace, and nothing
  else.

## Install

You need, on the computer that runs Tyto:

1. **Tyto desktop 0.17.0 or newer** (it carries the plugin contract 0.16 this plugin asks for).
2. **Claude Code**, signed in once: run `claude`, then `/login`.
3. **The ACP adapter for Claude Code** (Apache-2.0,
   [agentclientprotocol/claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)):

   ```
   npm install -g @agentclientprotocol/claude-agent-acp
   ```

   **Tested with `@agentclientprotocol/claude-agent-acp` 0.102.0** (Claude Code 2.1.321). The
   panel's check that Claude has Tyto's tools reads that adapter's own extension (it forwards
   Claude Code's startup message as `_claude/sdkMessage`); a version without it leaves the
   panel unable to tell, and then it says nothing.

Then install the plugin straight from this repository:

```
tyto plugin install git+https://github.com/rafaelsilvalor/tyto-plugin-agent.git
```

or from the gallery, when the gallery you read lists it. Tyto copies the folder and never builds
it, so `dist/index.js` is committed. The install shows the permission below and asks for your
approval.

### What it may reach

| Permission                 | Why                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `process:claude-agent-acp` | Start the adapter from your `PATH`, in the folder open in Tyto, and talk to it on stdio. |

Tyto starts that one program and nothing else, never while the folder is restricted, and ends it
when you open another folder, change the folder's trust, or close the window. The program runs
with your rights. It can also reach the Tyto window as an agent while Tyto lets agents connect
(setting `agentsListen`): it reads what is open there, and its edits arrive as proposals.

## Use

Open the panel from the command bar (**Agent**). The first time it opens it starts the adapter in
the folder open in Tyto, and the panel says what it found:

| What the panel says                       | What to do                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| the adapter is not on your `PATH`         | install it (above), then press **New**                                                          |
| Claude is not signed in                   | open a terminal in Tyto, run `claude`, then `/login`, then press **New**                        |
| the folder is restricted                  | trust the folder; Tyto starts no program in a restricted one                                    |
| `window off (agentsListen)` in the header | the agent chats but cannot see the brief or propose edits; turn `agentsListen` on, then **New** |
| `no Tyto tools` in the header             | see [Claude without Tyto's tools](#claude-without-tytos-tools); Tyto cannot fix it              |

### Claude without Tyto's tools

On the first message, the panel reads which MCP servers Claude Code started for the session. If
the window's server, `tyto`, is not among them, Claude chats but cannot see the brief, and the
panel says so. The usual cause is a Claude Code setting that allows only listed MCP servers
(`allowedMcpServers`), often one your organisation manages: Claude Code then drops any other
server without a message, in the terminal too. Ask your organisation's admin to allow the MCP
server `tyto`. Tyto does not work around that policy. If `tyto` is listed but did not connect,
the panel names its status, and Claude Code's MCP log for `tyto` says why.

Type a message and press **Enter** to send it; Shift+Enter adds a line, and Ctrl+Enter also
sends. The agent's replies render their markdown
(bold, lists, code and diff blocks); a link shows its address and is not followed. Tool calls
show as small lines with the tool's name (Tyto's own as `Tyto · <what it does>`), and the
agent's plan the same way; a permission the agent asks for shows its options as buttons.
While a turn runs, a line above the input says what the agent is doing ("thinking…", "using
Tyto · check the brief…", "waiting for your answer…"), and **Stop** takes Send's place: it
cancels the running turn. The input stays editable for your next message, which Enter sends
once the turn ends; nothing is queued. **New** ends the agent and starts a fresh conversation.
The messages of earlier conversations in the same folder show above the first one, greyed.

A chip above the input says what is in front in Tyto: the brief's name, its template and the
format the preview shows (`mca-67256 · news-da-semana · grid`), or "no brief in front". When the
agent has no Tyto tools, or agents are off in Tyto, the chip says that too. The name and the
format come from Tyto 0.18 and later; an older Tyto sends only the text, and the chip names the
template it reads there.

The panel speaks English and Brazilian Portuguese and follows Tyto's language, as the rest of the
window does, from Tyto 0.18. With an older Tyto it takes the browser's language, which is the
operating system's, not Tyto's setting.

### Settings

In `settings.json`:

| Setting       | Default    | Meaning                                                                           |
| ------------- | ---------- | --------------------------------------------------------------------------------- |
| `agent.agent` | `"claude"` | Which agent the panel talks to. Only `claude` in 0.1.0.                           |
| `agent.args`  | `[]`       | Extra arguments for the adapter. Tyto refuses one holding `" % ^ & \| < > ( ) !`. |

## How it works

- **ACP over the host's process service.** `src/acp/connection.ts` is a small JSON-RPC client
  over newline-delimited JSON, with no dependency. It sends `initialize`, `session/new` with the
  folder Tyto reports (`PluginProcess.cwd`) and the window's MCP server
  (`host.window.agentServer()`, Tyto ADR 0183), `session/prompt` and `session/cancel`. It
  answers `session/request_permission` with the person's choice, and reads `session/update`.
- **The panel asks; nothing is pushed.** A panel cannot receive pushes from its plugin (Tyto ADR
  0173 decision 8), so a turn is started with one `call` and read with the next ones:
  `read {after}` answers the entries after the last one the page has, four times a second while
  a turn runs.
- **Drivers.** `src/drivers.ts` names each agent: its program, its arguments, the steps the
  panel shows to install it and sign in, and how it reports the session's MCP servers, when it
  can (Claude: `_meta.claudeCode.emitRawSDKMessages` in `session/new`, then Claude Code's
  `system`/`init` message as `_claude/sdkMessage` on the first turn).
- **Markdown without HTML.** `panel/panel.js` builds every node with `createElement` and
  `textContent`, never `innerHTML`, so nothing an agent writes becomes markup.

## Develop

The contract, `@tyto/plugin-api`, is read from GitHub Packages under `@rafaelsilvalor` (Tyto ADR
0149). Put a token with `read:packages` in your user-level `~/.npmrc`, or pass it once:

```
pnpm install "--//npm.pkg.github.com/:_authToken=$(gh auth token)"
pnpm build
pnpm check
```

The tests run the committed bundle through Tyto's own harness (`testPlugin`, Tyto ADR 0150), with
a fake ACP agent behind the host's process port (`tests/fake-agent.ts`). CI fails when
`dist/` differs from a fresh build of `src/`. `tests/panel-theme.test.ts` renders the panel page
in both themes and measures its contrast on pixels, in the system Chrome through `playwright-core`
(no browser is downloaded; GitHub's Ubuntu runners carry Chrome). The `contract` workflow moves this repository onto
each new contract (Tyto ADR 0154).
