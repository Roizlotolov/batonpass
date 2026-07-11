---
"@batonpass/core": patch
"batonpass": patch
---

Make the typed handoff/corrective prompts single-line so they actually submit in a real agent TUI. `handoffPrompt` and `correctivePrompt` are typed into the agent CLI followed by `\r`; a real TUI (Claude Code, verified) treats embedded newlines as newlines *within* the input box rather than a submit, so the previous multi-line prompts sat unsubmitted and the whole handoff cycle stalled. Both are now single-line (per-section guidance folded onto one line with `;` separators; the agent still writes the artifact file with real line breaks). Added a regression test asserting every typed prompt is newline-free, and updated the fake-agent e2e to read stdin in raw mode like a real TUI (canonical-mode readline silently drops single lines over `MAX_CANON`/1024 bytes on macOS, which these prompts can exceed).
