---
"batonpass": patch
---

Fix `batonpass run <agent>` not forwarding the terminal to the wrapped agent CLI. The orchestrator spawned the agent in a PTY but the `run` command never bridged `process.stdin`/`process.stdout` to it, so an interactive user saw a blank screen and couldn't type. The command now forwards child output to stdout, the user's keystrokes to the child (via the orchestrator's existing `feedUserInput` gate, which queues input during handoff injection), and terminal resizes through to the PTY, restoring raw-mode/stdin state on exit. The automatic state machine already worked (proven by the fake-agent e2e, which drives the orchestrator directly); this was purely the missing human-interactive layer.
