import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, listHandoffs } from '@batonpass/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/orchestrator.js';
import { spawnPty } from '../src/pty.js';
import { FakeAdapterPtyType } from './fake-adapter.js';

describe("Orchestrator e2e ('pty-type' resume strategy, fake agent, real PTY)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-pty-type-e2e-'));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('types the resume line into the PTY for chained handoffs instead of relying on a hook', async () => {
    const adapter = new FakeAdapterPtyType();
    const config = {
      ...DEFAULT_CONFIG,
      threshold: 0.5,
      pollIntervalMs: 50,
      idleQuietMs: 50,
      resumeTypeDelayMs: 20,
      handoffTimeoutMs: 10_000,
      maxChainedHandoffs: 3,
    };

    const orchestrator = new Orchestrator({ adapter, cwd, config, spawnPty });

    const handoffSeqs: number[] = [];
    orchestrator.on('handoff', (seq) => handoffSeqs.push(seq));
    const states: string[] = [];
    orchestrator.on('state', (s) => states.push(s));

    const runPromise = orchestrator.run();

    const start = Date.now();
    while (handoffSeqs.length < 3 && Date.now() - start < 30_000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(handoffSeqs).toEqual([1, 2, 3]);

    orchestrator.requestStop();
    await runPromise;

    expect(orchestrator.getState()).toBe('STOPPED');
    expect(states).toContain('INJECT_RESUME');

    const handoffDirs = await listHandoffs(path.join(cwd, '.batonpass', 'handoffs'));
    expect(handoffDirs).toHaveLength(3);

    // fake-agent's own SessionStart-hook simulation is disabled (FAKE_AGENT_SESSION_START_HOOK=0),
    // so every resume must have arrived via the orchestrator typing into the PTY. Two resumes are
    // expected: session 2 resumes from handoff 1, session 3 resumes from handoff 2.
    const receivedLines = await fs.readFile(path.join(cwd, '.batonpass', 'received-lines.log'), 'utf8');
    const resumeLines = receivedLines.split('\n').filter((l) => l.includes('Resuming from a previous session.'));
    expect(resumeLines).toHaveLength(2);
    expect(resumeLines[0]).toContain('.batonpass/handoffs/1-');
    expect(resumeLines[1]).toContain('.batonpass/handoffs/2-');
  }, 40_000);
});
