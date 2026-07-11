# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a security concern.

Use GitHub's private reporting instead: go to the
[Security tab](https://github.com/Roizlotolov/batonpass/security) of this
repository → **Report a vulnerability**. This opens a private advisory
visible only to the maintainer until a fix is ready.

## Scope

Batonpass spawns coding-agent CLIs inside a PTY, injects text into their
stdin, installs hook scripts into their config (Claude Code
`settings.json`/plugins, Codex `config.toml`), and reads/writes state under
`.batonpass/` in the project directory. Relevant security concerns include:

- **Prompt/stdin injection** — anything that lets untrusted content (e.g. a
  tampered handoff file in a cloned repo) inject unintended text into a
  running agent session beyond the documented handoff-injection behavior
- **Path traversal** — `.batonpass/state.json.pendingHandoff` is used to
  construct filesystem paths; directory names are strictly validated
  (`^\d+-[A-Za-z0-9_-]+$`) and a traversal-rejection test exists — anything
  that gets around that validation is in scope
- **Hook install/uninstall safety** — anything that could clobber or corrupt
  a user's existing agent configuration beyond the documented, backed-up
  merge behavior
- **Injection via config values** into a shell command or spawned process's
  arguments/environment

Note that a handoff document intentionally contains a summary of your coding
session (objectives, decisions, file paths) and is written **in plaintext to
`.batonpass/` inside the project**. If your project directory is shared or
committed, treat handoffs like any other local notes — `.batonpass/` should
generally be gitignored.

Out of scope: vulnerabilities in the agent CLIs themselves (Claude Code,
Codex CLI) — please report those upstream to Anthropic/OpenAI.

## Supported versions

This project has not yet reached a `1.0` release. Fixes land on `main`; there
is no separate maintenance branch yet.
