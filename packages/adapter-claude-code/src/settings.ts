import { promises as fs } from 'node:fs';
import path from 'node:path';

export type HookEvent = 'SessionStart' | 'PreCompact' | 'Stop' | 'SessionEnd';

export interface HookEntry {
  hooks: { type: 'command'; command: string }[];
}

export interface ClaudeSettings {
  hooks?: Partial<Record<HookEvent, HookEntry[]>>;
  statusLine?: { type: 'command'; command: string };
  [key: string]: unknown;
}

const BATON_HOOK_SCRIPT_NAMES = ['session-start.mjs', 'pre-compact.mjs', 'stop.mjs', 'session-end.mjs'];
const BATON_STATUSLINE_SCRIPT_NAME = 'statusline.mjs';

function commandIsBatonpass(command: string, scriptNames: string[]): boolean {
  return scriptNames.some((name) => command.includes(name));
}

export async function readSettings(settingsPath: string): Promise<ClaudeSettings> {
  try {
    const text = await fs.readFile(settingsPath, 'utf8');
    return JSON.parse(text) as ClaudeSettings;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    // Corrupt settings.json: surface the error rather than silently clobbering user config.
    throw new Error(`Cannot parse existing ${settingsPath}: ${(err as Error).message}`);
  }
}

export async function backupSettings(settingsPath: string): Promise<string | null> {
  try {
    await fs.access(settingsPath);
  } catch {
    return null; // nothing to back up
  }
  const backupPath = `${settingsPath}.bak-${Date.now()}`;
  await fs.copyFile(settingsPath, backupPath);
  return backupPath;
}

function hasBatonpassHook(entries: HookEntry[] | undefined): boolean {
  return !!entries?.some((e) => e.hooks.some((h) => commandIsBatonpass(h.command, BATON_HOOK_SCRIPT_NAMES)));
}

/**
 * Merge Batonpass's hook commands + statusline into an existing settings object,
 * without clobbering any pre-existing (non-Batonpass) entries. Idempotent: calling
 * this twice with the same scriptsDir does not create duplicate hook entries.
 */
export function mergeBatonpassSettings(
  existing: ClaudeSettings,
  scriptsDir: string,
): { settings: ClaudeSettings; previousStatusLineCommand: string | null } {
  const settings: ClaudeSettings = { ...existing, hooks: { ...existing.hooks } };

  const hookScript: Record<HookEvent, string> = {
    SessionStart: path.join(scriptsDir, 'session-start.mjs'),
    PreCompact: path.join(scriptsDir, 'pre-compact.mjs'),
    Stop: path.join(scriptsDir, 'stop.mjs'),
    SessionEnd: path.join(scriptsDir, 'session-end.mjs'),
  };

  for (const [event, scriptPath] of Object.entries(hookScript) as [HookEvent, string][]) {
    const existingEntries = settings.hooks?.[event] ?? [];
    if (hasBatonpassHook(existingEntries)) continue; // already installed
    settings.hooks![event] = [
      ...existingEntries,
      { hooks: [{ type: 'command', command: `node "${scriptPath}"` }] },
    ];
  }

  let previousStatusLineCommand: string | null = null;
  const statuslineScript = path.join(scriptsDir, 'statusline.mjs');
  const existingStatusLine = existing.statusLine;
  if (existingStatusLine?.type === 'command' && !commandIsBatonpass(existingStatusLine.command, [BATON_STATUSLINE_SCRIPT_NAME])) {
    previousStatusLineCommand = existingStatusLine.command;
  }
  const chainPrefix = previousStatusLineCommand
    ? `BATON_CHAIN_STATUSLINE_COMMAND=${JSON.stringify(previousStatusLineCommand)} `
    : '';
  settings.statusLine = { type: 'command', command: `${chainPrefix}node "${statuslineScript}"` };

  return { settings, previousStatusLineCommand };
}

export function isBatonpassInstalled(settings: ClaudeSettings): boolean {
  const hookEvents: HookEvent[] = ['SessionStart', 'PreCompact', 'Stop', 'SessionEnd'];
  const hooksInstalled = hookEvents.every((e) => hasBatonpassHook(settings.hooks?.[e]));
  const statusLineInstalled = !!settings.statusLine && commandIsBatonpass(settings.statusLine.command, [BATON_STATUSLINE_SCRIPT_NAME]);
  return hooksInstalled && statusLineInstalled;
}

export async function writeSettingsAtomic(settingsPath: string, settings: ClaudeSettings): Promise<void> {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  const tmp = `${settingsPath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, settingsPath);
}
