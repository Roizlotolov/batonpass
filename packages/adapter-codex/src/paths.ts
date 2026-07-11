import os from 'node:os';
import path from 'node:path';

export function codexHomeDir(homedir = os.homedir()): string {
  return path.join(homedir, '.codex');
}

export function userHooksJsonPath(homedir = os.homedir()): string {
  return path.join(codexHomeDir(homedir), 'hooks.json');
}

export function projectHooksJsonPath(cwd: string): string {
  return path.join(cwd, '.codex', 'hooks.json');
}

export function userConfigTomlPath(homedir = os.homedir()): string {
  return path.join(codexHomeDir(homedir), 'config.toml');
}

export function codexSessionsDir(homedir = os.homedir()): string {
  return path.join(codexHomeDir(homedir), 'sessions');
}

export function batonpassHooksInstallDir(scope: 'user' | 'project', cwd: string, homedir = os.homedir()): string {
  return scope === 'user' ? path.join(codexHomeDir(homedir), 'batonpass', 'hooks') : path.join(cwd, '.codex', 'batonpass', 'hooks');
}
