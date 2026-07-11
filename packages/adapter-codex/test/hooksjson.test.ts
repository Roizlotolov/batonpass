import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupFile,
  isBatonpassHooksInstalled,
  mergeBatonpassHooks,
  readHooksJson,
  removeBatonpassHooks,
  writeHooksJsonAtomic,
} from '../src/hooksjson.js';

describe('mergeBatonpassHooks', () => {
  it('adds SessionStart (with startup|resume matcher) and Stop to an empty file', () => {
    const merged = mergeBatonpassHooks({}, '/hooks');
    expect(merged.hooks?.SessionStart?.[0]?.matcher).toBe('startup|resume');
    expect(merged.hooks?.SessionStart?.[0]?.hooks[0]?.command).toContain('session-start.mjs');
    expect(merged.hooks?.Stop?.[0]?.hooks[0]?.command).toContain('stop.mjs');
    expect(isBatonpassHooksInstalled(merged)).toBe(true);
  });

  it('preserves pre-existing non-Batonpass hooks for the same event', () => {
    const existing = { hooks: { Stop: [{ hooks: [{ type: 'command' as const, command: 'echo user-stop-hook' }] }] } };
    const merged = mergeBatonpassHooks(existing, '/hooks');
    expect(merged.hooks?.Stop).toHaveLength(2);
    expect(merged.hooks?.Stop?.[0]?.hooks[0]?.command).toBe('echo user-stop-hook');
  });

  it('is idempotent', () => {
    const once = mergeBatonpassHooks({}, '/hooks');
    const twice = mergeBatonpassHooks(once, '/hooks');
    expect(twice.hooks?.SessionStart).toHaveLength(1);
    expect(twice.hooks?.Stop).toHaveLength(1);
  });
});

describe('removeBatonpassHooks', () => {
  it('removes only Batonpass entries, keeping user entries and dropping the key if empty', () => {
    const withUser = mergeBatonpassHooks(
      { hooks: { Stop: [{ hooks: [{ type: 'command' as const, command: 'echo user-stop-hook' }] }] } },
      '/hooks',
    );
    const cleaned = removeBatonpassHooks(withUser);
    expect(cleaned.hooks?.Stop).toHaveLength(1);
    expect(cleaned.hooks?.Stop?.[0]?.hooks[0]?.command).toBe('echo user-stop-hook');
    expect(cleaned.hooks?.SessionStart).toBeUndefined(); // no user entries existed for this event
    expect(isBatonpassHooksInstalled(cleaned)).toBe(false);
  });
});

describe('readHooksJson / writeHooksJsonAtomic / backupFile', () => {
  let dir: string;
  let hooksPath: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-codex-hooks-'));
    hooksPath = path.join(dir, 'hooks.json');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('readHooksJson returns {} for a nonexistent file', async () => {
    expect(await readHooksJson(hooksPath)).toEqual({});
  });

  it('throws on corrupt hooks.json rather than silently clobbering', async () => {
    await fs.writeFile(hooksPath, 'not json');
    await expect(readHooksJson(hooksPath)).rejects.toThrow();
  });

  it('round-trips through writeHooksJsonAtomic', async () => {
    await writeHooksJsonAtomic(hooksPath, mergeBatonpassHooks({}, '/hooks'));
    const read = await readHooksJson(hooksPath);
    expect(isBatonpassHooksInstalled(read)).toBe(true);
  });

  it('backupFile returns null when nothing exists, else copies it', async () => {
    expect(await backupFile(hooksPath)).toBeNull();
    await writeHooksJsonAtomic(hooksPath, { hooks: {} });
    const backup = await backupFile(hooksPath);
    expect(backup).toContain('.bak-');
  });
});
