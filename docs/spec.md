# Batonpass handoff format — spec v1

This document describes the on-disk handoff format, independent of any
particular CLI or adapter. It's versioned separately from the `batonpass` tool
itself (`handoff.json.version`) so other tools can read/write it without
depending on this repo.

## Layout

```
<project>/.batonpass/
├── state.json
├── config.json            (optional, project overrides)
├── usage.json              (Claude Code only — written by the statusline chain)
├── turn-idle                (written by the Stop-equivalent hook)
├── compact-blocked          (Claude Code only — written by PreCompact when blocked)
├── orchestrator.lock        (advisory: PID of the running orchestrator)
└── handoffs/
    └── <seq>-<ISO-8601 timestamp, `:`/`.` -> `-`>/
        ├── handoff.md
        └── handoff.json
```

One handoff = one directory under `handoffs/`. Directory names must match
`^\d+-[A-Za-z0-9_-]+$` (a plain numeric sequence, a dash, then a
filesystem-safe timestamp) — nothing else is treated as trusted input when
constructing paths from a stored `pendingHandoff` value (see the Security
section below).

## `handoff.json`

Machine-written, zod-validated (`HandoffJsonSchema` in
`packages/core/src/schema.ts`):

```json
{
  "version": "1",
  "seq": 3,
  "tool": "claude-code",
  "sessionId": "…",
  "createdAt": "2026-07-11T12:00:00.000Z",
  "cwd": "/path/to/repo",
  "gitHead": "abc123",
  "gitDirty": true,
  "contextPctAtHandoff": 76,
  "previousHandoff": "2-2026-07-11T11-45-00-000Z",
  "status": "pending"
}
```

| Field | Type | Notes |
|---|---|---|
| `version` | `"1"` | Bump this if the shape changes incompatibly. |
| `seq` | integer ≥ 0 | Monotonically increasing per project. |
| `tool` | `"claude-code" \| "codex"` | Which adapter produced this. |
| `sessionId` | string | The dying session's ID, or `"manual"` for a `/handoff`-triggered one. |
| `createdAt` | ISO-8601 datetime | Used to derive the directory's timestamp suffix. |
| `cwd` | string | Absolute path. |
| `gitHead` | string \| null | `git rev-parse HEAD`, or `null` outside a git repo. |
| `gitDirty` | boolean | From `git status --porcelain`. |
| `contextPctAtHandoff` | number 0–200 | Best-effort estimate; not authoritative. |
| `previousHandoff` | string \| null | Directory name of the prior handoff in the chain, if any. |
| `status` | `"pending" \| "consumed" \| "stale"` | Lifecycle marker (currently only `pending` is set by v1; `consumed`/`stale` are reserved for future garbage-collection tooling). |

## `handoff.md`

Human-readable, agent-written. Required sections (`REQUIRED_SECTIONS` in
`packages/core/src/schema.ts`), as level-2 markdown headers, in this exact
order and spelling:

```md
# Handoff <seq>

## Objective
## Current state
## Next steps
## Key decisions
## Files touched
## Gotchas & constraints
## Verification
## Do NOT
```

Guidance for what belongs in each section lives in the prompt templates
(`packages/core/src/prompts.ts`) — the short version:

- **Objective** — the overall task, one paragraph. Copied from the previous
  handoff unless it changed.
- **Current state** — DONE vs. in-progress, concretely.
- **Next steps** — ordered list; item 1 is the exact next action with file paths.
- **Key decisions** — decisions + WHY, so the next session doesn't relitigate them.
- **Files touched** — `path -> one-line description`.
- **Gotchas & constraints** — traps, intentional-looking mistakes, env quirks.
- **Verification** — exact commands to confirm current state (tests/build/lint).
- **Do NOT** — explicit anti-instructions for the next session.

A handoff is only considered valid if every required section is present and
non-empty (`validateHandoffMd`) — Batonpass retries once with a corrective prompt
if not, then falls back to a non-destructive semi-auto mode rather than ever
killing a session without a valid artifact.

### Known limitation: section-header collision

`parseHandoffMd` finds section boundaries with a regex matching lines starting
with `## `. If a section's *body* text itself contains a line starting with
`## ` (e.g. the agent quotes markdown from elsewhere), that line will be
misread as a new section boundary. In practice this hasn't come up (the
prompt template asks for prose, not quoted markdown), but a future version of
this spec could move to a less ambiguous delimiter (e.g. HTML comments as
section markers) if it becomes a real problem.

## Resume injection

Both adapters deliver a handoff to the next session the same way: `.batonpass/state.json.pendingHandoff`
is set to the handoff's directory name right before the old session is killed;
the new session's `SessionStart`-equivalent hook reads it, injects the
handoff's content as additional context, and clears the field. See
`docs/adapters.md` for the exact per-tool hook schema.

Both known adapters cap injected context defensively at 10,000 characters
(Claude Code documents this cap explicitly; Codex doesn't document one, but
Batonpass applies the same budget out of caution) — an oversized `handoff.md` is
truncated (keeping the head and tail, with a visible truncation marker) rather
than silently dropped or rejected.

## Security

- Directory names derived from `pendingHandoff` are validated against
  `^\d+-[A-Za-z0-9_-]+$` before being joined into a filesystem path, in both
  the orchestrator and every hook script — a malformed or tampered value is
  refused rather than trusted.
- Hook scripts are zero-dependency plain Node (`.mjs`, only `node:*` builtins)
  so they don't require `node_modules` to be present/correct wherever they're
  copied.
- No hook script or orchestrator code builds a shell command string from
  transcript/agent-generated content; see PLAN.md's Phase 5 progress notes for
  the specific audit.
