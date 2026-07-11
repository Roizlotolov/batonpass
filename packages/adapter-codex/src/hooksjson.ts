import { promises as fs } from 'node:fs';
import path from 'node:path';

export type CodexHookEvent = 'SessionStart' | 'Stop';

export interface CodexHookEntry {
  matcher?: string;
  hooks: { type: 'command'; command: string; statusMessage?: string; timeout?: number }[];
}

export interface CodexHooksFile {
  hooks?: Partial<Record<CodexHookEvent, CodexHookEntry[]>>;
  [key: string]: unknown;
}

const BATON_HOOK_SCRIPT_NAMES = ['session-start.mjs', 'stop.mjs'];

function commandIsBatonpass(command: string): boolean {
  return BATON_HOOK_SCRIPT_NAMES.some((name) => command.includes(name));
}

function hasBatonpassHook(entries: CodexHookEntry[] | undefined): boolean {
  return !!entries?.some((e) => e.hooks.some((h) => commandIsBatonpass(h.command)));
}

export async function readHooksJson(hooksJsonPath: string): Promise<CodexHooksFile> {
  try {
    const text = await fs.readFile(hooksJsonPath, 'utf8');
    return JSON.parse(text) as CodexHooksFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Cannot parse existing ${hooksJsonPath}: ${(err as Error).message}`);
  }
}

export async function backupFile(filePath: string): Promise<string | null> {
  try {
    await fs.access(filePath);
  } catch {
    return null;
  }
  const backupPath = `${filePath}.bak-${Date.now()}`;
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

/** Merge Batonpass's SessionStart + Stop hook commands into an existing hooks.json object. Idempotent. */
export function mergeBatonpassHooks(existing: CodexHooksFile, hooksDir: string): CodexHooksFile {
  const hooks: Partial<Record<CodexHookEvent, CodexHookEntry[]>> = { ...existing.hooks };

  const sessionStartEntries = hooks.SessionStart ?? [];
  if (!hasBatonpassHook(sessionStartEntries)) {
    hooks.SessionStart = [
      ...sessionStartEntries,
      {
        matcher: 'startup|resume',
        hooks: [{ type: 'command', command: `node "${path.join(hooksDir, 'session-start.mjs')}"` }],
      },
    ];
  }

  const stopEntries = hooks.Stop ?? [];
  if (!hasBatonpassHook(stopEntries)) {
    hooks.Stop = [...stopEntries, { hooks: [{ type: 'command', command: `node "${path.join(hooksDir, 'stop.mjs')}"` }] }];
  }

  return { ...existing, hooks };
}

export function isBatonpassHooksInstalled(hooksFile: CodexHooksFile): boolean {
  return hasBatonpassHook(hooksFile.hooks?.SessionStart) && hasBatonpassHook(hooksFile.hooks?.Stop);
}

export function removeBatonpassHooks(existing: CodexHooksFile): CodexHooksFile {
  const hooks: Partial<Record<CodexHookEvent, CodexHookEntry[]>> = { ...existing.hooks };
  for (const event of ['SessionStart', 'Stop'] as const) {
    const entries = hooks[event];
    if (!entries) continue;
    const filtered = entries.filter((e) => !e.hooks.some((h) => commandIsBatonpass(h.command)));
    if (filtered.length > 0) hooks[event] = filtered;
    else delete hooks[event];
  }
  return { ...existing, hooks };
}

export async function writeHooksJsonAtomic(hooksJsonPath: string, hooksFile: CodexHooksFile): Promise<void> {
  await fs.mkdir(path.dirname(hooksJsonPath), { recursive: true });
  const tmp = `${hooksJsonPath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(hooksFile, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, hooksJsonPath);
}
