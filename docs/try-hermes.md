# Trying the Hermes adapter — first-run walkthrough

A step-by-step guide for testing Batonpass with a real
[Hermes Agent](https://github.com/NousResearch/hermes-agent) install — e.g.
on the VPS where your Hermes already runs. This is the user-facing
companion to the maintainer checklist in [testing.md](./testing.md); as of
now the adapter is CI-proven but **you may be among the first real-machine
runs**, so §6 tells you what to report.

> **Gateway users, read this first.** If you use Hermes through
> Telegram/Discord (gateway mode), know that Batonpass orchestrates the
> **interactive terminal CLI only** — your gateway sessions will NOT get
> automatic handoffs (see [gateway-hosts.md](./gateway-hosts.md) for why).
> Two things still change globally while installed: Hermes auto-compression
> moves from 50% → 90% of context (longer sessions before compaction =
> somewhat costlier late-session turns on a 24/7 agent), and a `/baton`
> command appears in all sessions (harmless but inert outside
> Batonpass-run projects). Uninstall reverts both.

## 0. Prerequisites

```sh
node --version     # ≥ 22 (pnpm 11 refuses to run on Node 20)
python3 --version  # you have this — Hermes is Python
hermes --version   # the CLI must be on PATH
# Debian/Ubuntu — node-pty compiles a native addon:
sudo apt-get install -y build-essential
```

Run everything below inside `tmux` (or `screen`) — if SSH drops mid-handoff
you don't want the orchestrator dying with it.

## 1. Install Batonpass from source (not on npm yet)

```sh
git clone https://github.com/Roizlotolov/batonpass.git ~/batonpass
cd ~/batonpass && corepack enable && pnpm install && pnpm build
alias batonpass="node ~/batonpass/packages/cli/dist/index.js"
```

Add the alias to `~/.bashrc` if you plan to keep it.

## 2. Install the adapter, then verify every file it touched

```sh
batonpass init --agent hermes --user
batonpass doctor
```

Eyeball the full footprint (this is everything the install does):

```sh
ls ~/.hermes/plugins/batonpass/            # plugin.yaml + __init__.py
hermes plugins list                        # batonpass shown as enabled
grep -n "batonpass" ~/.hermes/config.yaml  # threshold line + marker comment "(was 0.50)"
ls ~/.hermes/config.yaml.bak-*             # timestamped backup of your config
```

## 3. Passive test — hooks fire, nothing else changes

The helper plugin is inert unless the working directory contains
`.batonpass/`, so create a scratch project and run **vanilla** Hermes:

```sh
mkdir -p ~/baton-test/.batonpass && cd ~/baton-test
hermes
```

Chat 2–3 normal turns, then check from another pane:

```sh
cat ~/baton-test/.batonpass/usage.json   # exists; "tokens" grows every turn
cat ~/baton-test/.batonpass/turn-idle    # timestamp bumps after each reply
```

`/quit`. If the turns felt normal — no added latency, no errors — the
plugin is healthy. (Note: `pct`/`max` may be `null` on the very first turns
until Hermes' own context-length cache warms up for your model; that's
expected.)

## 4. The real test — a full automatic handoff cycle

Don't wait for a 100k-token conversation — drop the threshold for testing:

```sh
echo '{"threshold": 0.2}' > ~/baton-test/.batonpass/config.json
cd ~/baton-test && batonpass run hermes
```

Give the agent a small but real multi-step task ("write a python script
that does X, add tests, then refactor it") and keep going until context
passes 20%. What you should observe, in order:

1. Batonpass types the handoff prompt into the session — the agent writes
   the handoff document.
2. Batonpass validates the artifact, types `/quit`, and spawns a fresh
   `hermes`.
3. **The critical moment:** once the new prompt is up, Batonpass types a
   single line — `Resuming from a previous session. Read
   .batonpass/handoffs/… ` — watch for lost or garbled leading characters
   (this is the known readiness-race risk).
4. The agent reads the handoff file and continues the task coherently.

Then verify the artifacts:

```sh
batonpass status
batonpass handoffs            # list; then: batonpass handoffs show 1
ls ~/baton-test/.batonpass/handoffs/
```

Also try the manual trigger in a session: `/baton` (Hermes' own `/handoff`
is a different, built-in command — it hands the session to a messaging
platform).

## 5. Undo (any time)

```sh
batonpass init --agent hermes --user --uninstall
```

Disables + removes the plugin and reverts the compression threshold (only
if the line still carries Batonpass's marker). Your `config.yaml.bak-*`
backup exists regardless.

## 6. What to report

Two observations matter most — please open an issue (or a PR updating
PLAN-hermes.md's Progress log) either way:

1. **Did the typed resume line land cleanly?** If leading characters were
   eaten, say so — the `resumeTypeDelayMs` default needs raising.
2. **Did `usage.json` numbers look sane** relative to conversation length?
   This validates the "`prompt_tokens` ≈ context occupancy" interpretation
   (PLAN-hermes.md §2.3), which is otherwise unverified against a real
   session. A rough "after ~N turns of ~M words, tokens read X, pct read Y"
   is plenty.

Plus anything else: install friction, latency, `/quit` not exiting cleanly,
compaction firing when it shouldn't.
