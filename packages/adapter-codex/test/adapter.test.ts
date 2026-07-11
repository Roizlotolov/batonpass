import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../src/index.js';
import { batonpassHooksInstallDir, projectHooksJsonPath, userConfigTomlPath } from '../src/paths.js';

describe('CodexAdapter (project scope)', () => {
  let cwd: string;
  let homedir: string;
  let adapter: CodexAdapter;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-codex-adapter-'));
    homedir = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-codex-home-'));
    vi.spyOn(os, 'homedir').mockReturnValue(homedir);
    adapter = new CodexAdapter();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(homedir, { recursive: true, force: true });
  });

  it('is not installed before install()', async () => {
    expect(await adapter.isInstalled('project', cwd)).toBe(false);
  });

  it('install() copies hook scripts, registers hooks.json, and enables the config.toml feature flag', async () => {
    const { backedUpFiles } = await adapter.install('project', cwd);
    expect(backedUpFiles).toEqual([]);

    const hooksDir = batonpassHooksInstallDir('project', cwd);
    expect(await fs.stat(path.join(hooksDir, 'session-start.mjs'))).toBeTruthy();
    expect(await fs.stat(path.join(hooksDir, 'stop.mjs'))).toBeTruthy();

    const hooksJson = JSON.parse(await fs.readFile(projectHooksJsonPath(cwd), 'utf8'));
    expect(hooksJson.hooks.SessionStart[0].matcher).toBe('startup|resume');

    const configText = await fs.readFile(userConfigTomlPath(homedir), 'utf8');
    expect(configText).toContain('codex_hooks = true');

    expect(await adapter.isInstalled('project', cwd)).toBe(true);
  });

  it('install() backs up an existing config.toml rather than clobbering it silently', async () => {
    const configPath = userConfigTomlPath(homedir);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, '[model]\nname = "gpt-5"\n');

    const { backedUpFiles } = await adapter.install('project', cwd);
    expect(backedUpFiles.some((f) => f.includes('config.toml.bak-'))).toBe(true);

    const configText = await fs.readFile(configPath, 'utf8');
    expect(configText).toContain('name = "gpt-5"'); // preserved
    expect(configText).toContain('codex_hooks = true'); // added
  });

  it('install() does not rewrite config.toml when the flag is already enabled', async () => {
    const configPath = userConfigTomlPath(homedir);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, '[features]\ncodex_hooks = true\n');

    const { backedUpFiles } = await adapter.install('project', cwd);
    expect(backedUpFiles.some((f) => f.includes('config.toml'))).toBe(false);
  });

  it('uninstall() removes Batonpass hooks and the hooks dir but leaves config.toml alone', async () => {
    await adapter.install('project', cwd);
    await adapter.uninstall('project', cwd);
    expect(await adapter.isInstalled('project', cwd)).toBe(false);

    const configText = await fs.readFile(userConfigTomlPath(homedir), 'utf8');
    expect(configText).toContain('codex_hooks = true'); // deliberately not reverted

    await expect(fs.stat(batonpassHooksInstallDir('project', cwd))).rejects.toThrow();
  });

  it('spawnCommand returns bare `codex`', () => {
    expect(adapter.spawnCommand({ cwd })).toEqual({ cmd: 'codex', args: [] });
  });

  it('gracefulExitKeys returns Ctrl-D (EOT)', () => {
    expect(adapter.gracefulExitKeys()).toBe('\x04');
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

  it('isTurnIdle respects the `since` timestamp the same way the Claude adapter does', async () => {
    const sinceMs = Date.now();
    await fs.mkdir(path.join(cwd, '.batonpass'), { recursive: true });
    await fs.writeFile(
      path.join(cwd, '.batonpass', 'turn-idle'),
      JSON.stringify({ idleAt: new Date(sinceMs + 1000).toISOString() }),
    );
    expect(await adapter.isTurnIdle({ cwd, sessionId: 's1', sinceMs })).toBe(true);
    expect(await adapter.isTurnIdle({ cwd, sessionId: 's1', sinceMs: sinceMs + 5000 })).toBe(false);
  });

  it('install() throws a clear error on win32 instead of silently no-oping', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    await expect(adapter.install('project', cwd)).rejects.toThrow(/Windows/);
  });
});
