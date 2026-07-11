# Feasibility: Hermes Agent & OpenClaw adapters

Verification spike, 2026-07-11. Every claim below was checked against real
source — `NousResearch/hermes-agent` at commit `c552984` (fresh clone) and
the `openclaw@2026.6.11` npm package (installed, types + bundled docs +
compiled runtime read directly) — following the same doctrine as
[adapters.md](./adapters.md): no memory-based claims, `UNRESOLVED` is a
valid verdict. Re-verify against current versions before implementing;
both projects move fast.

## TL;DR

| | Hermes (CLI mode) | Hermes (gateway mode) | OpenClaw (third-party plugin) | OpenClaw (bundled) |
|---|---|---|---|---|
| Verdict | **Fully automatic — feasible** | Semi-automatic | **Semi-automatic — verified, surprisingly good** | Fully automatic feasible |
| Mechanism | Existing PTY orchestrator + small helper plugin | Piggyback on inbound rewrite | In-gateway plugin (new orchestration mode) | `scheduleSessionTurn` |
| Missing piece | none identified | turn injection | programmatic session reset | — |

Hermes is the natural next adapter: it is an **interactive terminal CLI**
(the gateway is a separate mode), so batonpass's existing PTY orchestrator
applies with minimal changes. OpenClaw is gateway-only and needs a second,
in-process orchestration mode — most of the lifecycle is verifiably
implementable, except the session kill/respawn itself.

---

## Hermes Agent

Interactive terminal CLI (`hermes`) with a Python plugin system
(`~/.hermes/plugins/<name>/` — `plugin.yaml` + `__init__.py` `register(ctx)`;
hooks are invoked synchronously). Findings:

### Turn injection — VERIFIED-YES (CLI mode), VERIFIED-NO (gateway mode)

`PluginContext.inject_message(content, role="user")`
(`hermes_cli/plugins.py:474`) is a sanctioned API: if the agent is idle it
queues the message as the next input (starts a turn); if running, it
interrupts. **Explicitly unavailable in gateway mode** — `_cli_ref` is
`None` there and the call returns `False` with a warning. In gateway mode
the only injection seam is `pre_gateway_dispatch`, which can *rewrite* an
inbound message (`{"action": "rewrite", "text": ...}`) — piggyback, not
initiation.

For the PTY adapter this barely matters: batonpass types the handoff prompt
into the PTY itself, exactly as the Claude/Codex adapters do.

### Session reset — VERIFIED-YES

Built-in `/new` — "Start a new session (fresh session ID + history)"
(`hermes_cli/commands.py:68`); `/clear` also resets. Injected input flows
through the same `_pending_input` queue the command processor drains
(`cli.py:6083-6087`; the `/steer` docstring at `cli.py:8328` confirms
commands are pulled from `_pending_input`), so a plugin can trigger `/new`
programmatically in CLI mode — and the PTY orchestrator can simply type it,
or kill/respawn the `hermes` process as it does today for other agents.

### Context seeding on session start — YES via typing/injection

The plugin hook `on_session_start` receives only `session_id`
(`hermes_cli/hooks.py:151`) and is observer-only — it cannot return injected
context. (The richer `on_session_start(**start_context)` in
`run_agent.py:660` is a *context-engine* interface, not the plugin hook.)
Not a blocker: in CLI mode the handoff is delivered by typing it as the
first message (PTY) or via `inject_message`. This means a Hermes adapter
needs `resumeInjection()` to support a `'pty-type'` strategy in addition to
`'session-start-hook'` — a small, contained orchestrator extension (the one
place the current interface assumes a hook, as adapters.md already notes).

### Usage source — VERIFIED (prior art)

`post_api_request` hook fires per LLM call with a full usage dict
(verified previously by usage-hud against this same codebase). Context
length comes from Hermes' on-disk model-metadata cache. The batonpass helper
plugin mirrors the Claude adapter's statusline chain: hook → write
`.batonpass/usage.json`. Turn-idle: `post_llm_call` /
`transform_llm_output` fire at end-of-turn → write the `.batonpass/turn-idle`
marker.

### Compaction control — VERIFIED-YES (config knob)

Hermes auto-compresses **at 50% of context by default**
(`cli.py:421` — `"enabled": True`; threshold via `compression.threshold`,
`hermes_cli/tips.py:114`), and auto-compression *ends the session and forks
a new one* (`hermes_state.py:4248`, `cli.py:9344`). Batonpass must raise or
disable this via config during `install()` — the direct analogue of blocking
Claude Code's `PreCompact` — otherwise Hermes compacts long before
batonpass's 75% threshold fires.

### Gotchas

- **`/handoff` name collision**: Hermes has a built-in `/handoff` command
  (hand the session to a messaging platform, `hermes_cli/commands.py:87`),
  and `register_command` rejects built-in conflicts. Batonpass's manual
  trigger on Hermes needs another name (`/baton`?), configurable in the
  adapter.
- Helper plugin config must be env-vars (no plugin-config mechanism exists —
  prior usage-hud finding, still true).

### Adapter sketch

`@batonpass/adapter-hermes`: `spawnCommand` → `hermes`; `install()` copies a
small Python helper plugin into `~/.hermes/plugins/batonpass/` (usage +
turn-idle markers) and sets `compression.threshold`/`enabled` in config
(backed up); `injectHandoffPrompt` types into the PTY; graceful exit —
whatever `hermes` uses to quit (verify: `/exit`?); `resumeInjection` →
new `'pty-type'` strategy. Fully automatic, same UX as Claude/Codex.

---

## OpenClaw

Gateway/channel-centric (Discord/Telegram/Matrix/…), TypeScript plugins. No
user-facing interactive TUI was confirmed (UNRESOLVED — its `cli-backend`
plugin surface is for OpenClaw spawning *other* coding CLIs, i.e. OpenClaw
sits where batonpass's PTY mode sits). So an OpenClaw adapter is a **second
orchestration mode**: an in-gateway plugin, not a PTY wrapper.

Confirmed still true in 2026.6.11: `scheduleSessionTurn`,
`sendSessionAttachment`, `api.runtime.state` are **bundled-plugin-only**;
conversation hooks require `plugins.entries.<id>.hooks.allowConversationAccess: true`.

### What a third-party plugin CAN verifiably do

1. **Monitor context per turn** — `reply_payload_sending` →
   `usageState.contextUsedTokens/contextTokenBudget/compactionCount`
   (`dist/plugin-sdk/hook-types-YIiTro9N.d.ts:616-679`).
2. **Force the agent to write the handoff automatically** —
   `before_agent_finalize` → return `{action: "revise", retry: {instruction}}`
   (`hook-types-YIiTro9N.d.ts:503-516`, `docs/plugins/hooks.md`): when the
   turn that crosses the threshold finishes, the plugin forces one more
   model pass with the handoff instructions, bounded by
   `idempotencyKey`/`maxAttempts`. Extends the current turn — cannot start
   one in an idle session.
3. **Seed the successor session** — `session_end` carries
   `nextSessionId`/`nextSessionKey` + reason
   (`"new"|"reset"|"idle"|"daily"|"compaction"|…`)
   (`hook-types-YIiTro9N.d.ts:765-776`); combine with
   `api.session.workflow.enqueueNextTurnInjection({sessionKey, text,
   placement: "prepend_context"})` — durable, once-only, **not
   bundled-gated** (`types-CR1WAXpo.d.ts:9317`; on by default, users can
   only opt out via `hooks.allowPromptInjection: false`).
4. **One-keystroke manual trigger** — a registered `/handoff`-style command
   can return `{continueAgent: true}` (`types-CR1WAXpo.d.ts:8933-8937`;
   runtime confirmed in `dist/get-reply-D-_K5pna.js:2078,2235`) so the
   command body flows into a real agent turn — the agent writes the handoff
   from a single user command.

### What it CANNOT do (the gap)

**Programmatic session reset** — VERIFIED-NO. `before_reset` is
observe-only; the whole `OpenClawPluginApi` surface
(`types-CR1WAXpo.d.ts:9280-9596`) has no reset call. Reset stays
user-triggered (`/new`) or host-policy-triggered (idle/daily/compaction) —
which the plugin *rides* cleanly via the `session_end` → seed-next-session
seam above.

### UNRESOLVED (follow-ups that could upgrade to fully automatic)

- Gateway cron service (`ctx.getCron()`, `PluginHookGatewayCronService`,
  `hook-types-YIiTro9N.d.ts:872-977`) takes a `sessionTarget` + text
  payload — if not bundled-gated, this may be a sanctioned way to trigger a
  turn (and hence a full cycle). Gating unverified.
- `api.registerCompactionProvider` (pluggable summarization backend,
  `types-CR1WAXpo.d.ts:~9454`) shows **no bundled-only annotation** — if
  third-party-usable, batonpass could make OpenClaw's own compaction emit a
  structured handoff as the summary. That would be the most elegant
  integration of all. Gating unverified.
- `before_compaction`/`after_compaction` hooks exist but are observe-only —
  compaction cannot be blocked from a hook.

### Verdict

Semi-automatic v1 is verified-buildable and good: automatic threshold
detection, automatic agent-written handoff at end-of-turn, automatic seeding
of whatever session comes next; the only human step is triggering the reset
(or letting OpenClaw's own idle/daily/compaction reset do it). Fully
automatic needs one of the two UNRESOLVED paths to pan out, or a bundled
plugin upstream (`scheduleSessionTurn` makes it trivial).

---

## Suggested build order

1. **Hermes adapter** — highest value/effort ratio: reuses the existing PTY
   orchestrator; needs one small interface extension (`'pty-type'` resume
   strategy), one Python helper plugin, and a config edit for compaction.
   Python core port is NOT needed (the helper plugin only writes marker
   files; validation stays in the Node CLI).
   **Implementation plan: [PLAN-hermes.md](../PLAN-hermes.md).**
2. **OpenClaw plugin** — new embedded orchestration mode; ship semi-auto v1
   per above; file the two UNRESOLVED questions upstream (cron gating,
   compaction-provider gating) and as issues on this repo.
3. Update [adapters.md](./adapters.md) with the second orchestration mode
   once it exists.
