# Writing a Batonpass adapter

Batonpass's orchestrator (`packages/cli/src/orchestrator.ts`) doesn't know anything
about a specific coding-agent CLI — it only calls methods on an `Adapter`
(defined in `packages/core/src/adapter.ts`). Three adapters exist today
(Claude Code, Codex CLI, Hermes Agent); contributions for OpenClaw, OpenCode,
or anything else with a hookable (or at least scriptable) session lifecycle
are welcome.

## The interface

```ts
interface Adapter {
  id: ToolId;
  detectInstalled(): Promise<boolean>;
  install(scope: 'user' | 'project', cwd: string): Promise<{ backedUpFiles: string[] }>;
  uninstall(scope: 'user' | 'project', cwd: string): Promise<void>;
  isInstalled(scope: 'user' | 'project', cwd: string): Promise<boolean>;
  spawnCommand(opts: { cwd: string }): { cmd: string; args: string[]; env?: Record<string, string> };
  usageSource(session: SessionRef): UsageSource;
  isTurnIdle(session: SessionRef): Promise<boolean>;
  injectHandoffPrompt(pty: PtyLike, artifactPath: string): Promise<void>;
  resumeInjection(): 'session-start-hook' | 'pty-type';
  gracefulExitKeys(): string;
}
```

### What each method must do

- **`detectInstalled`** — is the underlying CLI binary on `PATH`? Used by
  `batonpass doctor`. Should never throw; return `false` on any error.
- **`install` / `uninstall` / `isInstalled`** — write (or remove) whatever
  hook/config wiring your tool needs. Must be:
  - **Idempotent** — calling `install` twice must not duplicate entries.
  - **Non-destructive** — always back up a config file before editing it
    (return every backup path in `backedUpFiles`), and never touch config keys
    unrelated to Batonpass.
  - **Scope-aware** — `'user'` installs once for the whole machine, `'project'`
    installs only for the current repo. Both existing adapters use a
    `<hooks-root>/batonpass/…` install directory plus a marker (script filename)
    embedded in the installed command string, so `isInstalled`/`uninstall` can
    find *only* Batonpass's own entries without needing extra state.
- **`spawnCommand`** — the literal command/args the orchestrator should run in
  a PTY. Keep this as simple as possible (ideally the bare CLI with no flags)
  — resume content should be delivered via `resumeInjection`, not a CLI flag,
  so the design doesn't depend on how a specific `<cli> "<prompt>"` invocation
  behaves on a given version.
- **`usageSource`** — return a `UsageSource` (`{ getUsage(): Promise<Usage | null> }`)
  that reports `{ pct, tokens, max, source }` for the given session. Prefer a
  push-based primary source (e.g. a hook-written file) with a pull-based
  fallback (parsing a transcript/log) — see `ClaudeUsageSource` for the
  pattern. **Never load an entire transcript file into memory** — see
  `packages/core/src/usage/tail.ts` (`readTailUntil`) for the bounded-tail
  approach both existing usage sources use.
- **`isTurnIdle`** — return whether the session has been idle *since*
  `session.sinceMs` (not just "ever idle" — a stale marker from a previous
  turn must not count). Both adapters implement this via a hook-written
  `.batonpass/turn-idle` marker file with a timestamp.
- **`injectHandoffPrompt`** — type `handoffPrompt(artifactPath)` (from
  `@batonpass/core`) into the PTY as if the user had, plus whatever
  submits it (usually `\r`). Do not build your own prompt text here — use the
  shared template so the handoff format stays consistent across tools.
- **`resumeInjection`** — two strategies exist:
  - **`'session-start-hook'`** (Claude Code, Codex): the orchestrator sets
    `state.json.pendingHandoff` before killing the old session, and your
    adapter's session-start-equivalent hook reads it, injects the handoff
    content as additional context, and clears the field.
  - **`'pty-type'`** (Hermes): for a CLI with no context-injection hook at
    all, the orchestrator itself types a single-line resume instruction
    (`resumePromptPtyType` in `@batonpass/core`) directly into the fresh
    session's PTY once it's ready, and clears `pendingHandoff` itself —
    mirroring exactly what a `'session-start-hook'` adapter's hook would have
    done, just from the orchestrator side instead of a hook script. See
    `Orchestrator.maybeInjectPtyTypeResume`/`waitForPtyQuiet` in
    `packages/cli/src/orchestrator.ts`: readiness is detected by waiting for
    the child to produce output and then go quiet for `config.idleQuietMs`
    (plus a small extra `config.resumeTypeDelayMs` delay for slow-starting
    CLIs) — typing before the CLI's own prompt is up loses keystrokes. Keep
    the resume text to **one line**: typing multi-line content into a PTY can
    submit prematurely on the first newline.
  - If your tool has neither a usable hook nor a way to detect PTY
    readiness by output-then-quiet, open an issue — this covers the two
    strategies implemented so far, not necessarily every CLI shape.
- **`gracefulExitKeys`** — the keystrokes to cleanly end the CLI (e.g.
  `/exit\r` for Claude Code, `\x04` (Ctrl-D/EOT) for Codex). The orchestrator
  escalates to `SIGTERM` then `SIGKILL` if the child doesn't exit within a
  grace period.

## Hook scripts (or plugins) must be zero-dependency

Whatever hook scripts your adapter installs get copied into a user's
environment and invoked directly by the target CLI (`node
/path/to/script.mjs`) — they can't rely on `node_modules` being resolvable
from wherever they end up. Write them as plain `.mjs` using only `node:*`
built-ins (see `_lib.mjs` in either existing Node-hook adapter for the small
set of helpers — atomic file writes, JSON stdin parsing, path-safety checks —
that get duplicated rather than imported, on purpose).

If your tool's extension mechanism isn't Node hook scripts at all — Hermes'
is a Python plugin (`packages/adapter-hermes/plugin/`) — the same doctrine
applies in that language: standard-library only, atomic writes (tmp +
rename/`os.replace`), and every handler wrapped in its own try/except so a
bug in your plugin can never break a user's turn. Don't assume the host's
own dispatcher already catches exceptions for you (Hermes' does, but design
as if it didn't — see PLAN-hermes.md's §2 re-verification notes on
`invoke_hook`). A plugin that runs in *every* session once enabled (not just
Batonpass-managed ones) also needs an explicit inert-mode gate — Hermes'
plugin checks `$BATONPASS_DIR` is set and exists before touching anything.

## Re-verify platform facts before implementing

Hook APIs on agent CLIs move fast and are often explicitly marked
experimental — or, like Hermes' plugin system, undocumented entirely, in
which case "the docs" means a fresh clone of the source. Before writing a
new adapter (or updating an existing one for a new CLI version), re-fetch
the tool's current hook/session docs directly, or re-clone and grep the
source if there are no docs — don't trust cached knowledge, and don't trust
a single secondhand summary either. When re-verifying Codex's facts for this
repo, a first-pass report (via a research subagent) confidently asserted
several things that turned out to be backwards once checked against the live
docs page directly (see PLAN.md's §2.2 re-verification log) — cross-check
anything surprising against a primary source before changing an adapter's
behavior on the strength of it. The Hermes adapter's own re-verification
(PLAN-hermes.md's Progress section) is a second data point: nearly every §2
fact held up file:line-exact against a fresh clone, but a couple of citations
were imprecise (the wrong file for where a config key gets *written* vs.
where it's *read*) and one operationally important fact — an interactive
confirmation prompt on the plugin-enable command — wasn't in the original
plan at all and only surfaced by reading the actual command implementation.

## Testing a new adapter

Two testing patterns are used across the existing adapters and are the
minimum bar for a new one:

1. **Hook scripts (or plugin handlers) as real child processes.** Spawn each
   script with `spawnSync('node', [scriptPath], { input: JSON.stringify(fixture) })`
   and assert on `stdout`/`status`/`stderr` — see `hooks.test.ts` in either
   Node-hook adapter. This exercises the actual file the target CLI will
   invoke, not a mocked version of it. For a non-Node extension mechanism,
   the same principle still applies via a tiny same-language driver: Hermes'
   plugin has no host CLI to invoke it standalone, so
   `packages/adapter-hermes/test/plugin-driver.py` loads the real
   `plugin/__init__.py`, calls its `register(ctx)` with a fake `ctx` that
   records the registered callbacks, and invokes exactly one of them with
   JSON kwargs piped on stdin — run as a real `python3` child process (see
   `plugin.test.ts`), not imported and called in-process.
2. **A `FakeAdapter` + fake-agent PTY e2e test**, if you're touching the
   orchestrator. `examples/fake-agent/fake-agent.mjs` plus
   `packages/cli/test/fake-adapter.ts` are a deterministic stand-in that
   proves the full spawn → monitor → inject → validate → kill → respawn cycle
   works over a real `node-pty`-spawned child, without needing your actual
   target CLI installed. See `packages/cli/test/orchestrator.e2e.test.ts` for
   the `'session-start-hook'` path and `orchestrator.pty-type.e2e.test.ts`
   for the `'pty-type'` path (`FakeAdapterPtyType` spawns fake-agent with its
   own hook-simulation disabled via `FAKE_AGENT_SESSION_START_HOOK=0`, so
   only the orchestrator's typed resume can make the test pass).

Neither of these substitutes for a manual smoke test against the real CLI
before shipping — see `docs/testing.md`.
