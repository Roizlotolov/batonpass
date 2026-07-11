import type { ToolId } from './schema.js';
import type { UsageSource } from './usage/types.js';

/** Minimal PTY surface the adapter needs — kept narrow so adapters don't depend on node-pty's types. */
export interface PtyLike {
  write(data: string): void;
}

/** Identifies a running (or about-to-be-spawned) agent session for adapter methods. */
export interface SessionRef {
  cwd: string;
  sessionId: string | null;
  /** Reference instant; adapters use this to decide "idle *since* this point," not just "ever idle." */
  sinceMs: number;
}

export interface SpawnCommand {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Everything the orchestrator needs from a coding-agent CLI integration.
 * See docs/adapters.md for the contract each method must satisfy.
 */
export interface Adapter {
  id: ToolId;
  /** Is the underlying CLI installed and on PATH? */
  detectInstalled(): Promise<boolean>;
  /** Write hooks/plugin config + statusline chaining for this scope. Must be idempotent and non-destructive. */
  install(scope: 'user' | 'project', cwd: string): Promise<{ backedUpFiles: string[] }>;
  /** Remove everything `install` added (used by `batonpass init --uninstall`). */
  uninstall(scope: 'user' | 'project', cwd: string): Promise<void>;
  /** Is Batonpass already installed for this scope? */
  isInstalled(scope: 'user' | 'project', cwd: string): Promise<boolean>;
  spawnCommand(opts: { cwd: string }): SpawnCommand;
  usageSource(session: SessionRef): UsageSource;
  isTurnIdle(session: SessionRef): Promise<boolean>;
  /** Type the handoff-writing prompt into the PTY as if the user had, plus a trailing newline. */
  injectHandoffPrompt(pty: PtyLike, artifactPath: string): Promise<void>;
  /** How resumed sessions receive the handoff — both v1 adapters use their SessionStart-equivalent hook. */
  resumeInjection(): 'session-start-hook';
  /** Shell-safe key sequence to gracefully end the child CLI (e.g. `/exit\r` or Ctrl-D). */
  gracefulExitKeys(): string;
}
