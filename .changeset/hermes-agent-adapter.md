---
"@batonpass/core": minor
"batonpass": minor
---

Add support for Hermes Agent: a new `@batonpass/adapter-hermes` package (Python helper plugin + `config.yaml`/plugin-enable install logic), and a `'pty-type'` resume strategy in the orchestrator for CLIs with no context-injection hook — the orchestrator now types the resume instruction directly into the fresh session's PTY once it's ready, instead of relying on a `SessionStart`-equivalent hook.

Use `batonpass init --agent hermes --user` and `batonpass run hermes` (Hermes has no project-local config, so `--user` is required).
