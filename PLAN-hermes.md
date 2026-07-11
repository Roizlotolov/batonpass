# Batonpass — Hermes Agent Adapter

> **Implementation plan.** Written 2026-07-11 from the verification spike in
> [docs/gateway-hosts.md](./docs/gateway-hosts.md). Target: fully automatic
> handoff for the Hermes Agent interactive CLI via a new
> `@batonpass/adapter-hermes` package plus one small orchestrator extension.
> This document is self-contained — implement top to bottom. Read
> [PLAN.md](./PLAN.md) §3–5 first for the orchestrator/adapter architecture
> this builds on, and [docs/adapters.md](./docs/adapters.md) for the adapter
> contract.

---

## 1. Goal & shape

Hermes Agent (`NousResearch/hermes-agent`) is an **interactive terminal
CLI** — the same shape as Claude Code and Codex — so the existing PTY
orchestrator applies. The adapter follows the Claude Code adapter's pattern
with two twists:

1. Hermes hooks are a **Python plugin** (installed into
   `~/.hermes/plugins/batonpass/`), not JSON-config hook commands. The
   plugin does what the Claude statusline chain + Stop hook do: write
   `.batonpass/usage.json` and the `.batonpass/turn-idle` marker.
2. Hermes has **no context-injection hook** usable by plugins, so resume
   injection can't be `'session-start-hook'`. This plan adds a second
   strategy, `'pty-type'`: the orchestrator types a **single-line** resume
   instruction into the fresh session's PTY telling the agent to read the
   handoff file. (Single-line on purpose — typing multi-line content into a
   PTY submits prematurely; the artifact stays on disk and the agent reads
   it with its own file tools, which Hermes has.)

**Non-goals:** gateway-mode Hermes (Telegram/Discord) — see
docs/gateway-hosts.md, semi-auto only, not this plan. Windows — refuse
cleanly like the Codex adapter.

---

## 2. Verified platform facts

Verified against a clone of `NousResearch/hermes-agent` at commit
`c552984` (2026-07-11). **Re-verify each fact against the current clone at
implementation time** — same doctrine as PLAN.md §2; log what you checked
in the Progress section below.

### 2.1 CLI & commands

- Binary: `hermes` (interactive terminal chat CLI; also has `hermes <subcommand>` CLI commands, e.g. `hermes plugins enable <name>`).
- Graceful exit: **`/quit`** (`hermes_cli/commands.py:253`). → `gracefulExitKeys(): '/quit\r'`.
- Session reset: **`/new`** — "fresh session ID + history" (`commands.py:68`); `/clear` also resets (`commands.py:72`).
- ⚠️ **`/handoff` is taken**: built-in command meaning "hand off this session to a messaging platform" (`commands.py:87`), and `register_command` rejects built-in name conflicts (`hermes_cli/plugins.py`, conflict guard). Any batonpass manual-trigger command must use another name (this plan: `/baton`).
- Home dir: `HERMES_HOME` env var → `get_hermes_home()`; config at `<home>/config.yaml` (`hermes_constants.py:915-920`). **`HERMES_HOME` makes install/uninstall fully testable in a temp dir.**

### 2.2 Plugin system

- Layout: `~/.hermes/plugins/<name>/` containing `plugin.yaml` + `__init__.py` exporting `register(ctx)`. Real example manifest (`plugins/observability/langfuse/plugin.yaml`):

  ```yaml
  name: batonpass
  version: "0.1.0"
  description: "..."
  hooks:
    - post_api_request
    - post_llm_call
  ```

- Enable: `hermes plugins enable batonpass` (enablement is recorded in config — `hermes_cli/plugins.py:1459` error text confirms config-driven). Prefer shelling out to the real command in `install()`; only fall back to a config edit if the binary is missing, and verify the exact config key it writes at implementation time.
- Hooks are invoked **synchronously** (`PluginManager.invoke_hook` calls `cb(**kwargs)`) — handlers must be plain `def`, fast, and never raise (wrap everything; a slow handler blocks the turn).
- **No plugin-config mechanism exists** (no `plugin_config`, no `get_config()`) — the sanctioned pattern is environment variables (the bundled langfuse plugin does exactly this). Batonpass passes `BATONPASS_DIR` via `spawnCommand().env`.
- `PluginContext.inject_message(content, role="user")` (`hermes_cli/plugins.py:474`): queues input if idle / interrupts if running; **CLI mode only** (returns `False` in gateway mode). Available as a fallback injection path, but this plan uses PTY typing to keep the orchestrator uniform.

### 2.3 Usage data (→ `usage.json`)

`post_api_request` fires per LLM API call with, among others
(`agent/conversation_loop.py:4283-4308`): `session_id`, `platform`, `model`,
`provider`, `base_url`, `api_mode`, `finish_reason`, `message_count`, and
**`usage`** — built by `_usage_summary_for_api_request_hook`
(`run_agent.py:2242-2256`): `asdict(CanonicalUsage)` minus `raw_usage`, i.e.

```
{input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
 reasoning_tokens, request_count, prompt_tokens, total_tokens}
```

- **Context occupancy ≈ `prompt_tokens` of the latest call** (what was sent
  to the model this call). Verify this interpretation once against a real
  session during the manual smoke test (§7) — log the numbers.
- **Context limit:** `agent.model_metadata.get_cached_context_length(model, base_url)`
  (`agent/model_metadata.py:1117`) — Hermes' own on-disk cache, local-only,
  returns `None` until Hermes has warmed it for that model. Do NOT call the
  network-probing variant (`get_model_context_length`) from a synchronous
  hook. When limit is unknown, write `usage.json` with `max: null` and no
  `pct` — the orchestrator already tolerates null/partial usage.

### 2.4 Turn-idle (→ `turn-idle` marker)

`post_llm_call` fires at turn finalization (`agent/turn_finalizer.py`;
kwargs: `session_id, task_id, turn_id, user_message, assistant_response,
conversation_history, model, platform` — previously verified by usage-hud
against this codebase). Handler writes the `.batonpass/turn-idle` timestamp
marker, exactly like the other adapters' Stop hooks. (Note: `post_llm_call`
carries **no usage data** — that was a verified usage-hud correction; usage
comes only from `post_api_request`.)

### 2.5 Compaction — must be handled

Hermes **auto-compresses at 50% of context by default**
(`cli.py:421` — `"enabled": True`; `compression.threshold`, default 0.50 —
`hermes_cli/tips.py:114`), and auto-compression **ends the session and
forks a new one** (`hermes_state.py:4248`, `cli.py:9344`, `cli.py:12534`).
Left alone, Hermes compacts long before batonpass's 75% threshold ever
fires. There is no dynamic block (nothing like Claude's PreCompact exit-2);
the knob is static config. `install()` must set:

```yaml
compression:
  threshold: 0.90
```

(0.90, not `enabled: false` — if batonpass dies, the user keeps a safety
net above batonpass's 0.75 instead of none at all.) Back up `config.yaml`
before editing; restore semantics on `--uninstall`. Batonpass's own default
threshold (0.75) must stay below this — `doctor` should check the ordering.

### 2.6 Session-start hook is observer-only

The plugin hook `on_session_start` receives only `session_id`
(`hermes_cli/hooks.py:151`) and its return value is ignored — context
injection via hook is NOT possible. (The richer
`on_session_start(**start_context)` at `run_agent.py:660` is a
*context-engine* interface, not the plugin hook.) Hence `'pty-type'`.

---

## 3. Orchestrator extension: `'pty-type'` resume strategy

The one interface change, flagged in advance by docs/adapters.md ("the one
place the interface currently assumes a hook").

- `Adapter.resumeInjection()` return type becomes
  `'session-start-hook' | 'pty-type'`.
- Orchestrator (`packages/cli/src/orchestrator.ts`), in the SPAWN/resume
  path: when the adapter says `'pty-type'` and `state.json.pendingHandoff`
  is set, wait for the child to be **ready** (see below), then type the
  resume instruction and clear `pendingHandoff` — mirroring what the
  SessionStart hooks do for the other adapters (including marking the
  handoff consumed the same way the hook path does).
- New prompt template in `@batonpass/core` (`packages/core/src/prompts.ts`),
  alongside `handoffPrompt`: `resumePromptPtyType(handoffRelPath)` — a
  **single-line** instruction of the form: *"Resuming from a previous
  session. Read `<relpath>` in full before doing anything else and continue
  from its Next steps; honor its Do NOT section."* Keep it one line, no
  newlines except the trailing `\r`.
- **Readiness detection:** typing into a PTY before the CLI's prompt is up
  loses keystrokes. Reuse the existing idle heuristic: wait until the child
  has produced output and then gone quiet for `idleQuietMs` (the RingBuffer
  in `packages/cli/src/pty.ts` already supports this), then type. Add a
  config knob `resumeTypeDelayMs` (default ~500) applied after the quiet
  window, for slow-starting CLIs.
- E2E-able without Hermes: add a FakeAdapter variant returning
  `'pty-type'` and extend `examples/fake-agent/fake-agent.mjs` to echo
  received input lines into a file the test can assert on (it may already —
  check before extending).

---

## 4. Package: `packages/adapter-hermes` (`@batonpass/adapter-hermes`)

Mirror the structure of `packages/adapter-codex` (the closer sibling — it
also refuses Windows and text-edits a foreign config file).

- `id`: `'hermes'` — extend `ToolId` in `@batonpass/core` (schema union,
  `handoff.json.tool`) and every exhaustive switch over it. Bump nothing in
  the spec version: adding an enum member is backward-compatible for
  readers per docs/spec.md's intent, but confirm the zod schema treats
  unknown tools gracefully or document the addition in docs/spec.md.
- `detectInstalled()`: `hermes --version` on PATH (verify the exact flag
  works at impl time; fall back to `which hermes`).
- `spawnCommand({cwd})`: `{ cmd: 'hermes', args: [], env: { BATONPASS_DIR: path.join(cwd, '.batonpass') } }`.
- `usageSource(session)`: read `<BATONPASS_DIR>/usage.json` (push-based
  primary, same shape the Claude adapter writes: `{pct, tokens, max,
  source}`); no pull-based fallback for v1 (Hermes transcripts are an
  UNRESOLVED format — note it in the package README).
- `isTurnIdle(session)`: `turn-idle` marker newer than `session.sinceMs` —
  copy the existing pattern.
- `injectHandoffPrompt(pty, artifactPath)`: type `handoffPrompt(artifactPath)`
  + `\r`, same as the other adapters.
- `resumeInjection()`: `'pty-type'`.
- `gracefulExitKeys()`: `'/quit\r'`.
- `install(scope, cwd)`:
  - **User scope only.** Hermes plugins and config are per-user
    (`~/.hermes/`); there is no project-scope equivalent. `install('project')`
    must throw with a clear message telling the user to use `--user`
    (and `batonpass init --agent hermes` should imply/require `--user`).
  - Copy the helper plugin (bundled in this package under `plugin/`) into
    `<HERMES_HOME>/plugins/batonpass/`.
  - Enable it: shell out to `hermes plugins enable batonpass`; if that
    fails/binary missing, error out with instructions (do not guess the
    config key blindly — verify what `enable` writes first and only then
    consider a direct-edit fallback).
  - Edit `<HERMES_HOME>/config.yaml`: set `compression.threshold: 0.90`
    **iff** current effective threshold is lower. Use the text-editing
    approach of `adapter-codex/src/configtoml.ts` (preserve comments and
    unrelated keys; narrow, marker-comment-annotated edit) rather than a
    YAML-roundtrip library. Back up first; report in `backedUpFiles`.
  - Idempotent; `uninstall` removes the plugin dir, disables the entry the
    same way `enable` enabled it, and reverts the threshold edit (only if
    it still carries batonpass's marker comment).
- `isInstalled`: plugin dir exists + enabled + threshold edit present.

### 4.1 The helper plugin (Python, zero-dependency)

`packages/adapter-hermes/plugin/{plugin.yaml,__init__.py}` — pure stdlib
Python 3.11, mirroring the hook-script rules of docs/adapters.md (no
imports beyond stdlib; atomic writes via tmp+`os.replace`; never raise —
wrap every handler body in try/except; no network; no blocking I/O beyond
tiny local files).

- `register(ctx)`:
  - `ctx.register_hook("post_api_request", on_api)` — compute
    `tokens = usage["prompt_tokens"]`,
    `max = get_cached_context_length(model, base_url)` (import inside the
    handler, guarded), `pct = round(tokens/max*100)` when max known; write
    `$BATONPASS_DIR/usage.json` `{pct, tokens, max, source: "hermes-post-api-request", ts}`.
  - `ctx.register_hook("post_llm_call", on_turn_end)` — write
    `$BATONPASS_DIR/turn-idle` (epoch-ms string).
  - `ctx.register_command("baton", handler, description=...)` — manual
    trigger: writes `$BATONPASS_DIR/manual-handoff-requested` marker.
    **Stretch — only wire it if the orchestrator already polls such a
    marker; otherwise ship the command writing the marker and file an issue
    to consume it.**
  - `BATONPASS_DIR` resolution: `os.environ.get("BATONPASS_DIR")` or
    `./​.batonpass` relative to CWD; if the dir doesn't exist, do nothing
    (plugin is enabled globally but must be inert outside batonpass-run
    sessions — this is the behavior gate).

---

## 5. CLI wiring

- `batonpass init --agent hermes|all` (user scope enforced, see §4),
  `batonpass run hermes`, `batonpass doctor` (checks: binary on PATH, plugin
  installed+enabled, compression threshold ≥ batonpass threshold, python3
  presence irrelevant at runtime — Hermes runs the plugin), `batonpass status`.
- `--agent all` now means three tools; make sure partial-failure reporting
  stays per-agent.

---

## 6. Implementation phases

1. **Core + orchestrator:** `ToolId` extension; `'pty-type'` strategy +
   `resumePromptPtyType` template + readiness wait; FakeAdapter-variant e2e
   proving a typed resume lands (extend fake-agent input-echo if needed).
2. **Adapter skeleton:** package scaffolding, detect/spawn/exit/usage/idle,
   unit tests for the usage-file reader and idle marker (copy sibling
   tests).
3. **Helper plugin:** plugin.yaml + `__init__.py`; test by invoking
   `python3 -c "<driver>"` as a real child process with fixture kwargs
   (spawnSync pattern from `hooks.test.ts`, Python edition) — skip the
   suite gracefully when `python3` is absent, but note CI runners have it.
4. **Install/uninstall:** plugin copy + enable shell-out + config.yaml
   threshold edit with backups; tests against a temp `HERMES_HOME`.
5. **CLI wiring + docs:** init/run/doctor/status; README support table;
   docs/adapters.md gains the `'pty-type'` strategy section;
   docs/testing.md gains the Hermes manual checklist (§7); package README
   documenting every §2 fact it relies on. Changeset (`minor` for core/cli,
   new package for adapter-hermes).

Each phase: `pnpm build && pnpm test && pnpm lint` green before moving on.

---

## 7. Manual verification checklist (before any release claiming Hermes support)

Mirrors docs/testing.md. With a real `hermes` install:

1. `batonpass init --agent hermes --user` → plugin dir exists, `hermes
   plugins list` shows it enabled, config.yaml threshold edited with marker
   comment, backup created.
2. Run vanilla `hermes`, chat a few turns → `.batonpass/usage.json` appears
   and `prompt_tokens` grows monotonically with conversation length
   (validates the occupancy interpretation, §2.3); `turn-idle` updates at
   end of each turn; **no visible latency or errors added to turns**.
3. `batonpass run hermes` on a real task with a low test threshold
   (e.g. `threshold: 0.2`): full automatic cycle — handoff written and
   validated, `/quit` typed, fresh `hermes` spawned, resume line typed after
   the prompt is ready (watch for lost keystrokes — tune
   `resumeTypeDelayMs`), agent actually reads the artifact.
4. Confirm Hermes' own auto-compression did NOT fire first (threshold
   ordering), and `/baton` writes its marker.
5. `batonpass init --agent hermes --uninstall` restores config and removes
   the plugin; vanilla `hermes` unaffected afterward.

---

## 8. Risks & mitigations

- **Readiness race on typed resume** (worst failure: half a prompt line
  submitted early). Mitigate: quiet-window wait + `resumeTypeDelayMs`; e2e
  covers the mechanism, manual test tunes the default.
- **`prompt_tokens` ≠ occupancy** on some providers/api_modes. Mitigate:
  verify in §7.2; if wrong, fall back to `input_tokens + cache_read_tokens`
  — decide from real numbers, document in the package README.
- **Hook API drift** — Hermes is moving fast; every §2 fact carries a
  file:line from commit `c552984`. Re-verify at impl time and log it below.
- **Config-edit collisions** — user already has `compression:` customized.
  The text-edit must handle: key absent, key present lower, key present
  higher (leave alone), comments preserved. Test all three.
- **Plugin inert-mode bugs** — the plugin runs in EVERY hermes session once
  enabled. The `.batonpass`-dir gate (§4.1) is the safety valve; test that
  no files are created outside batonpass projects.

---

## 9. Notes for the implementing agent

- Follow CONTRIBUTING.md: hook handlers tested as real child processes;
  changesets, not hand-bumped versions; re-verify platform facts against a
  fresh clone (`git clone --depth 1 https://github.com/NousResearch/hermes-agent`)
  and log what you checked in Progress below with file:line.
- Copy idioms from `adapter-codex` (Windows refusal, config text-editing,
  paths module) and `adapter-claude-code` (usage.json writer shape) rather
  than inventing new ones.
- Keep the helper plugin boring: stdlib only, atomic writes, silent
  failure. Its entire job is two tiny files and one marker.
- If a §2 fact turns out wrong on contact with current source, STOP,
  update this plan and docs/gateway-hosts.md first, then continue — don't
  code around a stale plan silently.

## Progress

- _(empty — implementation not started)_
