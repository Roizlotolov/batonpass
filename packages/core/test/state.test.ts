import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BatonpassPaths,
  acquireLock,
  acquireLockForced,
  ensureBatonpassDir,
  isProcessAlive,
  loadConfig,
  readLockPid,
  readState,
  releaseLock,
  updateState,
  writeFileAtomic,
  writeState,
} from '../src/state.js';

describe('writeFileAtomic', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-state-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes content and leaves no temp files behind', async () => {
    const target = path.join(dir, 'nested', 'file.json');
    await writeFileAtomic(target, '{"a":1}');
    expect(await fs.readFile(target, 'utf8')).toBe('{"a":1}');
    const entries = await fs.readdir(path.dirname(target));
    expect(entries.every((e) => !e.endsWith('.tmp'))).toBe(true);
  });
});

describe('.batonpass dir + state.json', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-project-'));
  });
  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('ensureBatonpassDir creates handoffs dir', async () => {
    const paths = await ensureBatonpassDir(cwd);
    expect((await fs.stat(paths.handoffsDir)).isDirectory()).toBe(true);
  });

  it('readState returns defaults when no file exists', async () => {
    const paths = new BatonpassPaths(cwd);
    const state = await readState(paths);
    expect(state.lastSeq).toBe(0);
    expect(state.orchestratorPid).toBeNull();
  });

  it('writeState + readState round-trip', async () => {
    const paths = await ensureBatonpassDir(cwd);
    await writeState(paths, {
      version: '1',
      tool: 'claude-code',
      orchestratorPid: 1234,
      pendingHandoff: '1-x',
      lastSeq: 1,
      lastSessionId: 'sess-1',
    });
    const read = await readState(paths);
    expect(read.orchestratorPid).toBe(1234);
    expect(read.pendingHandoff).toBe('1-x');
  });

  it('updateState applies a transform atomically', async () => {
    const paths = await ensureBatonpassDir(cwd);
    await updateState(paths, (s) => ({ ...s, lastSeq: s.lastSeq + 1 }));
    const after = await updateState(paths, (s) => ({ ...s, lastSeq: s.lastSeq + 1 }));
    expect(after.lastSeq).toBe(2);
  });

  it('falls back to defaults for a corrupt state.json', async () => {
    const paths = await ensureBatonpassDir(cwd);
    await fs.writeFile(paths.stateJson, 'not json', 'utf8');
    const state = await readState(paths);
    expect(state.lastSeq).toBe(0);
  });
});

describe('config merging', () => {
  let cwd: string;
  let userConfigPath: string;
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-project-'));
    userConfigPath = path.join(cwd, 'user-config.json');
  });
  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('project config overrides user config', async () => {
    await fs.writeFile(userConfigPath, JSON.stringify({ threshold: 0.6, pollIntervalMs: 9999 }));
    const paths = await ensureBatonpassDir(cwd);
    await fs.writeFile(paths.configJson, JSON.stringify({ threshold: 0.9 }));
    const cfg = await loadConfig(cwd, userConfigPath);
    expect(cfg.threshold).toBe(0.9); // project wins
    expect(cfg.pollIntervalMs).toBe(9999); // user value preserved where project doesn't override
  });

  it('falls back to defaults when neither file exists', async () => {
    const cfg = await loadConfig(cwd, userConfigPath);
    expect(cfg.threshold).toBe(0.75);
  });
});

describe('lock file', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-project-'));
  });
  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('acquireLock succeeds once, fails on second attempt', async () => {
    const paths = new BatonpassPaths(cwd);
    expect(await acquireLock(paths)).toBe(true);
    expect(await acquireLock(paths)).toBe(false);
    expect(await readLockPid(paths)).toBe(process.pid);
    await releaseLock(paths);
    expect(await acquireLock(paths)).toBe(true);
  });

  it('isProcessAlive is true for self, false for a bogus pid', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(999_999)).toBe(false);
  });

  it('acquireLockForced reclaims a stale lock from a dead pid', async () => {
    const paths = new BatonpassPaths(cwd);
    await fs.mkdir(paths.root, { recursive: true });
    await fs.writeFile(paths.lockFile, '999999');
    expect(await acquireLockForced(paths)).toBe(true);
    expect(await readLockPid(paths)).toBe(process.pid);
  });

  it('acquireLockForced refuses to steal a lock from a live pid', async () => {
    const paths = new BatonpassPaths(cwd);
    await fs.mkdir(paths.root, { recursive: true });
    await fs.writeFile(paths.lockFile, String(process.pid));
    expect(await acquireLockForced(paths)).toBe(false);
  });
});
