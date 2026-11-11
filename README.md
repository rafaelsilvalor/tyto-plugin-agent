# tyto-plugin-agent

A [Tyto](https://github.com/rafaelsilvalor/tyto) plugin: a panel in the desktop window where you
chat with an agent CLI over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP).
The agent sees the brief in front of you through Tyto's window tools, and the edits it wants
arrive as proposals you approve or reject. This repository is public and unlicensed.

Tyto knows no provider (Tyto ADR 0011, ADR 0127): everything agent-specific lives here, in its
own repository, and reaches Tyto only through the plugin API.

**0.1.0 talks to Claude only**, two ways: through Claude Code's ACP adapter, with your
subscription, or through the Claude API with your own API key and agents you configure (below).
Other agents that speak ACP (Codex through `codex-acp`, Gemini CLI through `gemini --acp`) are
one row each in `src/drivers.ts` and one more program to approve; they are not shipped or tested
yet.

## The API agents: your key, your agents, a monthly cap

Set `agent.agent` to `"claude-api"` and the panel talks to the Claude API directly, with **your
own API key**: the route Anthropic's terms name for products built on Claude. No program runs,
no MCP server is involved (so an organisation's MCP allowlist for Claude Code does not apply),
and the agent gets Tyto's tools and nothing else. It needs Tyto 0.20 or later.

- **The key stays in Tyto's keychain.** The panel asks for it once; the page stores it straight
  into Tyto's keychain (`credentials:anthropic-api-key`, Tyto ADR 0134) and empties the field.
  The plugin never holds it: each request asks Tyto to add it to the `x-api-key` header, and Tyto
  does so only for `api.anthropic.com` (Tyto ADR 0191). It is never in `settings.json`, a process
  environment, a log or the screen.
- **Usage is billed per token to the key's owner**, separately from any Claude subscription.
- **Agents are configuration**: each line of `agent.apiAgents` is
  `Name | model | effort | tools | instructions`. The panel shows a picker when there are two or
  more; switching starts a fresh conversation. It ships two to start from: _Modelador_ on Claude
  Haiku 5.5, which writes briefs, and _Revisor_ on Claude Opus 5.5, which checks them.
- **Tools are the window's, in process** (`host.window.tools()` and `callTool()`, Tyto ADR 0190),
  under the same trust as an agent connected to the window; an edit is a proposal you accept or
  reject. An agent gets only the tools its line names.
- **Each call shows its tokens and an estimated cost**, from the price table in
  `src/api/prices.ts`, dated (read on 2026-11-03) and pointing at
  <https://platform.claude.com/docs/en/about-claude/pricing>. Anthropic's invoice is the bill.
- **A monthly cap**, `agent.apiMonthlyCapUsd` (US$10 unless you set it), counted in UTC months in
  Tyto's durable plugin records (Tyto ADR 0191). A turn stops before the next call once the month
  reaches it, and no new turn starts. Removing the plugin deletes the record, and with it the
  month's count.
- **Prompt caching** on the stable start of every request (the agent's tools and instructions)
  and on the conversation so far; the cost line shows `cached` and `written` tokens, from the
  API's `usage.cache_read_input_tokens` and `usage.cache_creation_input_tokens`.
- **Anthropic's TypeScript SDK** (`@anthropic-ai/sdk` 1.7.0, Apache-2.0) is bundled, minified,
  as `dist/vendor/anthropic-sdk.js`, with its licence beside it
  (`dist/vendor/anthropic-sdk.LICENSE.txt`, and the MIT notice for earlier versions in
  `anthropic-sdk.LICENSE-MIT.txt`). The panel loads it only when the API driver runs.

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

1. **Tyto desktop with the plugin contract 0.18 or newer** (`engine: ">=0.18"`): it runs the
   plugin's own launcher on Tyto's Node (Tyto ADR 0184) and gives it a data folder (ADR 0187).
   An older Tyto refuses the plugin at start and says which contract it needs.
2. **Claude Code, installed natively**, so that `claude` (on Windows `claude.exe`) is on your
   `PATH`. You do not have to sign in first: the panel offers **Log in** (below). An npm-only
   install (`claude.cmd`) is refused with a message: the adapter cannot start a `.cmd`.

Nothing else. **The ACP adapter is downloaded the first time you open the panel, as Zed does**,
and only once you press **Download**. The panel first says what it fetches and from where:
[`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp)
at the version this plugin pins (0.104.1 today), with its 107 npm packages, about 54 MB on disk,
from `registry.npmjs.org`. They go into Tyto's data folder for this plugin
(`~/.tyto/data/plugins/agent/`), never into this repository. Every package is checked against the
sha512 hash `adapter/lock.json` records, and an install that fails leaves nothing behind. The
SDK's own Claude binary (331 MB) is never downloaded: the adapter runs your `claude`.

**Licences.** The adapter is Apache-2.0. One of its dependencies,
`@anthropic-ai/claude-agent-sdk`, is not open source: it is Anthropic's, under
[Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance). That is why this
repository holds none of it (a test fails on any SDK file or licence text tracked), and why you
download it yourself from npm.

**Updates.** Each release of this plugin pins one adapter version. When a new release pins a
newer one, the panel downloads it the next time it opens, without asking again, and removes the
old copy. An adapter you installed yourself with `npm i -g` is not used: the plugin always runs
its own copy.

The panel's check that Claude has Tyto's tools reads the adapter's own extension (it forwards
Claude Code's startup message as `_claude/sdkMessage`); a version without it leaves the panel
unable to tell, and then it says nothing.

Then install the plugin straight from this repository:

```
tyto plugin install git+https://github.com/rafaelsilvalor/tyto-plugin-agent.git
```

or from the gallery, when the gallery you read lists it. Tyto copies the folder and never builds
it, so `dist/index.js` is committed. The install shows the permission below and asks for your
approval.

### What it may reach

| Permission                      | Why                                                                                                                                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `process:claude-agent-acp`      | Run the plugin's own launcher (`adapter/launch.mjs`) on Tyto's Node, in the folder open in Tyto: it downloads the adapter when you accept, then runs it and talks to it on stdio; open a Terminal tab running its sign-in. |
| `net:api.anthropic.com`         | The API agents' requests to the Claude API, through Tyto's network.                                                                                                                                                        |
| `credentials:anthropic-api-key` | Your API key, which the panel stores in Tyto's keychain and Tyto adds to each request to `api.anthropic.com`; the plugin never reads it.                                                                                   |
| `window:tools`                  | The API agents use Tyto's tools in the open window: read what is open there and propose edits you accept or reject, while Tyto lets agents connect (`agentsListen`).                                                       |

The launcher is this plugin's own code, so the install box says it is not confined: its own
downloads reach only `registry.npmjs.org`, for the files the lock pins, and it writes them only
into the plugin's data folder. The adapter it then runs drives Claude Code, which reaches
Anthropic as it does in a terminal. Tyto starts that one program and nothing else, never while the folder is restricted, and ends it
when you open another folder, change the folder's trust, or close the window. The program runs
with your rights. It can also reach the Tyto window as an agent while Tyto lets agents connect
(setting `agentsListen`): it reads what is open there, and its edits arrive as proposals.

## Use

Open the panel from the command bar (**Agent**). The first time it opens it starts the adapter in
the folder open in Tyto, and the panel says what it found:

| What the panel says                       | What to do                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| the adapter is not downloaded yet         | read what it fetches, then press **Download**; the panel starts Claude once it is in            |
| Claude Code is not installed              | install Claude Code natively, then press **New**                                                |
| the download failed                       | nothing was installed; press **New** to try again                                               |
| Claude is not signed in                   | press **Log in to Claude** (below); press **Try again** if the panel has not noticed            |
| the folder is restricted                  | trust the folder; Tyto starts no program in a restricted one                                    |
| `window off (agentsListen)` in the header | the agent chats but cannot see the brief or propose edits; turn `agentsListen` on, then **New** |
| `no Tyto tools` in the header             | see [Claude without Tyto's tools](#claude-without-tytos-tools); Tyto cannot fix it              |

### Signing in

When Claude is not signed in, the panel says so as soon as it opens (the adapter reports it) or
on the first message, and shows **Log in to Claude**. The button opens a tab in Tyto's Terminal,
in the open folder, running the adapter with the sign-in arguments the adapter itself lists in
ACP's `initialize` (`authMethods` of type `terminal`; with 0.102.0,
`--cli auth login --claudeai`, which runs the Claude CLI's own login). Your browser opens on
Claude's sign-in page; you finish there, and the terminal ends. Come back to the panel and it
tries again by itself; **Try again** does the same. The plugin never sees what the terminal shows
or what you type, and Tyto never reads or stores the login. An adapter that lists no terminal
sign-in gets no button: the panel says so, and you sign Claude in yourself.

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

| Setting                  | Default    | Meaning                                                                                                                                                                                                                                                                        |
| ------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent.agent`            | `"claude"` | Which agent the panel talks to: `claude` (Claude Code, your subscription) or `claude-api` (your API key).                                                                                                                                                                      |
| `agent.args`             | `[]`       | Extra arguments for the adapter. Tyto refuses one holding `" % ^ & \| < > ( ) !`.                                                                                                                                                                                              |
| `agent.apiAgents`        | two agents | The API agents, one per line: `Name \| model \| effort \| tools \| instructions`. Effort is `low`, `medium`, `high`, `xhigh` or `max`; tools is a comma-separated list, `*` for all, `-` for none. A line on a model the price table lacks is left out, and the panel says so. |
| `agent.apiMonthlyCapUsd` | `10`       | The most the API agents may spend in a calendar month (UTC), in US dollars, as estimated.                                                                                                                                                                                      |

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
- **The launcher.** `src/launcher/` builds to `adapter/launch.mjs`, the program the manifest's
  `programs` maps `claude-agent-acp` to (Tyto ADR 0184). `--tyto-status` says what is installed
  in `TYTO_PROGRAM_DATA` (ADR 0187) and whether `claude` is on `PATH`; `--tyto-install` fetches
  every package `adapter/lock.json` lists, checks its sha512, unpacks it with a tar reader that
  refuses links, absolute paths and `..`, and renames the finished folder into place. Any other
  arguments run the adapter with `CLAUDE_CODE_EXECUTABLE` set to your `claude`. The plugin's
  own process only reads the launcher's JSON lines: it downloads nothing (ADR 0049).
- **A new pin.** `node scripts/lock-adapter.mjs <version>` installs that version with npm in a
  temporary folder (no optional packages, no install scripts) and rewrites `adapter/lock.json`
  with each package's path, version, address and sha512, and the size on disk.
- **Drivers.** `src/drivers.ts` names each agent: its program, its arguments, which of its terminal sign-ins it prefers, how it reports being
  signed out (Claude: `_auth/status_update`, read for its kind only), and how it reports the
  session's MCP servers, when it can (Claude: `_meta.claudeCode.emitRawSDKMessages` in
  `session/new`, then Claude Code's `system`/`init` message as `_claude/sdkMessage` on the first
  turn).
- **Sign-in through the host's terminal.** `host.terminal.open` (Tyto ADR 0184) runs the
  driver's program with the agent's own sign-in arguments in a Tyto terminal tab; the plugin
  learns only that it opened, one at a time.
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
`dist/` or `adapter/launch.mjs` differs from a fresh build of `src/`, and `tests/no-sdk.test.ts`
fails on any tracked SDK file. `src/launcher/launcher.test.ts` installs from tarballs built in
the test, on a temp disk; the registry is never reached. `tests/panel-theme.test.ts` renders the panel page
in both themes and measures its contrast on pixels, in the system Chrome through `playwright-core`
(no browser is downloaded; GitHub's Ubuntu runners carry Chrome). The `contract` workflow moves this repository onto
each new contract (Tyto ADR 0154).
