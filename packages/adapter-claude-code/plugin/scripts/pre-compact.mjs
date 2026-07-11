#!/usr/bin/env node
// PreCompact hook: when Batonpass's orchestrator is actively running this session
// (state.json.orchestratorPid is alive) and Claude Code is about to run its own
// *automatic* compaction, block it (exit 2) and drop a marker so the orchestrator
// can react immediately instead of waiting for its next poll. Manual /compact and
// vanilla (non-orchestrated) usage are always left alone (exit 0).
import { batonpassPaths, isProcessAlive, readJson, readStdin, writeFileAtomic } from './_lib.mjs';

async function main() {
  const input = await readStdin();
  const cwd = input.cwd || process.cwd();
  const trigger = input.trigger; // 'manual' | 'auto'
  const paths = batonpassPaths(cwd);

  if (trigger !== 'auto') {
    process.exit(0);
    return;
  }

  const state = await readJson(paths.stateJson, null);
  const orchestratorActive = !!state?.orchestratorPid && isProcessAlive(state.orchestratorPid);

  if (!orchestratorActive) {
    process.exit(0); // Batonpass isn't running — never interfere with vanilla auto-compact
    return;
  }

  await writeFileAtomic(
    paths.compactBlockedMarker,
    JSON.stringify({ blockedAt: new Date().toISOString(), sessionId: input.session_id ?? null }, null, 2) + '\n',
  );

  console.error('[batonpass] blocking automatic compaction — orchestrator will handle handoff instead');
  process.exit(2);
}

main().catch((err) => {
  console.error('[batonpass] pre-compact hook error:', err);
  process.exit(0); // fail open — never break compaction on our own bug
});
