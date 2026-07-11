#!/usr/bin/env node
// A deterministic stand-in for a real coding-agent CLI, used to exercise
// Batonpass's orchestrator state machine end-to-end without needing a live
// Claude Code / Codex installation.
//
// Behavior:
//  - On startup, unless FAKE_AGENT_SESSION_START_HOOK=0, checks .batonpass/state.json
//    for pendingHandoff; if present, prints "RESUMED:<dirname>" (simulating
//    SessionStart-hook injection) and clears it (mirrors what a real adapter's
//    SessionStart hook does). Set FAKE_AGENT_SESSION_START_HOOK=0 to simulate a CLI
//    with no context-injection hook (e.g. Hermes) — the orchestrator itself must
//    then type the resume line via the PTY ('pty-type' resumeInjection strategy).
//  - Every ~150ms it simulates a turn of ambient work: usage climbs by a fixed
//    step, written to .batonpass/fake-usage.json, and a .batonpass/turn-idle marker
//    is refreshed (simulates a Stop hook firing at the end of every turn).
//  - Every received stdin line is appended to .batonpass/received-lines.log, so
//    tests can assert on content typed into the PTY (e.g. a 'pty-type' resume line).
//  - When it receives a line of stdin input containing the phrase
//    "write a handoff document to exactly this path:", it parses the target
//    path out of that line, writes a valid handoff.md + handoff.json there,
//    resets its usage counter (simulating a fresh context), and prints the
//    HANDOFF_WRITTEN sentinel.
//  - When it receives a line that is exactly "/exit", it exits(0).
import { promises as fs } from 'node:fs';
import path from 'node:path';

const cwd = process.cwd();
const batonpassDir = path.join(cwd, '.batonpass');
const usagePath = path.join(batonpassDir, 'fake-usage.json');
const turnIdlePath = path.join(batonpassDir, 'turn-idle');
const statePath = path.join(batonpassDir, 'state.json');
const receivedLinesPath = path.join(batonpassDir, 'received-lines.log');

const USAGE_STEP = Number(process.env.FAKE_AGENT_USAGE_STEP ?? '0.12');
const TICK_MS = Number(process.env.FAKE_AGENT_TICK_MS ?? '150');
const SESSION_START_HOOK_ENABLED = process.env.FAKE_AGENT_SESSION_START_HOOK !== '0';
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
  if (!SESSION_START_HOOK_ENABLED) return;
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
  // The prompt is now a single line (path followed by more text), so capture the
  // path as the first whitespace-delimited token after the marker — artifact paths
  // never contain spaces.
  const m = line.match(/write a handoff document to exactly this path: (\S+)/);
  return m ? m[1] : null;
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
  await fs.mkdir(batonpassDir, { recursive: true });
  // Real interactive CLIs print a startup banner/prompt before going quiet and waiting
  // for input — fake-agent mimics that so 'pty-type' resume-readiness tests (which wait
  // for output-then-quiet, not just a fallback timeout) exercise the real heuristic.
  console.log('[fake-agent] ready');
  await checkResume();
  await writeUsage();

  const ticker = setInterval(async () => {
    pct = Math.min(2, pct + USAGE_STEP);
    await writeUsage();
    await markIdle();
  }, TICK_MS);

  // Read stdin in raw mode and split on \r/\n ourselves, the way a real
  // interactive TUI does — NOT via readline, which leaves the PTY in canonical
  // mode where macOS/BSD caps a single input line at MAX_CANON (1024 bytes) and
  // silently drops longer ones. Batonpass's typed prompts are single-line and can
  // exceed that; a real raw-mode TUI (Claude/Codex/Hermes) handles them fine, so
  // the fake agent must too or the e2e wouldn't represent reality.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  let inbuf = '';
  const handleLine = async (line) => {
    await fs.appendFile(receivedLinesPath, `${line}\n`, 'utf8');
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
  };
  process.stdin.on('data', async (chunk) => {
    inbuf += chunk;
    let idx;
    while ((idx = inbuf.search(/[\r\n]/)) !== -1) {
      const line = inbuf.slice(0, idx);
      inbuf = inbuf.slice(idx + 1);
      await handleLine(line);
    }
  });

  process.on('SIGTERM', () => process.exit(0));
}

main();
