#!/usr/bin/env node
// Stop hook: fires when the agent's turn ends. Writes a turn-idle marker so the
// orchestrator's idle-detection never has to guess from PTY output alone.
import { batonpassPaths, readStdin, writeFileAtomic } from './_lib.mjs';

async function main() {
  const input = await readStdin();
  const cwd = input.cwd || process.cwd();
  const paths = batonpassPaths(cwd);

  await writeFileAtomic(
    paths.turnIdleMarker,
    JSON.stringify({ idleAt: new Date().toISOString(), sessionId: input.session_id ?? null }, null, 2) + '\n',
  );

  process.exit(0);
}

main().catch((err) => {
  console.error('[batonpass] stop hook error:', err);
  process.exit(0);
});
