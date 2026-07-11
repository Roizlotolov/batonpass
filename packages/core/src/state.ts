import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ConfigSchema, StateJsonSchema, type Config, type StateJson } from './schema.js';

/** Write a file atomically: write to a temp sibling, then rename over the target. */
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, filePath);
}

export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    // Corrupt/partial JSON is treated the same as "no file yet" — callers fall back to defaults.
    return null;
  }
}

/** Resolves the well-known paths inside a project's `.batonpass/` directory. */
export class BatonpassPaths {
  readonly root: string;
  readonly handoffsDir: string;
  readonly stateJson: string;
  readonly configJson: string;
  readonly usageJson: string;
  readonly turnIdleMarker: string;
  readonly compactBlockedMarker: string;
  readonly lockFile: string;

  constructor(cwd: string) {
    this.root = path.join(cwd, '.batonpass');
    this.handoffsDir = path.join(this.root, 'handoffs');
    this.stateJson = path.join(this.root, 'state.json');
    this.configJson = path.join(this.root, 'config.json');
    this.usageJson = path.join(this.root, 'usage.json');
    this.turnIdleMarker = path.join(this.root, 'turn-idle');
    this.compactBlockedMarker = path.join(this.root, 'compact-blocked');
    this.lockFile = path.join(this.root, 'orchestrator.lock');
  }
}

export async function ensureBatonpassDir(cwd: string): Promise<BatonpassPaths> {
  const paths = new BatonpassPaths(cwd);
  await fs.mkdir(paths.handoffsDir, { recursive: true });
  return paths;
}

const DEFAULT_STATE: StateJson = StateJsonSchema.parse({});

export async function readState(paths: BatonpassPaths): Promise<StateJson> {
  const raw = await readJsonIfExists<unknown>(paths.stateJson);
  if (raw === null) return { ...DEFAULT_STATE };
  const result = StateJsonSchema.safeParse(raw);
  return result.success ? result.data : { ...DEFAULT_STATE };
}

export async function writeState(paths: BatonpassPaths, state: StateJson): Promise<void> {
  const validated = StateJsonSchema.parse(state);
  await writeFileAtomic(paths.stateJson, JSON.stringify(validated, null, 2) + '\n');
}

export async function updateState(
  paths: BatonpassPaths,
  fn: (current: StateJson) => StateJson,
): Promise<StateJson> {
  const current = await readState(paths);
  const next = fn(current);
  await writeState(paths, next);
  return next;
}

/** Merge project config (`.batonpass/config.json`) over user config (`~/.config/batonpass/config.json`) over defaults. */
export async function loadConfig(cwd: string, userConfigPath: string): Promise<Config> {
  const userRaw = await readJsonIfExists<unknown>(userConfigPath);
  const projectRaw = await readJsonIfExists<unknown>(new BatonpassPaths(cwd).configJson);
  const merged = {
    ...(typeof userRaw === 'object' && userRaw ? userRaw : {}),
    ...(typeof projectRaw === 'object' && projectRaw ? projectRaw : {}),
  };
  return ConfigSchema.parse(merged);
}

export function defaultUserConfigPath(homedir: string): string {
  return path.join(homedir, '.config', 'batonpass', 'config.json');
}

/**
 * Very small advisory lock: an exclusive-create marker file containing our PID.
 * Callers should check `isProcessAlive` on an existing lock's PID to detect stale locks.
 */
export async function acquireLock(paths: BatonpassPaths): Promise<boolean> {
  try {
    await fs.mkdir(paths.root, { recursive: true });
    await fs.writeFile(paths.lockFile, String(process.pid), { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

export async function readLockPid(paths: BatonpassPaths): Promise<number | null> {
  try {
    const text = await fs.readFile(paths.lockFile, 'utf8');
    const pid = Number.parseInt(text.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function releaseLock(paths: BatonpassPaths): Promise<void> {
  await fs.rm(paths.lockFile, { force: true });
}

/** Force-acquire the lock if the existing holder's PID is dead (stale lock recovery). */
export async function acquireLockForced(paths: BatonpassPaths): Promise<boolean> {
  const ok = await acquireLock(paths);
  if (ok) return true;
  const pid = await readLockPid(paths);
  if (pid !== null && !isProcessAlive(pid)) {
    await releaseLock(paths);
    return acquireLock(paths);
  }
  return false;
}
