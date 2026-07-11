---
"@batonpass/adapter-claude-code": patch
"batonpass": patch
---

`batonpass init --agent claude` now pre-authorizes the agent to write its handoff artifact, so unattended handoffs don't stall on a file-write approval prompt. `init` adds narrowly-scoped `Write(.batonpass/**)` and `Edit(.batonpass/**)` rules to `settings.json`'s `permissions.allow` (idempotent, preserving any existing rules), and `--uninstall` removes exactly those rules. Without this, the automatic handoff cycle would block on Claude Code's write-permission dialog at the moment it tries to save the handoff — defeating the point of unattended operation.
