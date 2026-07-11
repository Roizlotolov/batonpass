import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readHandoff, sectionText, writeHandoff } from '../src/artifact.js';
import type { HandoffJson, HandoffMd } from '../src/schema.js';

// Reproduces the discipline the handoff prompt asks the agent to follow: "Copy the
// Objective from the previous handoff unless it changed." This test doesn't exercise
// an LLM (that's not something we can unit test), but it proves Batonpass's own
// write -> read -> re-render plumbing never mutates that carried-forward text across
// a long chain, including content with markdown/unicode that a naive re-serialization
// could mangle.
describe('chained handoff drift (5 handoffs, Objective carried forward verbatim)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-drift-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const OBJECTIVE = [
    'Ship the "Batonpass" v1 CLI — supports Claude Code + Codex, chained handoffs.',
    '',
    'Tricky bits to preserve: emoji ⚡, em-dash —, a `code span`, and   internal   spacing.',
    '',
    'Final line (renderHandoffMd trims section edges, so nothing tricky goes here).',
  ].join('\n');

  function meta(seq: number, previousHandoff: string | null): HandoffJson {
    return {
      version: '1',
      seq,
      tool: 'claude-code',
      sessionId: `sess-${seq}`,
      createdAt: new Date(2026, 6, 11, 12, seq, 0).toISOString(),
      cwd: '/tmp/repo',
      gitHead: null,
      gitDirty: false,
      contextPctAtHandoff: 76,
      previousHandoff,
      status: 'pending',
    };
  }

  function md(seq: number, objective: string): HandoffMd {
    return {
      seq,
      sections: {
        Objective: objective,
        'Current state': `State at handoff ${seq}.`,
        'Next steps': `1. Continue from handoff ${seq}.`,
        'Key decisions': 'None new.',
        'Files touched': 'none -> test',
        'Gotchas & constraints': 'None.',
        Verification: 'pnpm test',
        'Do NOT': 'Do not diverge the Objective.',
      },
    };
  }

  it('keeps the Objective byte-identical across 5 chained write/read cycles', async () => {
    let previousDirName: string | null = null;
    let carriedObjective = OBJECTIVE;

    for (let seq = 1; seq <= 5; seq++) {
      const handoffMeta = meta(seq, previousDirName);
      const handoffMd = md(seq, carriedObjective);
      const paths = await writeHandoff(dir, handoffMeta, handoffMd);

      const read = await readHandoff(paths.dir);
      expect(sectionText(read.md, 'Objective')).toBe(OBJECTIVE);

      // Simulate the next session copying the Objective forward verbatim from what it read.
      carriedObjective = sectionText(read.md, 'Objective');
      previousDirName = path.basename(paths.dir);
    }

    expect(carriedObjective).toBe(OBJECTIVE);
  });
});
