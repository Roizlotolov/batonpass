/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging -- standard typed-EventEmitter pattern (class + declare interface) */
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  correctivePrompt,
  isSafeHandoffDirName,
  parseHandoffMd,
  readHandoff,
  resumePromptPtyType,
  validateHandoffMd,
  writeFileAtomic,
  type Adapter,
  type Config,
  type HandoffJson,
} from '@batonpass/core';
import { BatonpassPaths, acquireLockForced, ensureBatonpassDir, readState, releaseLock, updateState } from '@batonpass/core';
import type { PtyProcess, PtySpawnFn } from './pty.js';
import { RingBuffer } from './pty.js';

export type OrchestratorState =
  | 'IDLE'
  | 'SPAWN'
  | 'MONITOR'
  | 'AWAIT_TURN_IDLE'
  | 'INJECT_RESUME'
  | 'INJECT_HANDOFF_PROMPT'
  | 'AWAIT_ARTIFACT'
  | 'VALIDATE_ARTIFACT'
  | 'GRACEFUL_KILL'
  | 'SEMI_AUTO_FALLBACK'
  | 'STOPPED';

export interface OrchestratorOptions {
  adapter: Adapter;
  cwd: string;
  config: Config;
  spawnPty: PtySpawnFn;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable sleep for deterministic tests (ms -> Promise<void>). */
  sleep?: (ms: number) => Promise<void>;
}

const HANDOFF_WRITTEN_SENTINEL = 'HANDOFF_WRITTEN';

export declare interface Orchestrator {
  on(event: 'state', cb: (state: OrchestratorState) => void): this;
  on(event: 'spawn', cb: (pid: number) => void): this;
  /** Raw child PTY output, for the CLI to forward to the user's terminal. */
  on(event: 'data', cb: (data: string) => void): this;
  on(event: 'handoff', cb: (seq: number) => void): this;
  on(event: 'fallback', cb: (reason: string) => void): this;
  on(event: 'error', cb: (err: Error) => void): this;
  on(event: 'stopped', cb: () => void): this;
}

/**
 * Owns the full lifecycle of `batonpass run <agent>`: spawn the agent CLI in a PTY,
 * monitor context usage + idle turns, inject the handoff prompt at threshold,
 * validate the artifact the agent writes, then kill and respawn with the
 * handoff delivered via the adapter's resume-injection mechanism.
 *
 * Never kills a session without a validated artifact on disk (see `killChild`).
 */
export class Orchestrator extends EventEmitter {
  private readonly adapter: Adapter;
  private readonly cwd: string;
  private readonly config: Config;
  private readonly spawnPtyFn: PtySpawnFn;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly paths: BatonpassPaths;

  private state: OrchestratorState = 'IDLE';
  private stopRequested = false;
  private child: PtyProcess | null = null;
  private ring = new RingBuffer();
  private inputQueue: string[] = [];
  private forwardingInput = true;
  private sessionSinceMs = 0;
  private handoffCount = 0;
  private runPromise: Promise<void> | null = null;
  private hasOutput = false;
  private lastDataAtMs = 0;
  private lastUsagePct = 0;

  constructor(opts: OrchestratorOptions) {
    super();
    this.adapter = opts.adapter;
    this.cwd = opts.cwd;
    this.config = opts.config;
    this.spawnPtyFn = opts.spawnPty;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.paths = new BatonpassPaths(this.cwd);
  }

  getState(): OrchestratorState {
    return this.state;
  }

  getHandoffCount(): number {
    return this.handoffCount;
  }

  private setState(s: OrchestratorState): void {
    this.state = s;
    this.emit('state', s);
  }

  /** Queue user keystrokes typed while we're mid-injection/validation instead of dropping them. */
  feedUserInput(data: string): void {
    if (this.forwardingInput && this.child) {
      this.child.write(data);
    } else {
      this.inputQueue.push(data);
    }
  }

  /** Forward a terminal resize to the current child PTY, if any. */
  resize(cols: number, rows: number): void {
    this.child?.resize(cols, rows);
  }

  private flushQueuedInput(): void {
    this.forwardingInput = true;
    if (this.child && this.inputQueue.length > 0) {
      for (const chunk of this.inputQueue) this.child.write(chunk);
    }
    this.inputQueue = [];
  }

  requestStop(): void {
    this.stopRequested = true;
  }

  async run(): Promise<void> {
    await ensureBatonpassDir(this.cwd);

    const gotLock = await acquireLockForced(this.paths);
    if (!gotLock) {
      throw new Error('Another Batonpass orchestrator is already running for this project (see .batonpass/orchestrator.lock).');
    }

    const priorState = await readState(this.paths);
    if (priorState.pendingHandoff) {
      // Crash recovery: a previous orchestrator died after writing pendingHandoff but before
      // (or while) respawning. We don't guess — just note it; the next SPAWN will still pick
      // it up via the adapter's normal resume-injection path.
      this.emit('fallback', `Resuming after unclean shutdown; pendingHandoff=${priorState.pendingHandoff} will be injected on next spawn.`);
    }

    await updateState(this.paths, (s) => ({ ...s, orchestratorPid: process.pid, tool: this.adapter.id }));

    this.runPromise = this.mainLoop();
    try {
      await this.runPromise;
    } finally {
      await updateState(this.paths, (s) => ({ ...s, orchestratorPid: null }));
      await releaseLock(this.paths);
      this.setState('STOPPED');
      this.emit('stopped');
    }
  }

  private async mainLoop(): Promise<void> {
    while (!this.stopRequested) {
      if (this.handoffCount >= this.config.maxChainedHandoffs) break;

      await this.spawnChild();
      await this.maybeInjectPtyTypeResume();
      const outcome = await this.monitorUntilThresholdOrExit();

      if (outcome === 'exited') {
        // Child exited on its own (user quit, crash, etc.) — nothing more to orchestrate.
        break;
      }
      if (outcome === 'stop-requested') {
        await this.killChild('graceful-user-stop');
        break;
      }

      // outcome === 'threshold'
      await this.waitForTurnIdle();
      if (this.stopRequested) {
        await this.killChild('graceful-user-stop');
        break;
      }

      const handoffResult = await this.performHandoffCycle();
      if (handoffResult === 'fallback') {
        // Semi-auto fallback: never kill without a valid artifact. Keep the session alive
        // and let the user finish manually; stop orchestrating this child.
        this.setState('SEMI_AUTO_FALLBACK');
        this.emit('fallback', 'Handoff artifact invalid after retry — leaving session running for manual handling.');
        break;
      }

      this.handoffCount += 1;
      this.emit('handoff', this.handoffCount);
      await this.killChild('respawn');
      // loop continues -> SPAWN again, adapter's resume-injection delivers the handoff
    }
  }

  private async spawnChild(): Promise<void> {
    this.setState('SPAWN');
    const { cmd, args, env } = this.adapter.spawnCommand({ cwd: this.cwd });
    const child = this.spawnPtyFn(cmd, args, { cwd: this.cwd, env });
    this.child = child;
    this.ring.clear();
    this.sessionSinceMs = this.now();
    this.hasOutput = false;
    this.lastDataAtMs = this.now();
    this.forwardingInput = true;
    this.flushQueuedInput();

    child.onData((data) => {
      this.ring.append(data);
      this.hasOutput = true;
      this.lastDataAtMs = this.now();
      this.emit('data', data);
    });
    this.emit('spawn', child.pid);
  }

  /**
   * For adapters with no context-injection hook (`resumeInjection() === 'pty-type'`),
   * types the resume instruction directly into the freshly spawned PTY once a pending
   * handoff exists and the CLI has produced output then gone quiet (mirrors what a
   * SessionStart hook does for the other adapters, including clearing `pendingHandoff`
   * the same way). No-op for `'session-start-hook'` adapters and when nothing is pending.
   */
  private async maybeInjectPtyTypeResume(): Promise<void> {
    if (this.adapter.resumeInjection() !== 'pty-type') return;

    const state = await readState(this.paths);
    if (!state.pendingHandoff || !isSafeHandoffDirName(state.pendingHandoff)) return;
    const pendingHandoff = state.pendingHandoff;

    this.setState('INJECT_RESUME');
    await this.waitForPtyQuiet();
    if (this.stopRequested) return;
    await this.sleep(this.config.resumeTypeDelayMs);
    if (this.stopRequested || !this.child) return;

    const relPath = path.join('.batonpass', 'handoffs', pendingHandoff, 'handoff.md');
    this.child.write(resumePromptPtyType(relPath));
    this.child.write('\r');

    // Only clear if it's still the same pending handoff — a concurrent change (there
    // shouldn't be one, single orchestrator owns this state) is left alone rather than clobbered.
    await updateState(this.paths, (s) => (s.pendingHandoff === pendingHandoff ? { ...s, pendingHandoff: null } : s));
  }

  /** Wait until the child has produced output and then gone quiet for `idleQuietMs` (readiness heuristic for typing). */
  private async waitForPtyQuiet(): Promise<void> {
    const deadline = this.now() + this.config.handoffTimeoutMs;
    for (;;) {
      if (this.stopRequested) return;
      if (this.hasOutput && this.now() - this.lastDataAtMs >= this.config.idleQuietMs) return;
      if (this.now() >= deadline) return; // safety valve — proceed anyway rather than hang forever
      await this.sleep(Math.min(this.config.pollIntervalMs, this.config.idleQuietMs, 100));
    }
  }

  /** Poll usage until threshold is hit, the child exits on its own, or a stop is requested. */
  private async monitorUntilThresholdOrExit(): Promise<'threshold' | 'exited' | 'stop-requested'> {
    this.setState('MONITOR');
    let exited = false;
    const onExit = () => {
      exited = true;
    };
    this.child?.onExit(onExit);

    for (;;) {
      if (exited) return 'exited';
      if (this.stopRequested) return 'stop-requested';

      const usage = await this.adapter.usageSource({ cwd: this.cwd, sessionId: null, sinceMs: this.sessionSinceMs }).getUsage();
      if (usage) {
        this.lastUsagePct = usage.pct;
        if (usage.pct >= this.config.threshold) return 'threshold';
      }
      await this.sleep(this.config.pollIntervalMs);
    }
  }

  private async waitForTurnIdle(): Promise<void> {
    this.setState('AWAIT_TURN_IDLE');
    for (;;) {
      if (this.stopRequested) return;
      const idle = await this.adapter.isTurnIdle({ cwd: this.cwd, sessionId: null, sinceMs: this.sessionSinceMs });
      if (idle) return;
      await this.sleep(Math.min(this.config.pollIntervalMs, this.config.idleQuietMs));
    }
  }

  /**
   * Inject the handoff prompt, wait for the AGENT to write a valid handoff.md, then
   * write the machine-owned handoff.json ourselves and validate the pair. The agent is
   * only ever asked for handoff.md; handoff.json is batonpass's responsibility (see
   * docs/spec.md — it carries tool/session/git metadata the agent can't know), so we
   * never make the agent guess its schema. One corrective retry on an invalid md.
   */
  private async performHandoffCycle(): Promise<'ok' | 'fallback'> {
    const state = await readState(this.paths);
    const nextSeq = state.lastSeq + 1;
    const createdAt = new Date(this.now()).toISOString();
    const previousHandoff = await this.latestHandoffDirName();
    const artifactPath = `${this.paths.handoffsDir}/${nextSeq}-${createdAt.replace(/[:.]/g, '-')}/handoff.md`;

    this.setState('INJECT_HANDOFF_PROMPT');
    this.forwardingInput = false; // queue any user keystrokes until injection settles
    if (this.child) await this.adapter.injectHandoffPrompt(this.child, artifactPath);

    let result = await this.awaitAgentMd(artifactPath);
    if (!result.ok && this.child) {
      // One corrective retry with the specific md problems.
      this.child.write(correctivePrompt(artifactPath, result.issues));
      this.child.write('\r');
      result = await this.awaitAgentMd(artifactPath);
    }
    this.flushQueuedInput();
    if (!result.ok) return 'fallback';

    return this.finalizeHandoff(artifactPath, nextSeq, createdAt, previousHandoff);
  }

  /**
   * Write handoff.json (machine-owned metadata), then validate the full md+json pair and
   * record the handoff in state so the next session's resume can pick it up.
   */
  private async finalizeHandoff(
    artifactPath: string,
    seq: number,
    createdAt: string,
    previousHandoff: string | null,
  ): Promise<'ok' | 'fallback'> {
    this.setState('VALIDATE_ARTIFACT');
    const dir = path.dirname(artifactPath);
    const meta: HandoffJson = {
      version: '1',
      seq,
      tool: this.adapter.id,
      sessionId: (await this.currentSessionId()) ?? 'auto',
      createdAt,
      cwd: this.cwd,
      gitHead: this.gitHead(),
      gitDirty: this.gitDirty(),
      contextPctAtHandoff: Math.max(0, Math.min(200, Math.round(this.lastUsagePct * 100))),
      previousHandoff,
      status: 'pending',
    };
    try {
      await writeFileAtomic(path.join(dir, 'handoff.json'), JSON.stringify(meta, null, 2) + '\n');
      await readHandoff(dir); // integrity check on the full md+json pair
    } catch {
      return 'fallback';
    }
    await updateState(this.paths, (s) => ({ ...s, lastSeq: seq, pendingHandoff: path.basename(dir) }));
    return 'ok';
  }

  /** Wait for the agent to signal done AND to have written a schema-valid handoff.md. */
  private async awaitAgentMd(artifactPath: string): Promise<{ ok: boolean; issues: string[] }> {
    this.setState('AWAIT_ARTIFACT');
    const deadline = this.now() + this.config.handoffTimeoutMs;
    let issues: string[] = ['handoff.md was not found before the timeout elapsed.'];
    for (;;) {
      if (this.ring.includes(HANDOFF_WRITTEN_SENTINEL)) {
        try {
          const text = await fs.readFile(artifactPath, 'utf8');
          const mdIssues = validateHandoffMd(parseHandoffMd(text));
          if (mdIssues.length === 0) return { ok: true, issues: [] };
          issues = mdIssues;
        } catch {
          issues = [`missing or unreadable file: ${artifactPath}`];
        }
      }
      if (this.now() >= deadline) return { ok: false, issues };
      await this.sleep(Math.min(this.config.pollIntervalMs, 250));
    }
  }

  /** Directory name of the most recent existing handoff (for the chain link), or null. */
  private async latestHandoffDirName(): Promise<string | null> {
    try {
      const entries = (await fs.readdir(this.paths.handoffsDir))
        .filter((e) => /^\d+-/.test(e))
        .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
      return entries.length > 0 ? entries[entries.length - 1] : null;
    } catch {
      return null;
    }
  }

  /** Best-effort session id from the turn-idle marker the adapter's Stop hook writes. */
  private async currentSessionId(): Promise<string | null> {
    try {
      const raw = await fs.readFile(path.join(this.cwd, '.batonpass', 'turn-idle'), 'utf8');
      const parsed = JSON.parse(raw) as { sessionId?: string };
      return parsed.sessionId && parsed.sessionId.length > 0 ? parsed.sessionId : null;
    } catch {
      return null;
    }
  }

  private gitHead(): string | null {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: this.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch {
      return null;
    }
  }

  private gitDirty(): boolean {
    try {
      return execFileSync('git', ['status', '--porcelain'], { cwd: this.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0;
    } catch {
      return false;
    }
  }

  private async killChild(reason: 'respawn' | 'graceful-user-stop'): Promise<void> {
    this.setState('GRACEFUL_KILL');
    void reason;
    const child = this.child;
    if (!child) return;

    let exited = false;
    child.onExit(() => {
      exited = true;
    });
    child.write(this.adapter.gracefulExitKeys());

    const graceMs = 5000;
    const start = this.now();
    while (!exited && this.now() - start < graceMs) {
      await this.sleep(50);
    }
    if (!exited) {
      child.kill('SIGTERM');
      const start2 = this.now();
      while (!exited && this.now() - start2 < 2000) {
        await this.sleep(50);
      }
      if (!exited) child.kill('SIGKILL');
    }
    this.child = null;
  }
}
