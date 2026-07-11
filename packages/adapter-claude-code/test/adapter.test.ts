import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/index.js';
import { batonpassScriptsInstallDir, projectSettingsPath } from '../src/paths.js';

describe('ClaudeCodeAdapter (project scope)', () => {
  let cwd: string;
  let adapter: ClaudeCodeAdapter;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-adapter-'));
    adapter = new ClaudeCodeAdapter();
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('is not installed before install()', async () => {
    expect(await adapter.isInstalled('project', cwd)).toBe(false);
  });

  it('install() copies scripts and registers hooks + statusline', async () => {
    const { backedUpFiles } = await adapter.install('project', cwd);
    expect(backedUpFiles).toEqual([]); // nothing pre-existing to back up

    expect(await adapter.isInstalled('project', cwd)).toBe(true);

    const scriptsDir = batonpassScriptsInstallDir('project', cwd);
    expect(await fs.stat(path.join(scriptsDir, 'session-start.mjs'))).toBeTruthy();
    expect(await fs.stat(path.join(scriptsDir, '_lib.mjs'))).toBeTruthy();

    const settings = JSON.parse(await fs.readFile(projectSettingsPath(cwd), 'utf8'));
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('session-start.mjs');
  });

  it('install() is idempotent and backs up settings.json on the second run', async () => {
    await adapter.install('project', cwd);
    const { backedUpFiles } = await adapter.install('project', cwd);
    expect(backedUpFiles).toHaveLength(1);

    const settings = JSON.parse(await fs.readFile(projectSettingsPath(cwd), 'utf8'));
    expect(settings.hooks.SessionStart).toHaveLength(1); // still no duplicates
  });

  it('install() adds .batonpass/ to .gitignore only in a git repo', async () => {
    await fs.mkdir(path.join(cwd, '.git'));
    await adapter.install('project', cwd);
    const gitignore = await fs.readFile(path.join(cwd, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.batonpass/');
  });

  it('uninstall() removes Batonpass hooks/statusline and the scripts dir', async () => {
    await adapter.install('project', cwd);
    await adapter.uninstall('project', cwd);
    expect(await adapter.isInstalled('project', cwd)).toBe(false);

    const scriptsDir = batonpassScriptsInstallDir('project', cwd);
    await expect(fs.stat(scriptsDir)).rejects.toThrow();
  });

  it('spawnCommand returns bare `claude` with no args', () => {
    expect(adapter.spawnCommand({ cwd })).toEqual({ cmd: 'claude', args: [] });
  });

  it('gracefulExitKeys returns /exit\\r', () => {
    expect(adapter.gracefulExitKeys()).toBe('/exit\r');
  });

  it('resumeInjection is session-start-hook', () => {
    expect(adapter.resumeInjection()).toBe('session-start-hook');
  });

  it('injectHandoffPrompt writes the handoff prompt then a carriage return', async () => {
    const written: string[] = [];
    await adapter.injectHandoffPrompt({ write: (d: string) => written.push(d) }, '/tmp/h.md');
    expect(written[0]).toContain('/tmp/h.md');
    expect(written[1]).toBe('\r');
  });

  it('isTurnIdle is false with no marker, true once one is written after `since`', async () => {
    const sinceMs = Date.now();
    const session = { cwd, sessionId: 's1', sinceMs };
    expect(await adapter.isTurnIdle(session)).toBe(false);

    await fs.mkdir(path.join(cwd, '.batonpass'), { recursive: true });
    await fs.writeFile(
      path.join(cwd, '.batonpass', 'turn-idle'),
      JSON.stringify({ idleAt: new Date(sinceMs + 1000).toISOString() }),
    );
    expect(await adapter.isTurnIdle(session)).toBe(true);
  });

  it('isTurnIdle is false for a marker written before `since` (stale from a prior turn)', async () => {
    const sinceMs = Date.now();
    await fs.mkdir(path.join(cwd, '.batonpass'), { recursive: true });
    await fs.writeFile(
      path.join(cwd, '.batonpass', 'turn-idle'),
      JSON.stringify({ idleAt: new Date(sinceMs - 5000).toISOString() }),
    );
    expect(await adapter.isTurnIdle({ cwd, sessionId: 's1', sinceMs })).toBe(false);
  });
});
