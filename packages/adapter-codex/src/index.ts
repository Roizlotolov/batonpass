import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CodexUsageSource,
  handoffPrompt,
  type Adapter,
  type PtyLike,
  type SessionRef,
} from '@batonpass/core';
import { enableCodexHooks, isCodexHooksEnabled } from './configtoml.js';
import { findLatestRolloutForCwd } from './rollout.js';
import {
  backupFile,
  isBatonpassHooksInstalled,
  mergeBatonpassHooks,
  readHooksJson,
  removeBatonpassHooks,
  writeHooksJsonAtomic,
} from './hooksjson.js';
import {
  batonpassHooksInstallDir,
  codexSessionsDir,
  projectHooksJsonPath,
  userConfigTomlPath,
  userHooksJsonPath,
} from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_SCRIPTS_DIR = path.join(__dirname, '..', 'hooks', 'scripts');
const HOOK_SCRIPT_NAMES = ['_lib.mjs', 'session-start.mjs', 'stop.mjs'];

function hooksJsonPathFor(scope: 'user' | 'project', cwd: string): string {
  return scope === 'user' ? userHooksJsonPath() : projectHooksJsonPath(cwd);
}

/**
 * Codex adapter. Per the §2.2 re-verification (2026-07-11): hooks are experimental,
 * gated behind `[features] codex_hooks = true` in `~/.codex/config.toml`, disabled
 * on Windows, and there is no PreCompact-equivalent hook shipped today — so this
 * adapter (unlike Claude Code's) relies purely on usage-threshold polling of the
 * rollout JSONL plus the Stop-hook idle marker; it never tries to block Codex's
 * own compaction.
 */
export class CodexAdapter implements Adapter {
  readonly id = 'codex' as const;

  async detectInstalled(): Promise<boolean> {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync('codex', ['--version'], { encoding: 'utf8' });
    return result.status === 0;
  }

  async isInstalled(scope: 'user' | 'project', cwd: string): Promise<boolean> {
    const hooksFile = await readHooksJson(hooksJsonPathFor(scope, cwd));
    if (!isBatonpassHooksInstalled(hooksFile)) return false;
    const configText = await fs.readFile(userConfigTomlPath(), 'utf8').catch(() => '');
    return isCodexHooksEnabled(configText);
  }

  async install(scope: 'user' | 'project', cwd: string): Promise<{ backedUpFiles: string[] }> {
    if (process.platform === 'win32') {
      throw new Error('Codex hooks are disabled on Windows upstream; the Codex adapter is not supported there.');
    }

    const backedUpFiles: string[] = [];

    const hooksDir = batonpassHooksInstallDir(scope, cwd);
    await fs.mkdir(hooksDir, { recursive: true });
    await Promise.all(
      HOOK_SCRIPT_NAMES.map((name) => fs.copyFile(path.join(BUNDLED_SCRIPTS_DIR, name), path.join(hooksDir, name))),
    );

    const hooksJsonPath = hooksJsonPathFor(scope, cwd);
    const hooksBackup = await backupFile(hooksJsonPath);
    if (hooksBackup) backedUpFiles.push(hooksBackup);
    const existingHooks = await readHooksJson(hooksJsonPath);
    await writeHooksJsonAtomic(hooksJsonPath, mergeBatonpassHooks(existingHooks, hooksDir));

    // Feature flag lives in user-scope config.toml regardless of hook install scope —
    // Codex has no project-local feature-flag file. Only touch the single boolean key;
    // always back up first (see PLAN.md §9: never destructively edit user config).
    const configPath = userConfigTomlPath();
    const configText = await fs.readFile(configPath, 'utf8').catch(() => '');
    if (!isCodexHooksEnabled(configText)) {
      const configBackup = await backupFile(configPath);
      if (configBackup) backedUpFiles.push(configBackup);
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, enableCodexHooks(configText), 'utf8');
    }

    return { backedUpFiles };
  }

  async uninstall(scope: 'user' | 'project', cwd: string): Promise<void> {
    const hooksJsonPath = hooksJsonPathFor(scope, cwd);
    const existing = await readHooksJson(hooksJsonPath);
    await backupFile(hooksJsonPath);
    await writeHooksJsonAtomic(hooksJsonPath, removeBatonpassHooks(existing));
    // Deliberately does NOT revert `codex_hooks` in config.toml or delete the feature
    // flag: other tools/hooks the user set up independently may depend on it staying on.
    await fs.rm(batonpassHooksInstallDir(scope, cwd), { recursive: true, force: true });
  }

  spawnCommand(_opts: { cwd: string }): { cmd: string; args: string[] } {
    return { cmd: 'codex', args: [] };
  }

  usageSource(session: SessionRef) {
    const resolver = async () => findLatestRolloutForCwd(codexSessionsDir(), session.cwd);
    return new CodexUsageSource(resolver);
  }

  async isTurnIdle(session: SessionRef): Promise<boolean> {
    const markerPath = path.join(session.cwd, '.batonpass', 'turn-idle');
    try {
      const text = await fs.readFile(markerPath, 'utf8');
      const data = JSON.parse(text) as { idleAt: string };
      return new Date(data.idleAt).getTime() >= session.sinceMs;
    } catch {
      return false;
    }
  }

  async injectHandoffPrompt(pty: PtyLike, artifactPath: string): Promise<void> {
    pty.write(handoffPrompt(artifactPath));
    pty.write('\r');
  }

  resumeInjection(): 'session-start-hook' {
    return 'session-start-hook';
  }

  gracefulExitKeys(): string {
    return '\x04'; // Ctrl-D (EOT) — Codex's interactive TUI exit
  }
}

export * from './configtoml.js';
export * from './hooksjson.js';
export * from './paths.js';
