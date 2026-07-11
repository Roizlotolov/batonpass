# Testing status

## Automated (this repo, CI-safe)

- **Unit** — schema/artifact/state/prompts/usage parsers in `@batonpass/core`
  (93%+ statement coverage), config.toml text-editing and hooks.json
  merge logic in `@batonpass/adapter-codex`, settings.json merge logic in
  `@batonpass/adapter-claude-code`.
- **Integration** — every hook script (both adapters) is invoked as a real
  child process with recorded stdin fixtures, asserting on stdout JSON shape
  and exit code — not mocked.
- **E2E (fake agent)** — `packages/cli/test/orchestrator.e2e.test.ts` spawns
  `examples/fake-agent/fake-agent.mjs` through a real `node-pty`, and proves 3
  fully automatic chained handoffs end-to-end (spawn → usage climbs → idle
  detected → prompt injected → artifact written+validated → killed →
  respawned → handoff re-injected), plus lock-file exclusivity between two
  orchestrators on the same project.
- **Hardening** — bounded-tail parsing on multi-MB synthetic transcripts/rollouts,
  path-traversal rejection on a tampered `pendingHandoff` value, a 5-cycle
  chained-handoff drift test proving the Objective section survives
  write→read→re-render verbatim.

None of the above requires a real `claude` or `codex` binary, an API key, or
network access — they run in plain CI.

## NOT yet done — manual verification required before a release

This implementation has not been run against the real `claude` or `codex`
CLIs. Before tagging a release, run through:

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
4. Windows: confirm the Claude Code path works end-to-end (this repo's CI
   only covers ubuntu + macOS); confirm the Codex adapter's `install()`
   refuses cleanly with a clear message rather than partially installing.

Both CLIs are evolving quickly and are explicitly marked experimental for the
hook surfaces Batonpass depends on — re-run this checklist against current
versions before every release, and see PLAN.md's "re-verify §2 facts" notes
for what's already been checked and when.
