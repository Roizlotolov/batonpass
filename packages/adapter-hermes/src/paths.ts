import os from 'node:os';
import path from 'node:path';

/**
 * Mirrors `get_hermes_home()` (`hermes_constants.py:55-110`, re-verified 2026-07-11
 * against a fresh clone): `HERMES_HOME` env var wins; otherwise `~/.hermes` on
 * non-Windows, `%LOCALAPPDATA%\hermes` (falling back to `~/AppData/Local/hermes`)
 * on Windows (`_get_platform_default_hermes_home`, `hermes_constants.py:46-52`).
 */
export function hermesHomeDir(homedir = os.homedir()): string {
  const override = process.env.HERMES_HOME?.trim();
  if (override) return override;
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    return path.join(localAppData || path.join(homedir, 'AppData', 'Local'), 'hermes');
  }
  return path.join(homedir, '.hermes');
}

export function hermesConfigYamlPath(homedir = os.homedir()): string {
  return path.join(hermesHomeDir(homedir), 'config.yaml');
}

export function hermesPluginsDir(homedir = os.homedir()): string {
  return path.join(hermesHomeDir(homedir), 'plugins');
}

/** Batonpass's helper plugin lives at `<HERMES_HOME>/plugins/batonpass/`, plugin name `batonpass`. */
export function batonpassPluginInstallDir(homedir = os.homedir()): string {
  return path.join(hermesPluginsDir(homedir), 'batonpass');
}
