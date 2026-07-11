import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BatonpassPaths, DEFAULT_CONFIG, listHandoffs, readState } from '@batonpass/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/orchestrator.js';
import { spawnPty } from '../src/pty.js';
import { FakeAdapter } from './fake-adapter.js';

describe('Orchestrator e2e (fake agent, real PTY)', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-e2e-'));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('performs 3 chained automatic handoffs then stops cleanly', async () => {
    const adapter = new FakeAdapter();
    const config = {
      ...DEFAULT_CONFIG,
      threshold: 0.5,
      pollIntervalMs: 50,
      idleQuietMs: 50,
      handoffTimeoutMs: 10_000,
      maxChainedHandoffs: 3,
    };

    const orchestrator = new Orchestrator({ adapter, cwd, config, spawnPty });

    const handoffSeqs: number[] = [];
    orchestrator.on('handoff', (seq) => handoffSeqs.push(seq));
    const states: string[] = [];
    orchestrator.on('state', (s) => states.push(s));

    const runPromise = orchestrator.run();

    // Wait for exactly 3 handoffs, then request a clean stop.
    const start = Date.now();
    while (handoffSeqs.length < 3 && Date.now() - start < 30_000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(handoffSeqs).toEqual([1, 2, 3]);

    orchestrator.requestStop();
    await runPromise;

    expect(orchestrator.getState()).toBe('STOPPED');

    // Every handoff on disk must be independently valid (readHandoff would throw otherwise).
    const handoffDirs = await listHandoffs(path.join(cwd, '.batonpass', 'handoffs'));
    expect(handoffDirs).toHaveLength(3);

    const finalState = await readState(new BatonpassPaths(cwd));
    expect(finalState.lastSeq).toBe(3);

    // The state machine should have visited every phase for at least one cycle.
    for (const expected of ['SPAWN', 'MONITOR', 'AWAIT_TURN_IDLE', 'INJECT_HANDOFF_PROMPT', 'AWAIT_ARTIFACT', 'VALIDATE_ARTIFACT', 'GRACEFUL_KILL']) {
      expect(states).toContain(expected);
    }
  }, 40_000);

  it('refuses a second concurrent orchestrator on the same project (lock file)', async () => {
    const adapter = new FakeAdapter();
    const config = { ...DEFAULT_CONFIG, threshold: 0.99, pollIntervalMs: 50, idleQuietMs: 50 };

    const first = new Orchestrator({ adapter, cwd, config, spawnPty });
    const firstRun = first.run();
    await new Promise((r) => setTimeout(r, 200)); // let it acquire the lock + spawn

    const second = new Orchestrator({ adapter, cwd, config, spawnPty });
    await expect(second.run()).rejects.toThrow(/already running/);

    first.requestStop();
    await firstRun;
  }, 15_000);
});
