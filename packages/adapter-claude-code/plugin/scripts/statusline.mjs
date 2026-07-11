#!/usr/bin/env node
// Statusline command: writes .batonpass/usage.json from the context_window fields
// Claude Code passes on stdin (Batonpass's primary usage source), then prints a
// statusline. If the user already had a statusline command configured before
// `batonpass init` ran, that command is chained: we re-invoke it with the same
// stdin and print its output verbatim, so we never regress their existing setup.
import { spawnSync } from 'node:child_process';
import { batonpassPaths, writeFileAtomic } from './_lib.mjs';

async function main() {
  const raw = await readStdinRaw();
  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {
    // Not JSON — nothing we can do; still try to chain below with raw text.
  }

  const cwd = input.cwd || process.cwd();
  const paths = batonpassPaths(cwd);

  const ctx = input.context_window;
  if (ctx && typeof ctx.used_percentage === 'number' && typeof ctx.context_window_size === 'number') {
    const pct = ctx.used_percentage > 1 ? ctx.used_percentage / 100 : ctx.used_percentage;
    const max = ctx.context_window_size;
    const tokens = Math.round(pct * max);
    await writeFileAtomic(
      paths.usageJson,
      JSON.stringify({ pct, tokens, max, updatedAt: new Date().toISOString() }, null, 2) + '\n',
    ).catch(() => {}); // never let a write failure break the statusline
  }

  const chainedCommand = process.env.BATON_CHAIN_STATUSLINE_COMMAND;
  if (chainedCommand) {
    const result = spawnSync(chainedCommand, { shell: true, input: raw, encoding: 'utf8' });
    process.stdout.write(result.stdout ?? '');
    process.exit(result.status ?? 0);
    return;
  }

  const modelName = input.model?.display_name ?? 'Claude';
  const pctDisplay = ctx ? `${Math.round((ctx.used_percentage > 1 ? ctx.used_percentage : ctx.used_percentage * 100))}%` : '?';
  process.stdout.write(`${modelName} · ctx ${pctDisplay} · batonpass`);
  process.exit(0);
}

async function readStdinRaw() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

main().catch((err) => {
  console.error('[batonpass] statusline hook error:', err);
  process.stdout.write('batonpass (error)');
  process.exit(0);
});
