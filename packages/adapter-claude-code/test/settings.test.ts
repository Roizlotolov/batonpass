import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BATON_PERMISSION_RULES,
  backupSettings,
  isBatonpassInstalled,
  mergeBatonpassSettings,
  readSettings,
  writeSettingsAtomic,
} from '../src/settings.js';

describe('mergeBatonpassSettings', () => {
  it('adds all 4 hook events + statusline into an empty settings object', () => {
    const { settings } = mergeBatonpassSettings({}, '/scripts');
    expect(settings.hooks?.SessionStart?.[0]?.hooks[0]?.command).toContain('session-start.mjs');
    expect(settings.hooks?.PreCompact?.[0]?.hooks[0]?.command).toContain('pre-compact.mjs');
    expect(settings.hooks?.Stop?.[0]?.hooks[0]?.command).toContain('stop.mjs');
    expect(settings.hooks?.SessionEnd?.[0]?.hooks[0]?.command).toContain('session-end.mjs');
    expect(settings.statusLine?.command).toContain('statusline.mjs');
    expect(isBatonpassInstalled(settings)).toBe(true);
  });

  it('preserves pre-existing non-Batonpass hooks for the same event', () => {
    const existing = {
      hooks: { SessionStart: [{ hooks: [{ type: 'command' as const, command: 'echo user-hook' }] }] },
    };
    const { settings } = mergeBatonpassSettings(existing, '/scripts');
    expect(settings.hooks?.SessionStart).toHaveLength(2);
    expect(settings.hooks?.SessionStart?.[0]?.hooks[0]?.command).toBe('echo user-hook');
  });

  it('is idempotent — merging twice does not duplicate entries', () => {
    const once = mergeBatonpassSettings({}, '/scripts').settings;
    const twice = mergeBatonpassSettings(once, '/scripts').settings;
    expect(twice.hooks?.SessionStart).toHaveLength(1);
  });

  it('pre-authorizes .batonpass writes without clobbering existing permission rules', () => {
    const existing = { permissions: { allow: ['Bash(git:*)'] } };
    const { settings } = mergeBatonpassSettings(existing, '/scripts');
    expect(settings.permissions?.allow).toContain('Bash(git:*)');
    for (const rule of BATON_PERMISSION_RULES) {
      expect(settings.permissions?.allow).toContain(rule);
    }
  });

  it('does not duplicate permission rules when merged twice', () => {
    const once = mergeBatonpassSettings({}, '/scripts').settings;
    const twice = mergeBatonpassSettings(once, '/scripts').settings;
    const writeRules = twice.permissions?.allow?.filter((r) => r === BATON_PERMISSION_RULES[0]) ?? [];
    expect(writeRules).toHaveLength(1);
  });

  it('chains a pre-existing statusline command via BATON_CHAIN_STATUSLINE_COMMAND', () => {
    const existing = { statusLine: { type: 'command' as const, command: 'my-old-statusline.sh' } };
    const { settings, previousStatusLineCommand } = mergeBatonpassSettings(existing, '/scripts');
    expect(previousStatusLineCommand).toBe('my-old-statusline.sh');
    expect(settings.statusLine?.command).toContain('BATON_CHAIN_STATUSLINE_COMMAND=');
    expect(settings.statusLine?.command).toContain('my-old-statusline.sh');
  });
});

describe('readSettings / writeSettingsAtomic / backupSettings', () => {
  let dir: string;
  let settingsPath: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-settings-'));
    settingsPath = path.join(dir, 'settings.json');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('readSettings returns {} for a nonexistent file', async () => {
    expect(await readSettings(settingsPath)).toEqual({});
  });

  it('throws (does not silently clobber) on corrupt settings.json', async () => {
    await fs.writeFile(settingsPath, 'not json');
    await expect(readSettings(settingsPath)).rejects.toThrow();
  });

  it('writeSettingsAtomic then readSettings round-trips', async () => {
    await writeSettingsAtomic(settingsPath, { statusLine: { type: 'command', command: 'x' } });
    const read = await readSettings(settingsPath);
    expect(read.statusLine?.command).toBe('x');
  });

  it('backupSettings returns null when there is nothing to back up, else copies the file', async () => {
    expect(await backupSettings(settingsPath)).toBeNull();
    await writeSettingsAtomic(settingsPath, { statusLine: { type: 'command', command: 'x' } });
    const backupPath = await backupSettings(settingsPath);
    expect(backupPath).toContain('.bak-');
    expect(await fs.readFile(backupPath!, 'utf8')).toContain('"x"');
  });
});
