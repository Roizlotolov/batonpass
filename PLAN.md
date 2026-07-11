# Batonpass — Automatic Session Handoff for Coding Agents

> **Implementation plan.** Written 2026-07-11. Target: production-ready v1.0 supporting Claude Code + Codex CLI, fully automatic handoff & resume. Language: TypeScript/Node. This document is self-contained — implement top to bottom.

---

## 1. Problem & Product

Long agent sessions degrade: context fills up, built-in auto-compaction is lossy and tool-specific, and users manually write "handoff notes" and restart sessions. **Batonpass** automates the full loop:

1. Monitor context usage of a running agent session.
2. At a threshold (default 75%), have **the agent itself** write a structured handoff artifact (agent-written beats external summarization — the agent knows what matters).
3. Kill the old session and spawn a fresh one with the handoff injected as initial context.
4. Repeat indefinitely — chained handoffs, zero user action.

**Differentiation vs. built-in compaction:** cross-tool standard format, lossless structured state (not a summary blob), full handoff history on disk, works identically across agents.

**Non-goals (v1):** Windows support for Codex (Codex hooks are disabled on Windows), OpenClaw/Hermes adapters (post-v1, community), GUI, cloud sync.

**Naming:** working name `batonpass` (npm scope `@batonpass-dev/*` or similar — check npm availability first; fallbacks: `batonpass`, `handoff-kit`, `relayctl`).

---

## 2. Verified platform facts (researched 2026-07; re-verify at implementation time)

### 2.1 Claude Code

- **Hooks:** JSON on stdin, exit codes + optional JSON on stdout. Exit 0 = allow, exit 2 = block. Relevant events: `SessionStart` (source: `startup|resume|clear|compact`), `SessionEnd`, `PreCompact` (trigger: `manual|auto`), `Stop`, `UserPromptSubmit`.
- **`SessionStart` stdout can inject context** into the model (JSON `hookSpecificOutput.additionalContext`). This is the injection point for resume.
- **`PreCompact` with exit 2 blocks auto-compaction.** This lets Batonpass take over before Claude Code's own lossy compaction fires.
- **Context usage:** the statusline input JSON includes `context_window.used_percentage` and `context_window.context_window_size`. Other hook payloads do NOT include token counts. Transcripts live at `~/.claude/projects/<cwd-slugified>/<session-id>.jsonl`; each assistant message line carries `usage` fields (input_tokens + cache_creation_input_tokens + cache_read_input_tokens) — parseable as a second usage source.
- **Resume/start:** `claude --continue` (latest in cwd), `claude --resume <session-id>`, `claude -p "<prompt>"` (one-shot headless), `claude "<prompt>"` (interactive with initial prompt — **verify exact behavior on current CLI version early in Phase 2**; if it's one-shot, rely on SessionStart injection instead, which works regardless).
- **Plugin packaging:** `.claude-plugin/plugin.json` manifest; hooks, commands, statusline ship inside the plugin.
- Docs: https://code.claude.com/docs/en/hooks , /statusline , /sessions , /plugins

### 2.2 Codex CLI

- **Hooks are experimental**, behind `[features] codex_hooks = true` in `~/.codex/config.toml`; discovered from `~/.codex/hooks.json` and `<repo>/.codex/hooks.json`. Disabled on Windows.
- Events: `SessionStart` (source: `startup|resume`), `UserPromptSubmit`, `PreToolUse`/`PostToolUse` (Bash only), `Stop`. All receive `session_id`, `transcript_path`, `cwd` on stdin.
- **`SessionStart` plain-text stdout or JSON `additionalContext` injects developer context** — the resume injection point.
- **`Stop` hook** receives `last_assistant_message`, can return `{"decision":"block","reason":"..."}` to force a continuation prompt — usable to trigger handoff writing at end of turn.
- **Sessions:** JSONL rollout files at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Rollout lines include token-count events — Batonpass's usage source for Codex. `codex resume <session-id>` / `codex resume --last`; non-interactive: `codex exec resume --last`.
- No PreCompact equivalent — Codex compaction can't be blocked; Batonpass must fire *before* Codex's own threshold.
- Docs: https://developers.openai.com/codex/hooks , /codex/cli/reference . Hook wire schemas: https://github.com/openai/codex/tree/main/codex-rs/hooks/schema/generated

### 2.3 Consequence for architecture

Hooks alone **cannot** kill a session or spawn a new one. Therefore fully-automatic mode requires a **wrapper process** that owns the agent CLI as a child (PTY). Hooks are still used for what they're good at: context injection on start, blocking Claude's auto-compact, and signaling state to the wrapper via files.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────┐
│ batonpass CLI (wrapper, node-pty)                            │
│  • spawns agent CLI in PTY, proxies stdin/stdout to user │
│  • watches usage (statusline file / rollout JSONL)       │
│  • at threshold + turn-idle: injects handoff prompt      │
│  • waits for artifact → kills child → respawns fresh     │
└───────────────┬─────────────────────────────────────────┘
                │ reads/writes
        ┌───────▼────────┐        ┌──────────────────────┐
        │ .batonpass/ state  │◄───────┤ hooks (per adapter)   │
        │  state.json    │        │  SessionStart: inject │
        │  handoffs/*.md │        │  PreCompact: block    │
        │  usage.json    │        │  Stop: idle signal    │
        └────────────────┘        └──────────────────────┘
```

### 3.1 Monorepo layout (pnpm workspaces)

```
batonpass/
├── package.json  pnpm-workspace.yaml  tsconfig.base.json
├── .github/workflows/ci.yml  release.yml
├── packages/
│   ├── core/                 # @batonpass/core
│   │   └── src/
│   │       ├── schema.ts         # zod schema for handoff artifact
│   │       ├── artifact.ts       # read/write/validate/render md↔json
│   │       ├── state.ts          # .batonpass/ dir management, state.json
│   │       ├── prompts.ts        # handoff-generation & resume prompt templates
│   │       └── usage/
│   │           ├── types.ts      # UsageSource interface { getUsage(): {pct, tokens, max} }
│   │           ├── claude.ts     # statusline-file + transcript JSONL parser
│   │           └── codex.ts      # rollout JSONL token-count parser
│   ├── adapter-claude-code/  # @batonpass/adapter-claude-code — ships the CC plugin
│   │   ├── plugin/
│   │   │   ├── .claude-plugin/plugin.json
│   │   │   ├── hooks/hooks.json          # SessionStart, PreCompact, Stop, SessionEnd
│   │   │   ├── commands/handoff.md       # /handoff manual trigger
│   │   │   └── scripts/*.mjs             # hook entrypoints (node, no deps beyond core)
│   │   └── src/index.ts                  # Adapter impl (spawn cmd, install, paths)
│   ├── adapter-codex/        # @batonpass/adapter-codex
│   │   └── src/index.ts + hooks/ (hooks.json template + scripts)
│   └── cli/                  # batonpass (published bin)
│       └── src/
│           ├── index.ts          # commander: run, init, status, handoffs, doctor
│           ├── orchestrator.ts   # PTY lifecycle state machine
│           ├── pty.ts            # node-pty wrapper, output ring buffer
│           └── adapters.ts       # registry: claude-code | codex
├── docs/  (spec.md = handoff format spec, adapters.md = how to write one)
└── examples/
```

### 3.2 Adapter interface (`@batonpass/core`)

```ts
interface Adapter {
  id: 'claude-code' | 'codex';
  detectInstalled(): Promise<boolean>;
  install(scope: 'user' | 'project'): Promise<void>;   // write hooks/plugin config
  spawnCommand(opts: { cwd: string }): { cmd: string; args: string[] };
  usageSource(session: SessionRef): UsageSource;
  isTurnIdle(session: SessionRef): Promise<boolean>;    // Stop-hook marker file or transcript mtime quiescence
  injectHandoffPrompt(pty: Pty, artifactPath: string): Promise<void>; // types prompt + \r into PTY
  resumeInjection(): 'session-start-hook';               // both v1 adapters inject via SessionStart
}
```

---

## 4. The handoff artifact (core IP — get this right first)

One handoff = one directory entry: `.batonpass/handoffs/<seq>-<timestamp>/` containing `handoff.md` (agent-written, human-readable) + `handoff.json` (metadata, machine-written).

### 4.1 `handoff.json` (zod-validated)

```json
{
  "version": "1",
  "seq": 3,
  "tool": "claude-code",
  "sessionId": "…",
  "createdAt": "2026-07-11T12:00:00Z",
  "cwd": "/path/to/repo",
  "gitHead": "abc123",
  "gitDirty": true,
  "contextPctAtHandoff": 76,
  "previousHandoff": "2-…",
  "status": "consumed" 
}
```

### 4.2 `handoff.md` — required sections (spec in `docs/spec.md`)

```md
# Handoff <seq>
## Objective            — the overall task, in one paragraph. Copy from previous handoff unless changed.
## Current state        — what is DONE and verified vs. in-progress. Concrete.
## Next steps           — ordered list; first item = exactly what to do next, with file paths.
## Key decisions        — decisions made + WHY (so the next session doesn't relitigate).
## Files touched        — path → one-line role/change description.
## Gotchas & constraints— traps discovered, things that look wrong but are intentional, env quirks.
## Verification         — commands to run to confirm current state (tests, build, lint).
## Do NOT               — explicit anti-instructions (don't refactor X, don't touch Y).
```

### 4.3 Prompt templates (`core/src/prompts.ts`)

- **`handoffPrompt(artifactPath, spec)`** — injected into the dying session: "Context is nearly full. Stop current work at a safe point. Write a handoff document to `<path>` following this exact template: … Be specific; the next session has ZERO memory of this conversation. When written, reply only with `HANDOFF_WRITTEN`."
- **`resumePrompt(handoffMd)`** — injected into the new session via SessionStart: "You are continuing prior work via a handoff (below). Read it fully, run the Verification commands, then begin at Next steps item 1. Full history: `.batonpass/handoffs/`. <handoff.md content>"

---

## 5. Orchestrator (fully automatic mode) — `batonpass run <agent>`

State machine in `cli/src/orchestrator.ts`:

```
IDLE → SPAWN → MONITOR → (usage ≥ threshold) → AWAIT_TURN_IDLE
     → INJECT_HANDOFF_PROMPT → AWAIT_ARTIFACT (timeout 5m)
     → VALIDATE_ARTIFACT → GRACEFUL_KILL → SPAWN (fresh, hook injects handoff) → MONITOR …
```

Details:

- **PTY:** `node-pty`. Proxy user keystrokes ↔ child; keep a ring buffer of recent output for turn-idle heuristics and the `HANDOFF_WRITTEN` sentinel. Resize passthrough (SIGWINCH).
- **Usage monitoring (poll every 5s):**
  - *Claude Code:* Batonpass's statusline command (installed by adapter) writes `{pct, tokens}` to `.batonpass/usage.json` on every statusline refresh — primary source. Fallback: parse the newest transcript JSONL usage fields directly.
  - *Codex:* tail the rollout JSONL, read token-count events; pct = tokens / model context size (model map in core, overridable in config).
- **Turn-idle detection:** never inject mid-turn. Primary: Stop hook writes `.batonpass/turn-idle` marker (both tools have Stop hooks). Fallback: transcript file mtime unchanged for N seconds + PTY output quiescent.
- **Injection:** write handoff prompt into PTY as if typed, plus `\r`. Wait for artifact file + `HANDOFF_WRITTEN` in output. Validate with zod + required-section check; on failure, retry once with corrective prompt, else fall back to semi-auto (print instructions, keep session alive) — never destroy a session without a valid artifact.
- **Kill & respawn:** for Claude Code send `/exit\r`, for Codex `ctrl-d`; escalate SIGTERM→SIGKILL after grace. Set `state.json.pendingHandoff = <seq>`; on respawn, the SessionStart hook (source=startup) sees `pendingHandoff`, emits `additionalContext` with the resume prompt, then clears the flag. This decouples injection from CLI flag quirks.
- **Belt-and-braces (Claude Code):** PreCompact hook exits 2 on `trigger: "auto"` **only when** orchestrator is active (checks `state.json.orchestratorPid` alive), and writes `.batonpass/compact-blocked` so the orchestrator can trigger handoff immediately even if polling missed the threshold. When Batonpass isn't running, hook exits 0 — never break vanilla usage.
- **Config:** `.batonpass/config.json` + `~/.config/batonpass/config.json` (project overrides user): `threshold` (default 0.75), `pollIntervalMs`, `idleQuietMs`, `handoffTimeoutMs`, `maxChainedHandoffs` (default ∞), per-agent binary path, model context-size overrides.

### CLI commands

- `batonpass run claude|codex [-- <agent args>]` — the wrapper (main entry).
- `batonpass init [--agent claude|codex|all] [--project|--user]` — install hooks/plugin/statusline, write config, gitignore `.batonpass/`.
- `batonpass status` — current session, usage %, handoff count.
- `batonpass handoffs [show <seq>]` — list/inspect history.
- `batonpass doctor` — verify agent binaries, hook installation, feature flags (e.g. Codex `codex_hooks = true`), Windows warning.

---

## 6. Implementation phases

Each phase ends green: `pnpm build && pnpm test && pnpm lint`.

### Phase 0 — Scaffold (½ day)
pnpm workspaces, TypeScript strict, tsup builds, vitest, eslint+prettier, changesets, GitHub Actions CI (build+test on node 20/22, macOS+Linux). MIT license. Placeholder README.

### Phase 1 — `@batonpass/core` (1–2 days)
Schema (zod), artifact read/write/validate/render, state dir management with atomic writes (write-tmp-rename), prompt templates, usage parsers for both transcript formats **with fixture files** (grab real JSONL samples from local `~/.claude/projects` and `~/.codex/sessions` early; commit sanitized fixtures).
**Accept:** 90%+ coverage on core; parsers handle truncated/mid-write JSONL lines without throwing.

### Phase 2 — Claude Code adapter (2–3 days)
Plugin (manifest, hooks.json, hook scripts, `/handoff` command, statusline command that both renders usage and writes `.batonpass/usage.json`), `install()` for user & project scope, respecting existing user statusline (chain it: run existing command, append usage write).
**Accept:** manual e2e — `batonpass init --agent claude`, run vanilla `claude`, `/handoff` produces valid artifact; new session auto-receives context via SessionStart; PreCompact block verified with orchestrator marker present/absent.

### Phase 3 — Orchestrator + `batonpass run claude` (3–5 days, hardest)
node-pty wrapper, state machine, usage polling, idle detection, injection, validation, respawn, crash recovery (on start: if `state.json` shows dead orchestrator + unconsumed artifact → offer resume). Handle: user typing during injection (queue user input while injecting), terminal resize, agent crash mid-handoff, artifact timeout.
**Accept:** scripted e2e using a **fake agent** (small node REPL that mimics transcript writing + responds to the handoff prompt) proving 3 chained automatic handoffs; manual e2e with real Claude Code on a long task.

### Phase 4 — Codex adapter (2–3 days)
hooks.json generation, `codex_hooks` feature-flag setup in `doctor`/`init` (prompt user before editing config.toml), rollout JSONL usage source, Stop-hook idle marker, SessionStart injection, spawn/kill specifics.
**Accept:** same e2e matrix as Phase 2/3 against real Codex CLI. Document hook experimental status prominently.

### Phase 5 — Hardening (2–3 days)
Concurrency (two sessions same repo → lock file), huge transcripts (stream, don't slurp), non-git dirs, chained-handoff drift test (does Objective survive 5 handoffs verbatim?), Windows: Claude Code path works, Codex cleanly refuses with message. Security pass: hook scripts are dependency-free, no shell interpolation of untrusted transcript content, artifact paths sanitized.

### Phase 6 — Docs & release (1–2 days)
README (the pitch: problem → 60-sec demo GIF → quickstart `npm i -g batonpass && batonpass init && batonpass run claude`), `docs/spec.md` (format spec versioned separately — this is the standard others adopt), `docs/adapters.md` (how to contribute an adapter — explicitly invite OpenClaw/Hermes/OpenCode adapters), CONTRIBUTING, changesets-driven npm publish workflow, v0.1.0 tag.

**Total: ~12–18 dev-days.**

---

## 7. Testing strategy

- **Unit:** core schema/parsers/prompts (vitest, fixtures).
- **Integration:** hook scripts invoked with recorded stdin payloads (fixtures per event per tool); assert stdout JSON/exit codes.
- **E2E (fake agent):** deterministic CI-safe orchestrator tests — fake agent binary simulates transcript growth and handoff compliance, including a non-compliant variant (never writes artifact → assert graceful fallback).
- **E2E (real, manual + nightly optional):** checklist in `docs/testing.md` run before each release against current Claude Code & Codex versions — both CLIs move fast; version pin matrix in README.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| CLIs change hook APIs/flags (both evolve fast) | Adapter isolation; `doctor` checks versions; CI matrix; pin "tested-with" versions in README |
| Codex hooks experimental / may break | Feature-flag guarded; semi-auto fallback (print resume command) always works; document status |
| PTY injection races with user typing | Input queueing during INJECT state + visual banner line in terminal ("⚡ batonpass: writing handoff…") |
| Agent writes poor handoff | Strict template + validation + one retry; `/handoff` sentinel; quality drifts → spec iteration is the product |
| `claude "<prompt>"` behavior differs from research | Resume path doesn't depend on it (SessionStart hook injection); verify in Phase 2 |
| Killing session loses in-flight work | Only kill after validated artifact + turn-idle; never on timeout |

---

## 9. Notes for the implementing agent

- Re-verify §2 facts against live docs before Phase 2/4 — treat this plan's facts as of 2026-07-11.
- Keep hook scripts **zero-dependency** plain node (`.mjs`) — they run in users' environments; bundle any core logic they need via tsup into the script files.
- Never modify user config destructively: back up before editing `config.toml`/settings, and make `batonpass init --uninstall` a real command.
- Commit after every phase; keep PLAN.md updated with a `## Progress` log appended at the bottom.


---

## Progress

### 2026-07-11 — Phase 0
- Naming: bare `batonpass` package name is taken on npm (published placeholder, v0.0.0); `batonpass-cli` and `handoff-kit` also taken. `batonpass` and `relayctl` were free. Chose: internal workspace packages scoped `@batonpass/*`, published CLI package `batonpass` with bin `batonpass` (confirmed both `@batonpass/core` and `batonpass` unclaimed on the registry).
- Scaffolded pnpm workspace monorepo: packages/{core,adapter-claude-code,adapter-codex,cli}, tsconfig.base.json (strict), tsup per package, vitest, eslint+typescript-eslint, prettier, changesets config, GitHub Actions CI (ubuntu+macos x node 20/22) + release workflow, MIT license.
- Note: could not rename the project's outer folder (host-side bind mount, `mv` returns "Device or resource busy" from inside the sandbox) — user will rename manually.

### 2026-07-11 — Phase 1
- Implemented `@batonpass/core`: zod schemas (handoff.json, state.json, config), artifact read/write/validate/render (md<->structured, atomic writes), `.batonpass/` state dir mgmt incl. advisory lock file with stale-PID reclaim, prompt templates (handoffPrompt/resumePrompt/correctivePrompt), usage parsers for Claude Code transcripts and Codex rollout JSONL (both tolerant of truncated trailing lines).
- 48 tests, 93% statement coverage, build/lint green.

### 2026-07-11 — §2.1 re-verification (before Phase 2)
Checked against current code.claude.com/docs via live fetch (not training memory):
- Hook exit codes (0 allow / 2 block), event names (SessionStart w/ source startup|resume|clear|compact, SessionEnd, PreCompact w/ trigger manual|auto, Stop, UserPromptSubmit): confirmed accurate, unchanged.
- SessionStart injection schema confirmed: `{"hookSpecificOutput":{"additionalContext":"..."}}`, capped at 10,000 chars, injected as a system reminder (new detail not in original plan — Batonpass must keep resume prompts under that cap, truncating/summarizing the handoff if needed).
- PreCompact exit-2 blocking confirmed.
- Statusline stdin JSON confirmed to include `context_window.used_percentage` and `context_window.context_window_size` as originally assumed, plus `current_usage` token counts and `model.display_name`; other hook events still do NOT carry token counts.
- Transcript path format confirmed: `~/.claude/projects/<slugified-cwd>/<session-id>.jsonl`, non-alphanumeric -> `-`; assistant `usage` fields confirmed.
- `claude "<prompt>"` confirmed to be genuinely interactive-with-initial-prompt (not one-shot) on current CLI — Batonpass's design still prefers SessionStart-hook injection as the resume path since it's decoupled from this CLI-flag behavior, but this is no longer a documented risk.
- Plugin packaging (`.claude-plugin/plugin.json`, bundled hooks/commands/statusline) confirmed.
- New implementation constraint adopted: additionalContext has a 10k char cap, so `resumePrompt()` callers must truncate/summarize oversized handoff.md content before injection (tracked as a Phase 2 task).

### 2026-07-11 — Phase 2
- Added `Adapter`/`SessionRef`/`PtyLike` interfaces to `@batonpass/core` (packages/core/src/adapter.ts) so both adapter packages + the CLI share one contract.
- Implemented `@batonpass/adapter-claude-code`: zero-dependency hook scripts (session-start, pre-compact, stop, session-end, statusline) under `plugin/scripts/`, a `/handoff` slash command doc, a `.claude-plugin/plugin.json` manifest for marketplace-style installs, and a direct `install()`/`uninstall()` path that merges hook + statusline entries straight into `~/.claude/settings.json` (user scope) or `<project>/.claude/settings.json` (project scope) — idempotent, backs up settings.json before every write, chains any pre-existing statusline command via `BATON_CHAIN_STATUSLINE_COMMAND`, and only touches `.gitignore` inside an actual git repo.
- Discovered during §2.1 re-verification that `additionalContext` is capped at 10,000 chars — `session-start.mjs` now truncates (head+tail, keeping Objective/Next-steps ends) with a visible truncation marker when a handoff.md exceeds the cap, and there's a test proving this.
- 33 tests (hook scripts invoked as real child processes with recorded stdin fixtures; settings-merge unit tests; adapter install/uninstall/idempotency tests), build/lint green.
- **Known gap:** no live e2e against the real `claude` CLI (this environment has no interactive terminal/Claude Code install to drive) — `batonpass init --agent claude` + a real session should be smoke-tested manually before relying on this in production, per the plan's own Phase 2 acceptance criteria.

### 2026-07-11 — Phase 3
- Implemented `Orchestrator` (packages/cli/src/orchestrator.ts): full state machine (SPAWN → MONITOR → AWAIT_TURN_IDLE → INJECT_HANDOFF_PROMPT → AWAIT_ARTIFACT → VALIDATE_ARTIFACT → GRACEFUL_KILL → respawn), advisory lock via core's stale-PID-aware lock file, one corrective retry on invalid artifacts before falling back to a non-destructive semi-auto mode (never kills without a validated artifact on disk), input queueing during injection, graceful-then-SIGTERM-then-SIGKILL child shutdown.
- `pty.ts`: thin node-pty wrapper + bounded ring buffer for sentinel detection. node-pty compiled natively in this sandbox (native module, arm64 linux).
- Built `examples/fake-agent/fake-agent.mjs`: a deterministic stand-in CLI (climbs a simulated context %, responds to the handoff prompt by writing a real handoff.md+json, understands `/exit`) plus a `FakeAdapter` — used for a genuine PTY-backed e2e test (not mocked): `orchestrator.e2e.test.ts` proves 3 fully automatic chained handoffs end-to-end in ~3s, plus a lock-file exclusivity test.
- Bug caught and fixed during e2e debugging: fake-agent.mjs crashed instantly on every spawn (`process.on('SIGKILL', ...)` throws `EINVAL` — SIGKILL cannot be intercepted in Node) — removed that listener.
- Added `@batonpass/adapter-codex` as a throwing placeholder (every Adapter method throws "Phase 4") purely so the CLI's adapter registry and `packages/cli` could build/test in Phase 3 without forward-implementing Codex; replaced properly in Phase 4 below.
- `batonpass` CLI (`packages/cli/src/index.ts`, commander): `run <agent>`, `init [--agent] [--project|--user] [--uninstall]`, `status`, `handoffs [show <seq>]`, `doctor`.
- 86 tests total across the repo, build/test/lint all green.
- **Known gap:** e2e only exercises the fake agent — no run yet against the real `claude` CLI (see Phase 2's known gap; same caveat applies here, now compounded — the orchestrator's PTY-driven typing of the handoff prompt has a known theoretical risk worth flagging: Linux TTY canonical-mode line discipline caps a single input line at `MAX_CANON` (4096 bytes); Batonpass's prompt lines are all well under that today, but this is worth a regression test if the template grows.

### 2026-07-11 — §2.2 re-verification (before Phase 4)
Fetched https://developers.openai.com/codex/hooks directly (live page, not training memory or a subagent's secondhand summary — a first-pass subagent report contradicted the plan on several points and turned out to be wrong on the ones that mattered most, so these are from my own direct fetch):
- Hooks **are** experimental, **are** gated behind `[features] codex_hooks = true` in `config.toml`, and **are** currently disabled on Windows — plan's original claims confirmed accurate, unchanged. (A first draft of this re-verification, done via a subagent, claimed the opposite on all three points; re-fetching the live doc myself showed the subagent was wrong — treating that report as suspect and re-checking primary sources directly was the right call.)
- `SessionStart` matcher values are **only** `startup` and `resume` today (not `clear`/`compact` as originally guessed in the plan, nor `startup|resume|clear|compact` as CC uses) — corrected.
- `PreToolUse`/`PostToolUse` matcher is on `tool_name`, and **the current runtime only ever emits `Bash`** — plan's "Bash only" claim confirmed.
- Common input fields confirmed: `session_id`, `transcript_path` (nullable), `cwd`, `hook_event_name`, `model`; turn-scoped events additionally get `turn_id`.
- `SessionStart` output schema confirmed: plain stdout text OR `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}`. No documented character cap (unlike Claude Code's 10,000) — Batonpass will still defensively truncate to the same 10k budget out of caution since none is documented either way.
- `Stop` fields confirmed: `turn_id`, `stop_hook_active`, `last_assistant_message`. Returning `{"decision":"block","reason":"..."}` (or exit 2 + stderr) makes Codex auto-continue using `reason` as the next prompt — Batonpass's `stop.mjs` must exit 0 with no output so it only marks turn-idle without accidentally forcing continuations.
- **No `PreCompact`/`PostCompact` hook events are documented on the current live hooks page** — despite GitHub issue/schema activity suggesting something is in progress (an open feature-request issue *and* conflicting claims of a schema-level `PreCompact` property both turned up in search), nothing is shipped in the documented CLI today. Decision: Batonpass's v1 Codex adapter will NOT depend on any compaction-block hook — same conservative posture as the original plan ("no PreCompact equivalent, Batonpass must beat Codex's own threshold"). Revisit in a future release if/when this ships.
- `codex resume [SESSION_ID|--last] [--all]` (interactive) / `codex exec resume [SESSION_ID|--last] [--all]` (headless) confirmed via the live CLI reference page.
- Rollout-file path/shape (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, token-count events) is not on either docs page (implementation detail) — kept as documented in Phase 1, corroborated independently, lower confidence than the hook facts above but unchanged from the original plan.

### 2026-07-11 — Phase 4
- Implemented `@batonpass/adapter-codex` for real (replacing the Phase 3 placeholder): zero-dependency `session-start.mjs`/`stop.mjs` hook scripts matching Codex's exact confirmed schemas (`hookSpecificOutput.additionalContext` for SessionStart; `stop.mjs` deliberately emits nothing and exits 0 so it can never trigger Codex's Stop-hook continuation mechanism), `hooks.json` merge logic (`SessionStart` matcher `startup|resume`, `Stop` unmatched — matches current runtime), and a minimal dependency-free `config.toml` text editor that flips exactly one key (`[features]\ncodex_hooks = true`), always backing up first and never touching anything else in the file.
- No PreCompact/PostCompact hook is used (per §2.2 re-verification: not shipped in the documented CLI today) — this adapter relies purely on usage-threshold polling of the rollout JSONL plus the Stop-hook idle marker, same as the original plan's conservative design.
- Added `findLatestRolloutForCwd` (packages/adapter-codex/src/rollout.ts): `~/.codex/sessions/` is shared across every project (unlike Claude Code's per-project `~/.claude/projects/<slug>/`), so usage polling now filters rollout files by the `cwd` recorded in each rollout's `session_meta` line, falling back to "most recent overall" if that metadata can't be read.
- `install()` throws a clear error on win32 instead of silently no-oping (hooks are confirmed disabled on Windows for Codex). `uninstall()` removes Batonpass's hooks.json entries but deliberately leaves `codex_hooks` enabled in config.toml, since other tools may depend on that flag.
- 37 new tests (config.toml text-editing edge cases, hooks.json merge/idempotency/removal, hook scripts as real child processes, adapter install/uninstall/Windows-guard/cwd-scoped usage). Repo-wide: 122 tests, build/lint green.

### 2026-07-11 — Phase 5
- **Streaming for huge transcripts:** `lastAssistantUsageLine`/`lastTokenCountEvent` previously slurped the entire transcript/rollout file on every poll. Replaced with `readTailUntil` (packages/core/src/usage/tail.ts): reads only a bounded tail window (default 256KiB, doubling up to an 8MiB hard cap) via `fs.open`/`read` at an offset, never loading a multi-GB session file into memory. Verified with synthetic multi-MB fixtures in both usage-source test suites plus dedicated `tail.test.ts` covering window growth, exhaustion, and the empty/nonexistent-file edge cases.
- **Path-traversal hardening:** added `isSafeHandoffDirName` (core `artifact.ts`, plus a duplicated zero-dependency copy in both adapters' `_lib.mjs`, consistent with the "hook scripts stay dependency-free" constraint) and wired it into both `session-start.mjs` scripts — a malformed/tampered `state.json.pendingHandoff` value (e.g. `../../secret`) is now refused before it's ever joined into a filesystem path, instead of trusting it blindly. Regression tests added in both adapters proving traversal attempts are rejected (exit 0, no injection, stderr note) rather than silently reading outside `.batonpass/handoffs/`.
- **Shell-interpolation review:** audited every hook script and the orchestrator for places that build a shell command string from untrusted input (transcript content, stdin JSON fields). Found none — the one place a shell command is built dynamically (`statusline.mjs` chaining a pre-existing user statusline command) only ever embeds a command the user themselves already had configured, not agent/transcript-derived content.
- **Chained-handoff drift test:** added `chained-handoff-drift.test.ts` — writes/reads 5 sequential handoffs, carrying the Objective section forward verbatim each time (mirroring the prompt's "copy from the previous handoff unless it changed" instruction), asserting byte-for-byte identity through Batonpass's own write→read→re-render plumbing (including emoji, em-dash, code spans, and irregular internal spacing). This tests our serialization layer's fidelity, not agent behavior (which isn't unit-testable) — a known limitation worth documenting: a handoff body containing a literal `## ` at the start of a line would be misparsed as a new section boundary by `parseHandoffMd`'s current regex-based approach; noted in docs/spec.md rather than fixed now, since it requires normal agent-authored prose to avoid, and a fully robust fix would need a real markdown-aware parser.
- **Concurrency / lock file:** already covered by Phase 3's orchestrator lock test (second concurrent orchestrator on the same project is rejected).
- **Non-git dirs:** already covered by Phase 2's adapter test (`.gitignore` only touched inside an actual git repo).
- **Windows:** Codex adapter throws a clear error on win32 instead of silently no-oping (tested). Claude Code adapter code was reviewed for platform-unsafe assumptions (path separators, shell quoting) and found clean, but could not be executed on real Windows from this Linux sandbox — flagged as a manual-verification gap, consistent with the CI matrix (Phase 0) only covering ubuntu + macOS.
- Repo-wide: 136 tests, build/lint green.

### 2026-07-11 — Phase 6
- Wrote `README.md` (pitch, architecture diagram, command table, package layout, quickstart — marked "not yet published to npm"), `docs/spec.md` (versioned handoff-format spec: directory layout, `handoff.json` field table, required `handoff.md` sections, the documented section-header-collision limitation, resume-injection mechanics, a short security section), `docs/adapters.md` (the `Adapter` interface contract method-by-method, the zero-dependency-hooks constraint, an explicit call to re-verify platform facts against live docs before trusting cached/secondhand information — referencing the §2.2 subagent-was-wrong incident as the concrete example — and the two required testing patterns for a new adapter), `docs/testing.md` (automated vs. manual-verification status, with an explicit pre-release checklist against real `claude`/`codex`), and `CONTRIBUTING.md` (setup, repo layout, changesets workflow, how to report hook/CLI drift).
- Did **not** run `changeset publish` / `npm publish` — no npm credentials or intent to publish from this sandboxed session; the changesets-driven release workflow (`.github/workflows/release.yml`, Phase 0) is wired and ready for whenever a maintainer chooses to publish.
- Full repo: 136 tests, build/lint green.

## Summary of what's real vs. what still needs manual work

**Fully implemented and automatically tested:** handoff schema/validation/artifact I/O, `.batonpass/` state management with atomic writes and a stale-PID-aware lock, prompt templates, usage parsers for both tools (bounded-tail, won't slurp huge files), both adapters' hook scripts and install/uninstall logic, the full orchestrator state machine (proven via a real-PTY fake-agent e2e test doing 3 chained automatic handoffs), path-traversal and shell-injection hardening, a chained-handoff serialization-fidelity test, monorepo tooling (pnpm workspaces, tsup, vitest, eslint/prettier, changesets, GitHub Actions CI+release workflows).

**Not done / needs a human before shipping:** no run against the real `claude` or `codex` binaries (this sandbox has neither installed nor authenticated) — see docs/testing.md's manual checklist; no real Windows execution (Codex's Windows-refusal is tested, Claude Code's Windows path is only reviewed, not run); no npm publish; the Codex PreCompact/PostCompact question (§2.2 notes conflicting GitHub signals about whether this has shipped) is worth re-checking against whatever Codex CLI version is current at release time, since a native compaction-block hook would let that adapter behave more like Claude Code's.

### 2026-07-11 — Final sync + verification
- Synced the full source tree (excluding `node_modules`, `dist`, `.git`, `coverage`, build caches) from the build sandbox into the project's actual folder on disk.
- Verified from scratch: extracted a fresh copy of that synced tree into an isolated directory, ran `pnpm install --frozen-lockfile && pnpm build && pnpm test && pnpm lint` there (not in the original working copy) — 136 tests passed, all 4 packages built, lint clean. This confirms nothing was lost or left implicitly dependent on sandbox-only state during the sync.
- Reminder for whoever picks this up next: rename the outer project folder (still called `tochangename` — could not be renamed from within the agent sandbox, see Phase 0 notes) and work through docs/testing.md's manual checklist against real `claude`/`codex` CLIs before any release.
