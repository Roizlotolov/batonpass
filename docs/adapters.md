# Writing a Batonpass adapter

Batonpass's orchestrator (`packages/cli/src/orchestrator.ts`) doesn't know anything
about a specific coding-agent CLI — it only calls methods on an `Adapter`
(defined in `packages/core/src/adapter.ts`). Two adapters exist today (Claude
Code, Codex CLI); contributions for OpenClaw, Hermes, OpenCode, or anything
else with a hookable session lifecycle are welcome.

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
  resumeInjection(): 'session-start-hook';
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
- **`resumeInjection`** — both adapters currently return
  `'session-start-hook'`, meaning: the orchestrator sets
  `state.json.pendingHandoff` before killing the old session, and your
  adapter's session-start-equivalent hook reads it, injects the handoff
  content as additional context, and clears the field. If your tool has no
  hook mechanism at all, you'd need a different resume strategy — this is the
  one place the interface currently assumes a hook exists; open an issue if
  you need something else.
- **`gracefulExitKeys`** — the keystrokes to cleanly end the CLI (e.g.
  `/exit\r` for Claude Code, `\x04` (Ctrl-D/EOT) for Codex). The orchestrator
  escalates to `SIGTERM` then `SIGKILL` if the child doesn't exit within a
  grace period.

## Hook scripts must be zero-dependency

Whatever hook scripts your adapter installs get copied into a user's
environment and invoked directly by the target CLI (`node
/path/to/script.mjs`) — they can't rely on `node_modules` being resolvable
from wherever they end up. Write them as plain `.mjs` using only `node:*`
built-ins (see `_lib.mjs` in either existing adapter for the small set of
helpers — atomic file writes, JSON stdin parsing, path-safety checks — that
get duplicated rather than imported, on purpose).

## Re-verify platform facts before implementing

Hook APIs on agent CLIs move fast and are often explicitly marked
experimental. Before writing a new adapter (or updating an existing one for a
new CLI version), re-fetch the tool's current hook/session docs directly —
don't trust cached knowledge, and don't trust a single secondhand summary
either. When re-verifying Codex's facts for this repo, a first-pass report
(via a research subagent) confidently asserted several things that turned out
to be backwards once checked against the live docs page directly (see
PLAN.md's §2.2 re-verification log) — cross-check anything surprising against
a primary source before changing an adapter's behavior on the strength of it.

## Testing a new adapter

Two testing patterns are used across the existing adapters and are the
minimum bar for a new one:

1. **Hook scripts as real child processes.** Spawn each script with
   `spawnSync('node', [scriptPath], { input: JSON.stringify(fixture) })` and
   assert on `stdout`/`status`/`stderr` — see `hooks.test.ts` in either
   adapter. This exercises the actual file the target CLI will invoke, not a
   mocked version of it.
2. **A `FakeAdapter` + fake-agent PTY e2e test**, if you're touching the
   orchestrator. `examples/fake-agent/fake-agent.mjs` plus
   `packages/cli/test/fake-adapter.ts` are a deterministic stand-in that
   proves the full spawn → monitor → inject → validate → kill → respawn cycle
   works over a real `node-pty`-spawned child, without needing your actual
   target CLI installed. See `packages/cli/test/orchestrator.e2e.test.ts`.

Neither of these substitutes for a manual smoke test against the real CLI
before shipping — see `docs/testing.md`.
