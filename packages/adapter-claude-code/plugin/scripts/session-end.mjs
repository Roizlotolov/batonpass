#!/usr/bin/env node
// SessionEnd hook: best-effort cleanup of the turn-idle marker so a stale marker
// from a killed session can't be misread as "idle" by a future orchestrator run.
import { promises as fs } from 'node:fs';
import { batonpassPaths, readStdin } from './_lib.mjs';

async function main() {
  const input = await readStdin();
  const cwd = input.cwd || process.cwd();
  const paths = batonpassPaths(cwd);
  await fs.rm(paths.turnIdleMarker, { force: true });
  process.exit(0);
}

main().catch((err) => {
  console.error('[batonpass] session-end hook error:', err);
  process.exit(0);
});
