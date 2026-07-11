import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handoffPrompt, type Adapter, type PtyLike, type SessionRef } from '@batonpass/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_AGENT_SCRIPT = path.join(__dirname, '..', '..', '..', 'examples', 'fake-agent', 'fake-agent.mjs');

function fakeUsageSource(session: SessionRef) {
  const usagePath = path.join(session.cwd, '.batonpass', 'fake-usage.json');
  return {
    async getUsage() {
      try {
        const text = await fs.readFile(usagePath, 'utf8');
        const data = JSON.parse(text) as { pct: number; tokens: number; max: number };
        return { ...data, source: 'fake-usage-file' };
      } catch {
        return null;
      }
    },
  };
}

async function fakeIsTurnIdle(session: SessionRef): Promise<boolean> {
  const markerPath = path.join(session.cwd, '.batonpass', 'turn-idle');
  try {
    const text = await fs.readFile(markerPath, 'utf8');
    const data = JSON.parse(text) as { idleAt: string };
    return new Date(data.idleAt).getTime() >= session.sinceMs;
  } catch {
    return false;
  }
}

/** Adapter implementation around examples/fake-agent, used only by orchestrator e2e tests. */
export class FakeAdapter implements Adapter {
  readonly id = 'claude-code' as const; // reuse the claude-code tool id; irrelevant for this test

  async detectInstalled(): Promise<boolean> {
    return true;
  }
  async isInstalled(): Promise<boolean> {
    return true;
  }
  async install(): Promise<{ backedUpFiles: string[] }> {
    return { backedUpFiles: [] };
  }
  async uninstall(): Promise<void> {}

  spawnCommand(_opts: { cwd: string }) {
    return { cmd: 'node', args: [FAKE_AGENT_SCRIPT] };
  }

  usageSource(session: SessionRef) {
    return fakeUsageSource(session);
  }

  async isTurnIdle(session: SessionRef): Promise<boolean> {
    return fakeIsTurnIdle(session);
  }

  async injectHandoffPrompt(pty: PtyLike, artifactPath: string): Promise<void> {
    pty.write(handoffPrompt(artifactPath));
    pty.write('\n');
  }

  resumeInjection(): 'session-start-hook' {
    return 'session-start-hook';
  }

  gracefulExitKeys(): string {
    return '/exit\n';
  }
}

/**
 * Adapter variant simulating a CLI with no context-injection hook (e.g. Hermes):
 * spawns fake-agent with its SessionStart-hook simulation disabled, so the
 * orchestrator's own `'pty-type'` resume path is what has to deliver the resume line.
 */
export class FakeAdapterPtyType implements Adapter {
  readonly id = 'hermes' as const;

  async detectInstalled(): Promise<boolean> {
    return true;
  }
  async isInstalled(): Promise<boolean> {
    return true;
  }
  async install(): Promise<{ backedUpFiles: string[] }> {
    return { backedUpFiles: [] };
  }
  async uninstall(): Promise<void> {}

  spawnCommand(_opts: { cwd: string }) {
    return { cmd: 'node', args: [FAKE_AGENT_SCRIPT], env: { FAKE_AGENT_SESSION_START_HOOK: '0' } };
  }

  usageSource(session: SessionRef) {
    return fakeUsageSource(session);
  }

  async isTurnIdle(session: SessionRef): Promise<boolean> {
    return fakeIsTurnIdle(session);
  }

  async injectHandoffPrompt(pty: PtyLike, artifactPath: string): Promise<void> {
    pty.write(handoffPrompt(artifactPath));
    pty.write('\n');
  }

  resumeInjection(): 'pty-type' {
    return 'pty-type';
  }

  gracefulExitKeys(): string {
    return '/exit\n';
  }
}
