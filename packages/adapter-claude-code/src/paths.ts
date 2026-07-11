import os from 'node:os';
import path from 'node:path';

export function claudeProjectsDir(homedir = os.homedir()): string {
  return path.join(homedir, '.claude', 'projects');
}

/** Claude Code slugifies cwd for its transcript directory: every non-alphanumeric char -> `-`. */
export function slugifyProjectPath(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function transcriptDirForCwd(cwd: string, homedir = os.homedir()): string {
  return path.join(claudeProjectsDir(homedir), slugifyProjectPath(cwd));
}

export function userSettingsPath(homedir = os.homedir()): string {
  return path.join(homedir, '.claude', 'settings.json');
}

export function projectSettingsPath(cwd: string): string {
  return path.join(cwd, '.claude', 'settings.json');
}

export function batonpassScriptsInstallDir(scope: 'user' | 'project', cwd: string, homedir = os.homedir()): string {
  return scope === 'user' ? path.join(homedir, '.claude', 'batonpass', 'scripts') : path.join(cwd, '.claude', 'batonpass', 'scripts');
}
