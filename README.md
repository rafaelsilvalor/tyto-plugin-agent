# tyto-plugin-agent

A [Tyto](https://github.com/rafaelsilvalor/tyto) plugin: a panel in the desktop window where you
chat with an agent CLI over the [Agent Client Protocol](https://agentclientprotocol.com). The
agent sees the brief in front of you through Tyto's window tools, and the edits it wants arrive
as proposals you approve. This repository is public and unlicensed.

Tyto knows no provider (Tyto ADR 0011, ADR 0127): everything agent-specific lives here, in its
own repository, and reaches Tyto only through the plugin API.

**Work in progress.** This commit sets up the repository; the panel arrives in its first pull
request.
