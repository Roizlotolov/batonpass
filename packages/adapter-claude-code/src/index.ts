import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClaudeUsageSource,
  findLatestTranscript,
  handoffPrompt,
  type Adapter,
  type PtyLike,
  type SessionRef,
} from '@batonpass/core';
import { batonpassScriptsInstallDir, projectSettingsPath, transcriptDirForCwd, userSettingsPath } from './paths.js';
import {
  backupSettings,
  isBatonpassInstalled,
  mergeBatonpassSettings,
  readSettings,
  writeSettingsAtomic,
} from './settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_SCRIPTS_DIR = path.join(__dirname, '..', 'plugin', 'scripts');
const HOOK_SCRIPT_NAMES = ['_lib.mjs', 'session-start.mjs', 'pre-compact.mjs', 'stop.mjs', 'session-end.mjs', 'statusline.mjs'];

function settingsPathFor(scope: 'user' | 'project', cwd: string): string {
  return scope === 'user' ? userSettingsPath() : projectSettingsPath(cwd);
}

async function ensureGitignoreEntry(cwd: string): Promise<void> {
  const gitignorePath = path.join(cwd, '.gitignore');
  const entry = '.batonpass/';
  let text = '';
  try {
    text = await fs.readFile(gitignorePath, 'utf8');
  } catch {
    // no .gitignore yet — fine, we'll create one only if the project looks like a git repo
  }
  if (text.split('\n').some((l) => l.trim() === entry)) return;
  const hasGitDir = await fs
    .stat(path.join(cwd, '.git'))
    .then(() => true)
    .catch(() => false);
  if (!hasGitDir && text === '') return; // don't invent a .gitignore in a non-git, no-gitignore dir
  const next = text.length > 0 && !text.endsWith('\n') ? `${text}\n${entry}\n` : `${text}${entry}\n`;
  await fs.writeFile(gitignorePath, next, 'utf8');
}

export class ClaudeCodeAdapter implements Adapter {
  readonly id = 'claude-code' as const;

  async detectInstalled(): Promise<boolean> {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync('claude', ['--version'], { encoding: 'utf8' });
    return result.status === 0;
  }

  async isInstalled(scope: 'user' | 'project', cwd: string): Promise<boolean> {
    const settings = await readSettings(settingsPathFor(scope, cwd));
    return isBatonpassInstalled(settings);
  }

  async install(scope: 'user' | 'project', cwd: string): Promise<{ backedUpFiles: string[] }> {
    const scriptsDir = batonpassScriptsInstallDir(scope, cwd);
    await fs.mkdir(scriptsDir, { recursive: true });
    await Promise.all(
      HOOK_SCRIPT_NAMES.map(async (name) => {
        await fs.copyFile(path.join(BUNDLED_SCRIPTS_DIR, name), path.join(scriptsDir, name));
      }),
    );

    const settingsPath = settingsPathFor(scope, cwd);
    const backedUpFiles: string[] = [];
    const backupPath = await backupSettings(settingsPath);
    if (backupPath) backedUpFiles.push(backupPath);

    const existing = await readSettings(settingsPath);
    const { settings } = mergeBatonpassSettings(existing, scriptsDir);
    await writeSettingsAtomic(settingsPath, settings);

    if (scope === 'project') await ensureGitignoreEntry(cwd);

    return { backedUpFiles };
  }

  async uninstall(scope: 'user' | 'project', cwd: string): Promise<void> {
    const settingsPath = settingsPathFor(scope, cwd);
    const existing = await readSettings(settingsPath);
    if (!existing.hooks && !existing.statusLine) return;

    const cleaned = { ...existing, hooks: { ...existing.hooks } };
    for (const event of ['SessionStart', 'PreCompact', 'Stop', 'SessionEnd'] as const) {
      const entries = cleaned.hooks?.[event];
      if (!entries) continue;
      const filtered = entries.filter(
        (e) => !e.hooks.some((h) => HOOK_SCRIPT_NAMES.some((name) => h.command.includes(name))),
      );
      if (filtered.length > 0) cleaned.hooks![event] = filtered;
      else delete cleaned.hooks![event];
    }
    if (cleaned.statusLine?.command.includes('statusline.mjs')) {
      delete cleaned.statusLine;
    }
    await backupSettings(settingsPath);
    await writeSettingsAtomic(settingsPath, cleaned);

    const scriptsDir = batonpassScriptsInstallDir(scope, cwd);
    await fs.rm(scriptsDir, { recursive: true, force: true });
  }

  spawnCommand(_opts: { cwd: string }): { cmd: string; args: string[] } {
    // Bare `claude`: resume content is delivered via the SessionStart hook, not a CLI flag,
    // so this is stable regardless of how `claude "<prompt>"` behaves on a given version.
    return { cmd: 'claude', args: [] };
  }

  usageSource(session: SessionRef) {
    const usageJsonPath = path.join(session.cwd, '.batonpass', 'usage.json');
    const transcriptResolver = async () => {
      const dir = transcriptDirForCwd(session.cwd);
      return findLatestTranscript(dir);
    };
    return new ClaudeUsageSource(usageJsonPath, transcriptResolver);
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
    return '/exit\r';
  }
}

export { batonpassScriptsInstallDir, projectSettingsPath, transcriptDirForCwd, userSettingsPath } from './paths.js';
export * from './settings.js';
