# Contributing to Batonpass

## Setup

```sh
pnpm install
pnpm build
pnpm test
pnpm lint
```

Node 20 or 22. `node-pty` (used by `packages/cli`) has a native addon —
`pnpm install` compiles it via `node-gyp`; if that fails, you're missing a
C++ toolchain (Xcode command line tools on macOS, `build-essential` on Linux).

## Repo layout

- `packages/core` — the tool-agnostic pieces: handoff schema/validation,
  `.batonpass/` state management, prompt templates, usage parsers.
- `packages/adapter-claude-code`, `packages/adapter-codex` — one adapter per
  supported agent CLI. See [docs/adapters.md](./docs/adapters.md) before
  adding a new one or changing an existing one.
- `packages/cli` — the `batonpass` binary: commander CLI + the orchestrator state
  machine.
- `examples/fake-agent` — deterministic stand-in CLI for e2e-testing the
  orchestrator without a real agent.
- `docs/` — `spec.md` (handoff format), `adapters.md` (adapter contract),
  `testing.md` (automated vs. manual-verification status).

## Before opening a PR

- `pnpm build && pnpm test && pnpm lint` must pass.
- If you touched a hook script, add/update a test that invokes it as a real
  child process with a stdin fixture (see any `hooks.test.ts`) — don't just
  unit-test helper functions in isolation.
- If you touched adapter facts about a specific CLI's hook/session behavior,
  re-verify against that CLI's current live docs (not cached knowledge) and
  note what you checked, similar to PLAN.md's "re-verify §2" log entries.
- Add a [changeset](https://github.com/changesets/changesets):

  ```sh
  pnpm changeset
  ```

  Pick the affected package(s) and a semver bump. This is what drives the
  release PR — CI opens/updates a "Version Packages" PR from accumulated
  changesets, and merging that PR is what actually publishes to npm (see
  `.github/workflows/release.yml`). Regular feature/fix PRs should never
  need to bump versions or edit CHANGELOGs by hand.

## Reporting hook/CLI drift

Both Claude Code and Codex CLI hook systems are explicitly marked
experimental upstream and change between versions. If something in an
adapter stops matching reality, please include: the exact CLI version, the
specific doc page or behavior that changed, and (if you have it) a minimal
stdin fixture reproducing the new shape.
