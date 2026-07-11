#!/usr/bin/env node
// A deterministic stand-in for a real coding-agent CLI, used to exercise
// Batonpass's orchestrator state machine end-to-end without needing a live
// Claude Code / Codex installation.
//
// Behavior:
//  - On startup, checks .batonpass/state.json for pendingHandoff; if present,
//    prints "RESUMED:<dirname>" (simulating SessionStart-hook injection) and
//    clears it (mirrors what a real adapter's SessionStart hook does).
//  - Every ~150ms it simulates a turn of ambient work: usage climbs by a fixed
//    step, written to .batonpass/fake-usage.json, and a .batonpass/turn-idle marker
//    is refreshed (simulates a Stop hook firing at the end of every turn).
//  - When it receives a line of stdin input containing the phrase
//    "write a handoff document to exactly this path:", it parses the target
//    path out of that line, writes a valid handoff.md + handoff.json there,
//    resets its usage counter (simulating a fresh context), and prints the
//    HANDOFF_WRITTEN sentinel.
//  - When it receives a line that is exactly "/exit", it exits(0).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const cwd = process.cwd();
const batonpassDir = path.join(cwd, '.batonpass');
const usagePath = path.join(batonpassDir, 'fake-usage.json');
const turnIdlePath = path.join(batonpassDir, 'turn-idle');
const statePath = path.join(batonpassDir, 'state.json');

const USAGE_STEP = Number(process.env.FAKE_AGENT_USAGE_STEP ?? '0.12');
const TICK_MS = Number(process.env.FAKE_AGENT_TICK_MS ?? '150');
const MAX_TOKENS = 200_000;

let pct = 0;

async function writeAtomic(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, filePath);
}

async function markIdle() {
  await writeAtomic(turnIdlePath, JSON.stringify({ idleAt: new Date().toISOString() }));
}

async function writeUsage() {
  await writeAtomic(
    usagePath,
    JSON.stringify({ pct, tokens: Math.round(pct * MAX_TOKENS), max: MAX_TOKENS, updatedAt: new Date().toISOString() }),
  );
}

async function checkResume() {
  let state;
  try {
    state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  } catch {
    return;
  }
  if (state.pendingHandoff) {
    console.log(`RESUMED:${state.pendingHandoff}`);
    await writeAtomic(statePath, JSON.stringify({ ...state, pendingHandoff: null }));
  }
}

function extractArtifactPath(line) {
  const marker = 'write a handoff document to exactly this path: ';
  const idx = line.indexOf(marker);
  if (idx === -1) return null;
  return line.slice(idx + marker.length).trim();
}

async function writeHandoffArtifact(mdPath) {
  const dir = path.dirname(mdPath);
  const jsonPath = path.join(dir, 'handoff.json');
  const seqMatch = path.basename(dir).match(/^(\d+)-/);
  const seq = seqMatch ? Number.parseInt(seqMatch[1], 10) : 0;

  const md = [
    `# Handoff ${seq}`,
    '',
    '## Objective',
    '',
    'Fake e2e task.',
    '',
    '## Current state',
    '',
    `Turn completed at pct=${pct.toFixed(2)}.`,
    '',
    '## Next steps',
    '',
    '1. Continue the fake task.',
    '',
    '## Key decisions',
    '',
    'None.',
    '',
    '## Files touched',
    '',
    'none -> fake agent',
    '',
    '## Gotchas & constraints',
    '',
    'This is a synthetic e2e fixture, not a real agent.',
    '',
    '## Verification',
    '',
    'node examples/fake-agent/fake-agent.mjs --self-check',
    '',
    '## Do NOT',
    '',
    'Do not treat this as real project state.',
    '',
  ].join('\n');

  const json = {
    version: '1',
    seq,
    tool: 'claude-code',
    sessionId: 'fake-session',
    createdAt: new Date().toISOString(),
    cwd,
    gitHead: null,
    gitDirty: false,
    contextPctAtHandoff: Math.round(pct * 100),
    previousHandoff: null,
    status: 'pending',
  };

  await fs.mkdir(dir, { recursive: true });
  await writeAtomic(mdPath, md);
  await writeAtomic(jsonPath, JSON.stringify(json, null, 2) + '\n');
}

async function main() {
  await checkResume();
  await writeUsage();

  const ticker = setInterval(async () => {
    pct = Math.min(2, pct + USAGE_STEP);
    await writeUsage();
    await markIdle();
  }, TICK_MS);

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', async (line) => {
    if (line.trim() === '/exit') {
      clearInterval(ticker);
      process.exit(0);
      return;
    }
    const artifactPath = extractArtifactPath(line);
    if (artifactPath) {
      await writeHandoffArtifact(artifactPath);
      pct = 0; // simulate a fresh, smaller context after writing the handoff
      await writeUsage();
      await markIdle();
      console.log('HANDOFF_WRITTEN');
    }
  });

  process.on('SIGTERM', () => process.exit(0));
}

main();
