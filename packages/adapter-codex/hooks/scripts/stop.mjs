#!/usr/bin/env node
// Stop hook (Codex): fires when the current turn is about to end. Writes a
// turn-idle marker so the orchestrator's idle-detection doesn't have to guess
// from PTY output alone.
//
// IMPORTANT: this must exit 0 with NO output (not `{"decision":"block",...}`).
// Codex's Stop hook can force a *continuation* if it blocks — Batonpass relies on
// its own kill/respawn cycle, not Stop's continuation mechanism, so we must
// stay a pure observer here or we'd accidentally keep Codex talking forever.
import { batonpassPaths, readStdin, writeFileAtomic } from './_lib.mjs';

async function main() {
  const input = await readStdin();
  const cwd = input.cwd || process.cwd();
  const paths = batonpassPaths(cwd);

  await writeFileAtomic(
    paths.turnIdleMarker,
    JSON.stringify(
      { idleAt: new Date().toISOString(), sessionId: input.session_id ?? null, turnId: input.turn_id ?? null },
      null,
      2,
    ) + '\n',
  );

  process.exit(0); // no stdout: Codex requires JSON on stdout only when you intend to act; silence + exit 0 = plain continue
}

main().catch((err) => {
  console.error('[batonpass] stop hook error:', err);
  process.exit(0);
});
