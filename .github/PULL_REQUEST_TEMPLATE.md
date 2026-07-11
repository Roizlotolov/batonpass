## What does this change?

<!-- One or two sentences. Link an issue if there is one. -->

## Which package(s)?

- [ ] `@batonpass/core`
- [ ] `@batonpass/adapter-claude-code`
- [ ] `@batonpass/adapter-codex`
- [ ] `batonpass` (CLI / orchestrator)
- [ ] `docs/spec.md` (handoff format)

## Checklist

- [ ] `pnpm build && pnpm test && pnpm lint` passes
- [ ] If this touches a hook script, there's a test invoking it as a **real child process** with a stdin fixture (see any `hooks.test.ts`) — not just unit tests of helpers
- [ ] If this changes the handoff format (`handoff.json` shape, `handoff.md` required sections, `.batonpass/` layout), `docs/spec.md` is updated to match and the spec version is bumped if the change is incompatible
- [ ] Any claim about Claude Code's or Codex CLI's hook/session behavior is re-verified against that CLI's **current live docs** (both hook systems are marked experimental upstream), with a note of what was checked
- [ ] A [changeset](https://github.com/changesets/changesets) is added (`pnpm changeset`) — no hand-edited versions or CHANGELOGs
