---
description: Manually write a Batonpass handoff document for the current session.
---

Context is being handed off deliberately (manually triggered, not automatic).

First, determine the next handoff sequence number and path:
1. Run: `ls .batonpass/handoffs 2>/dev/null | sed -E 's/^([0-9]+)-.*/\1/' | sort -n | tail -1` to find the highest existing seq (empty output means none yet, so next seq = 1; otherwise next seq = highest + 1).
2. The target path is `.batonpass/handoffs/<seq>-<ISO-8601 UTC timestamp with `:` and `.` replaced by `-`>/handoff.md`. Create the directory first.

Then write `handoff.md` at that path with exactly these section headers, in this order:

## Objective

## Current state

## Next steps

## Key decisions

## Files touched

## Gotchas & constraints

## Verification

## Do NOT

Guidance for each section:
- Objective: the overall task, one paragraph. Copy from the previous handoff (if any, under `.batonpass/handoffs/`) unless it changed.
- Current state: what is DONE and verified vs. still in-progress. Be concrete.
- Next steps: an ordered list; item 1 must be the exact next action, including file paths.
- Key decisions: decisions made and WHY, so the next session does not relitigate them.
- Files touched: path -> one-line description of the role/change.
- Gotchas & constraints: traps you found, things that look wrong but are intentional, environment quirks.
- Verification: exact commands to run to confirm the current state (tests, build, lint).
- Do NOT: explicit anti-instructions for the next session.

Also write a matching `handoff.json` next to it:

```json
{
  "version": "1",
  "seq": <seq>,
  "tool": "claude-code",
  "sessionId": "<current session id if known, else \"manual\">",
  "createdAt": "<ISO-8601 UTC timestamp used above>",
  "cwd": "<absolute cwd>",
  "gitHead": "<git rev-parse HEAD, or null if not a git repo>",
  "gitDirty": <true|false, from git status --porcelain>,
  "contextPctAtHandoff": <best estimate, or 0 if unknown>,
  "previousHandoff": "<previous handoff dir name, or null>",
  "status": "pending"
}
```

Be specific and exhaustive — a future session may rely on this document with zero memory of this conversation.
