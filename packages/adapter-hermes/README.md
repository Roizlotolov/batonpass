# @batonpass/adapter-hermes

Batonpass adapter for [Hermes Agent](https://github.com/NousResearch/hermes-agent)
(`NousResearch/hermes-agent`). See [PLAN-hermes.md](../../PLAN-hermes.md) for the
implementation plan and [docs/adapters.md](../../docs/adapters.md) for the
`Adapter` contract this implements.

Hermes' plugin API is **not documented upstream** — everything below was
verified by cloning and grepping the source directly (not training data, not
a secondhand summary), file:line-cited, and re-checked at implementation time.
If any of this drifts on a newer Hermes version, that's a bug in this
package, not intentional behavior — please open an issue with the exact
Hermes commit/version and what changed.

## What this package installs

- A pure-stdlib Python plugin (`plugin/`) copied to
  `<HERMES_HOME>/plugins/batonpass/` and enabled via
  `hermes plugins enable batonpass --no-allow-tool-override`. It writes
  `.batonpass/usage.json` (on `post_api_request`), `.batonpass/turn-idle` (on
  `post_llm_call`), resets stale usage on `on_session_start`, and registers
  `/baton` as a manual-trigger command (Hermes' own `/handoff` command means
  something else — see below).
- One edit to `<HERMES_HOME>/config.yaml`: raises `compression.threshold` to
  `0.90` if it's currently lower, so Hermes' own auto-compression can't fire
  before Batonpass's default 0.75 threshold does. Tagged with a marker
  comment so `uninstall()` only reverts it if nothing else has touched the
  line since.

User-scope only — Hermes has no project-local config equivalent.

## Facts this adapter relies on (verified against `hermes-agent` @ `c552984`)

| Fact | Where |
|---|---|
| `/quit` exits, `/new`/`/clear` reset the session, `/handoff` is a **built-in** command meaning "hand off to a messaging platform" (hence this adapter's manual trigger is `/baton`, not `/handoff`) | `hermes_cli/commands.py:253,68,72,87` |
| `register_command` rejects a name that conflicts with a built-in, with a warning | `hermes_cli/plugins.py:527-566` |
| Plugin layout: `<HERMES_HOME>/plugins/<name>/{plugin.yaml,__init__.py}` exporting `register(ctx)` | `hermes_cli/plugins.py:1332-1348,1747` |
| `HERMES_HOME` env var, else `~/.hermes` (non-Windows) / `%LOCALAPPDATA%\hermes` (Windows) | `hermes_constants.py:46-110` |
| `post_api_request` kwargs include `usage` (a dict of `input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, request_count, prompt_tokens, total_tokens` — the last two are computed properties added by hand after `asdict()`, not real dataclass fields) | `agent/conversation_loop.py:4276-4308`, `run_agent.py:2242-2256`, `CanonicalUsage` dataclass |
| Context occupancy is approximated as `prompt_tokens` of the latest call (**unverified against a real session — confirm during the manual checklist in `docs/testing.md`**) | PLAN-hermes.md §2.3 |
| `agent.model_metadata.get_cached_context_length(model, base_url)` is the local-cache-only lookup safe to call from a synchronous hook; returns `None` until Hermes has warmed it for that model — never call the network-probing variant here | `agent/model_metadata.py:1117` |
| `post_llm_call` kwargs: `session_id, task_id, turn_id, user_message, assistant_response, conversation_history, model, platform` — **no usage data** | `agent/turn_finalizer.py:386-405` |
| `on_session_start` fires once per brand-new session (not on `--resume`), kwargs `session_id, model, platform`; return value ignored | `agent/conversation_loop.py:363-375` |
| `invoke_hook` already wraps every callback in try/except and logs a warning on failure — this plugin still wraps every handler itself as defense in depth, not because it's the only guard | `hermes_cli/plugins.py:1890-1922` |
| Auto-compression defaults to `enabled: true, threshold: 0.50`, and **ends the current session and forks a continuation** rather than compressing in place | `cli.py:421-422`, `hermes_state.py`, `cli.py` (~9340, ~12534) |
| No plugin-config mechanism (`plugin_config`/`get_config()`) exists — env vars are the sanctioned pattern (mirrors the bundled `langfuse` plugin), hence `BATONPASS_DIR` | `hermes_cli/plugins.py` |
| `hermes plugins enable <name>` writes `plugins.enabled` in `config.yaml` (`_save_enabled_set`) and, for any **non-bundled** plugin, prompts interactively to grant `allow_tool_override` unless `--allow-tool-override`/`--no-allow-tool-override` is passed | `hermes_cli/plugins_cmd.py:697-899`, `hermes_cli/subcommands/plugins.py:85-97` |
| No `PreCompact`/`PostCompact`-equivalent hook exists for plugins — this adapter never tries to block Hermes' own compaction, only raises its threshold | PLAN-hermes.md §2.5 |
| `on_session_start`'s plugin-hook return value is ignored, so there is no context-injection hook at all — this is why `resumeInjection()` is `'pty-type'`, not `'session-start-hook'` | `hermes_cli/hooks.py:151`, `run_agent.py:660` (a different, context-*engine* hook, not this one) |

## Known gaps

- **`isInstalled()`'s `plugins.enabled` read is intentionally read-only.**
  `install()`/`uninstall()` always shell out to the real `hermes plugins
  enable/disable` command rather than hand-editing that list — see
  `configyaml.ts`'s module doc for why.
- **No pull-based usage fallback.** Hermes' own transcript/session file
  format is an unresolved implementation detail (unlike Codex's rollout
  JSONL or Claude Code's transcript JSONL, which this monorepo's other
  adapters do parse as a fallback) — if the plugin isn't loaded or hasn't
  fired yet, `usageSource().getUsage()` simply returns `null`.
- **Not yet run against a real `hermes` binary** — see the Hermes checklist
  in [docs/testing.md](../../docs/testing.md) before relying on this in
  production.
