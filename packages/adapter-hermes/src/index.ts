import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handoffPrompt, type Adapter, type PtyLike, type SessionRef, type Usage, type UsageSource } from '@batonpass/core';
import {
  enableCompressionThresholdOverride,
  getCompressionThreshold,
  isBatonpassThresholdOverrideApplied,
  isPluginEnabledInConfig,
  revertCompressionThresholdOverride,
} from './configyaml.js';
import { batonpassPluginInstallDir, hermesConfigYamlPath } from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_PLUGIN_DIR = path.join(__dirname, '..', 'plugin');
const PLUGIN_FILE_NAMES = ['plugin.yaml', '__init__.py'];

/** Batonpass's own default threshold (0.75) must stay below this so Batonpass fires first (§2.5). */
const BATONPASS_COMPRESSION_THRESHOLD_TARGET = 0.9;

/** Shape written by the helper plugin's `post_api_request`/`on_session_start` hooks to `.batonpass/usage.json`. */
interface HermesUsageJsonFile {
  pct: number | null;
  tokens: number;
  max: number | null;
  source?: string;
  updatedAt?: string;
}

/**
 * Push-based only (no pull-based fallback for v1 — Hermes' own transcript/session
 * file format is an unresolved implementation detail, see the package README).
 * `pct`/`max` are `null` when the plugin hasn't cached this model's context length
 * yet (`agent.model_metadata.get_cached_context_length`, §2.3) — treated the same
 * as "no reading yet," matching every other adapter's `getUsage(): null` contract.
 */
class HermesUsageSource implements UsageSource {
  constructor(private readonly usageJsonPath: string) {}

  async getUsage(): Promise<Usage | null> {
    try {
      const text = await fs.readFile(this.usageJsonPath, 'utf8');
      const data = JSON.parse(text) as HermesUsageJsonFile;
      if (data.pct === null || data.max === null) return null;
      return { pct: data.pct, tokens: data.tokens, max: data.max, source: 'hermes-post-api-request' };
    } catch {
      return null;
    }
  }
}

async function backupFile(filePath: string): Promise<string | null> {
  try {
    await fs.access(filePath);
  } catch {
    return null;
  }
  const backupPath = `${filePath}.bak-${Date.now()}`;
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

/**
 * Hermes Agent adapter. Per PLAN-hermes.md (re-verified against a fresh clone,
 * 2026-07-11): Hermes has no context-injection hook, so `resumeInjection()` is
 * `'pty-type'` — the orchestrator itself types the resume line (see
 * `resumePromptPtyType` in `@batonpass/core` and the orchestrator's
 * `maybeInjectPtyTypeResume`). Hermes auto-compresses context at 50% by default and
 * ends+forks the session when it does, so `install()` raises that threshold to 90%
 * (staying above Batonpass's own 75% default so Batonpass fires first). Hermes
 * plugins and config are user-scope only (`~/.hermes`, no project-local equivalent).
 */
export class HermesAdapter implements Adapter {
  readonly id = 'hermes' as const;

  async detectInstalled(): Promise<boolean> {
    const result = spawnSync('hermes', ['--version'], { encoding: 'utf8' });
    return result.status === 0;
  }

  async isInstalled(scope: 'user' | 'project', _cwd: string): Promise<boolean> {
    if (scope === 'project') return false; // no project scope — see install()
    const pluginInstalled = await fs
      .access(path.join(batonpassPluginInstallDir(), '__init__.py'))
      .then(() => true)
      .catch(() => false);
    if (!pluginInstalled) return false;
    const configText = await fs.readFile(hermesConfigYamlPath(), 'utf8').catch(() => '');
    return isPluginEnabledInConfig(configText, 'batonpass');
  }

  async install(scope: 'user' | 'project', _cwd: string): Promise<{ backedUpFiles: string[] }> {
    if (process.platform === 'win32') {
      throw new Error(
        'The Hermes adapter has not been verified on Windows (unlike Codex hooks, this is not a documented upstream restriction — just an untested path); refusing rather than guessing.',
      );
    }
    if (scope === 'project') {
      throw new Error(
        "Hermes has no project-scope config — plugins and config.yaml live under ~/.hermes (or $HERMES_HOME), per-user only. Run 'batonpass init --agent hermes --user' instead.",
      );
    }

    const backedUpFiles: string[] = [];

    const pluginDir = batonpassPluginInstallDir();
    await fs.mkdir(pluginDir, { recursive: true });
    await Promise.all(
      PLUGIN_FILE_NAMES.map((name) => fs.copyFile(path.join(BUNDLED_PLUGIN_DIR, name), path.join(pluginDir, name))),
    );

    // Shell out to the real command rather than hand-editing `plugins.enabled`: there is
    // no plugin_config/get_config() mechanism in Hermes (§2.2 re-verification), and
    // guessing the writer's exact config shape was explicitly flagged as risky there.
    // `--no-allow-tool-override` skips the interactive privileged-capability prompt that
    // `hermes plugins enable` shows for any non-bundled plugin — this plugin only
    // registers hooks/a command, never a tool override, so there is nothing to grant.
    const enableResult = spawnSync('hermes', ['plugins', 'enable', 'batonpass', '--no-allow-tool-override'], {
      encoding: 'utf8',
    });
    if (enableResult.status !== 0) {
      const detail = enableResult.error?.message ?? enableResult.stderr?.trim() ?? `exit code ${String(enableResult.status)}`;
      throw new Error(
        `Batonpass copied its plugin to ${pluginDir} but could not run 'hermes plugins enable batonpass --no-allow-tool-override' (${detail}). ` +
          "Run that command yourself, then re-run 'batonpass doctor' to confirm.",
      );
    }

    const configPath = hermesConfigYamlPath();
    const configText = await fs.readFile(configPath, 'utf8').catch(() => '');
    const currentThreshold = getCompressionThreshold(configText);
    if (currentThreshold === null || currentThreshold < BATONPASS_COMPRESSION_THRESHOLD_TARGET) {
      const configBackup = await backupFile(configPath);
      if (configBackup) backedUpFiles.push(configBackup);
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        enableCompressionThresholdOverride(configText, BATONPASS_COMPRESSION_THRESHOLD_TARGET),
        'utf8',
      );
    }

    return { backedUpFiles };
  }

  async uninstall(scope: 'user' | 'project', _cwd: string): Promise<void> {
    if (scope === 'project') return;

    const configPath = hermesConfigYamlPath();
    const configText = await fs.readFile(configPath, 'utf8').catch(() => '');
    if (isBatonpassThresholdOverrideApplied(configText)) {
      await backupFile(configPath);
      await fs.writeFile(configPath, revertCompressionThresholdOverride(configText), 'utf8');
    }

    // Best-effort: if the binary is gone or the plugin was already disabled, removing
    // the plugin directory below is what actually stops it from loading.
    spawnSync('hermes', ['plugins', 'disable', 'batonpass'], { encoding: 'utf8' });

    await fs.rm(batonpassPluginInstallDir(), { recursive: true, force: true });
  }

  spawnCommand(_opts: { cwd: string }): { cmd: string; args: string[] } {
    return { cmd: 'hermes', args: [] };
  }

  usageSource(session: SessionRef) {
    return new HermesUsageSource(path.join(session.cwd, '.batonpass', 'usage.json'));
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

  resumeInjection(): 'pty-type' {
    return 'pty-type';
  }

  gracefulExitKeys(): string {
    return '/quit\r';
  }
}

export { batonpassPluginInstallDir, hermesConfigYamlPath, hermesHomeDir, hermesPluginsDir } from './paths.js';
export * from './configyaml.js';
