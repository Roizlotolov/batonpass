# batonpass

**Automatic session handoff for coding agents.** Long agent sessions degrade: context
fills up, built-in auto-compaction is lossy and tool-specific, and people end up
manually writing "handoff notes" and restarting sessions by hand. Batonpass automates
the whole loop for [Claude Code](https://code.claude.com) and [Codex CLI](https://developers.openai.com/codex):

1. Watches context usage of a running agent session.
2. At a threshold (default 75%), has **the agent itself** write a structured
   handoff document — agent-written beats external summarization, since the
   agent knows what actually matters.
3. Kills the old session and spawns a fresh one with the handoff injected as
   initial context.
4. Repeats indefinitely — chained handoffs, zero manual intervention.

Unlike built-in compaction, Batonpass produces a lossless, structured, cross-tool
handoff format with a full history on disk (`.batonpass/handoffs/`), and works the
same way whether you're driving Claude Code or Codex.

## Status

Early development (v0.1, unreleased). Package names: `batonpass` (the
published CLI, binary name `batonpass`) and the `@batonpass/*` scope for the
internal packages. See [PLAN.md](./PLAN.md) for the full implementation plan
and a running progress log, and [docs/testing.md](./docs/testing.md) for what
has and hasn't been verified against real agent CLIs yet.

**Not yet published to npm** — this repo has not been through a real release;
see "Release status" below before relying on it for anything important.

## Quickstart (once published)

```sh
npm i -g batonpass
batonpass init            # installs hooks + statusline for Claude Code in this project
batonpass run claude       # spawns `claude` under Batonpass's orchestrator
```

Use `--agent codex` for Codex CLI instead, or `--agent all` to set up both.
Use `--user` instead of the default project scope to install once for every
project on your machine.

## How it works

```
┌─────────────────────────────────────────────────────────┐
│ batonpass CLI (wrapper, node-pty)                            │
│  • spawns agent CLI in a PTY, proxies stdin/stdout        │
│  • watches context usage (statusline file / rollout JSONL)│
│  • at threshold + turn-idle: injects the handoff prompt   │
│  • waits for a validated artifact → kills → respawns      │
└───────────────┬─────────────────────────────────────────┘
                │ reads/writes
        ┌───────▼────────┐        ┌──────────────────────┐
        │ .batonpass/ state  │◄───────┤ hooks (per adapter)   │
        │  state.json    │        │  SessionStart: inject │
        │  handoffs/*.md │        │  Stop: idle signal     │
        │  usage.json    │        │  (Claude: PreCompact   │
        └────────────────┘        │   also blocks auto-    │
                                   │   compaction)          │
                                   └──────────────────────┘
```

Batonpass never kills a session without a validated handoff artifact already on
disk. If the agent writes an invalid handoff, Batonpass retries once with a
corrective prompt; if that still fails, it falls back to leaving the session
running and prints instructions instead of destroying in-flight work.

## Commands

| Command | What it does |
|---|---|
| `batonpass run <claude\|codex>` | The orchestrator: spawns the agent CLI and manages the full handoff lifecycle. |
| `batonpass init [--agent claude\|codex\|all] [--project\|--user] [--uninstall]` | Install (or remove) hooks/statusline for an agent. |
| `batonpass status` | Current orchestrator/session state for this project. |
| `batonpass handoffs [show <seq>]` | List handoffs, or print one. |
| `batonpass doctor` | Check agent binaries, hook installation, and known platform caveats. |

## Packages (monorepo)

- `packages/core` (`@batonpass/core`) — handoff schema/validation, `.batonpass/`
  state management, prompt templates, usage parsers for both tools.
- `packages/adapter-claude-code` (`@batonpass/adapter-claude-code`) —
  Claude Code plugin + hook scripts + install logic.
- `packages/adapter-codex` (`@batonpass/adapter-codex`) — Codex hooks +
  install logic.
- `packages/cli` (`batonpass`, bin `batonpass`) — the orchestrator + CLI.
- `examples/fake-agent` — a deterministic stand-in CLI used for e2e-testing
  the orchestrator without a real agent installed.

## Docs

- [docs/spec.md](./docs/spec.md) — the handoff artifact format (versioned
  separately from the CLI; this is the part other tools should be able to
  adopt).
- [docs/adapters.md](./docs/adapters.md) — how to write a new adapter (e.g.
  for OpenClaw, Hermes, OpenCode — contributions welcome).
- [docs/testing.md](./docs/testing.md) — what's automated vs. what still
  needs manual verification against real `claude`/`codex` CLIs before a
  release.
- [CONTRIBUTING.md](./CONTRIBUTING.md) — dev setup, changesets workflow.

## Development

```sh
pnpm install
pnpm build
pnpm test
pnpm lint
```

## License

MIT
