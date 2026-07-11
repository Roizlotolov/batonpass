# Testing status

## Automated (this repo, CI-safe)

- **Unit** — schema/artifact/state/prompts/usage parsers in `@batonpass/core`
  (93%+ statement coverage), config.toml text-editing and hooks.json
  merge logic in `@batonpass/adapter-codex`, settings.json merge logic in
  `@batonpass/adapter-claude-code`, config.yaml text-editing (compression
  threshold, read-only `plugins.enabled` parsing) in `@batonpass/adapter-hermes`.
- **Integration** — every hook script (Claude Code, Codex) is invoked as a
  real child process with recorded stdin fixtures, asserting on stdout JSON
  shape and exit code — not mocked. Hermes' Python plugin is exercised the
  same way via a small same-language driver (`plugin-driver.py`) that loads
  the real `plugin/__init__.py` and invokes its registered handlers as a real
  `python3` child process (skipped gracefully if `python3` isn't on `PATH`).
  `HermesAdapter.install()`'s shell-outs (`hermes --version`,
  `hermes plugins enable/disable`) are exercised against a tiny fake `hermes`
  binary on `PATH`, not a real install.
- **E2E (fake agent)** — `packages/cli/test/orchestrator.e2e.test.ts` spawns
  `examples/fake-agent/fake-agent.mjs` through a real `node-pty`, and proves 3
  fully automatic chained handoffs end-to-end (spawn → usage climbs → idle
  detected → prompt injected → artifact written+validated → killed →
  respawned → handoff re-injected via a `SessionStart`-style hook), plus
  lock-file exclusivity between two orchestrators on the same project.
  `orchestrator.pty-type.e2e.test.ts` proves the same chained-handoff cycle
  for Hermes' resume strategy instead: `FakeAdapterPtyType` spawns fake-agent
  with its `SessionStart`-hook simulation disabled, so the resume can only
  land via the orchestrator itself typing into the PTY — asserted by reading
  back what fake-agent actually received on stdin.
- **Hardening** — bounded-tail parsing on multi-MB synthetic transcripts/rollouts,
  path-traversal rejection on a tampered `pendingHandoff` value, a 5-cycle
  chained-handoff drift test proving the Objective section survives
  write→read→re-render verbatim.

None of the above requires a real `claude`, `codex`, or `hermes` binary, an
API key, or network access — they run in plain CI.

## NOT yet done — manual verification required before a release

This implementation has not been run against the real `claude`, `codex`, or
`hermes` CLIs. Before tagging a release, run through:

1. `batonpass init --agent claude` in a real project, then run vanilla `claude`
   and confirm: `/handoff` produces a valid artifact; a brand-new session in
   the same project receives the handoff via `SessionStart`'s
   `additionalContext`; `PreCompact` actually blocks an automatic compaction
   while `.batonpass/state.json.orchestratorPid` is alive, and does *not* block
   it when Batonpass isn't running.
2. `batonpass run claude` on a real, long task and confirm a real automatic
   handoff fires at the configured threshold, the old session exits cleanly
   via `/exit`, and the new one picks up the injected context correctly.
3. Repeat both for `codex` (`batonpass init --agent codex`, `batonpass run codex`) —
   including confirming `[features] codex_hooks = true` actually gets read by
   the installed Codex CLI version being tested against, since hooks are
   still marked experimental upstream.
4. **Hermes** (mirrors PLAN-hermes.md §7 — repeat this exact list before any
   release claiming Hermes support):
   1. `batonpass init --agent hermes --user` → plugin dir exists at
      `~/.hermes/plugins/batonpass/`, `hermes plugins list` shows it enabled,
      `config.yaml`'s `compression.threshold` is edited (with a batonpass
      marker comment) and a backup was created.
   2. Run vanilla `hermes`, chat a few turns → `.batonpass/usage.json`
      appears and its `tokens` (from `prompt_tokens`) grows monotonically
      with conversation length — this validates the "`prompt_tokens` ≈
      context occupancy" interpretation from PLAN-hermes.md §2.3, which is
      unverified against a real session; `turn-idle` updates at the end of
      each turn; no visible latency or errors added to turns.
   3. `batonpass run hermes` with a low test threshold (e.g. `threshold: 0.2`
      in `.batonpass/config.json`): full automatic cycle — handoff written
      and validated, `/quit` typed, a fresh `hermes` spawned, and the
      `'pty-type'` resume line typed once the new session's prompt is ready
      (watch for lost keystrokes — tune `resumeTypeDelayMs` if so); confirm
      the agent actually reads the referenced handoff file.
   4. Confirm Hermes' own auto-compression (raised to 90% by `install()`)
      does not fire before Batonpass's own threshold, and that `/baton`
      writes its marker file.
   5. `batonpass init --agent hermes --uninstall` restores `config.yaml` and
      removes the plugin directory; vanilla `hermes` is unaffected
      afterward.
5. Windows: confirm the Claude Code path works end-to-end (this repo's CI
   only covers ubuntu + macOS); confirm the Codex and Hermes adapters'
   `install()` both refuse cleanly with a clear message rather than
   partially installing.

All three CLIs are evolving quickly — Claude Code and Codex explicitly mark
their hook surfaces experimental, and Hermes' plugin API isn't documented at
all (only discoverable by reading its source) — so re-run this checklist
against current versions before every release. See PLAN.md's and
PLAN-hermes.md's "re-verify §2 facts" notes for what's already been checked
and when.
