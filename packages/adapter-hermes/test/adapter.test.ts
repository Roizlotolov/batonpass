import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HermesAdapter } from '../src/index.js';
import { batonpassPluginInstallDir, hermesConfigYamlPath } from '../src/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_HERMES_BIN_DIR = path.join(__dirname, 'fixtures', 'fake-hermes-bin');

describe('HermesAdapter (user scope only)', () => {
  let cwd: string;
  let homedir: string;
  let fakeHermesLog: string;
  let originalPath: string | undefined;
  let adapter: HermesAdapter;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-hermes-adapter-'));
    homedir = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-hermes-home-'));
    vi.spyOn(os, 'homedir').mockReturnValue(homedir);

    fakeHermesLog = path.join(cwd, 'fake-hermes.log');
    process.env.FAKE_HERMES_LOG = fakeHermesLog;
    delete process.env.FAKE_HERMES_ENABLE_EXIT_CODE;
    delete process.env.HERMES_HOME;
    originalPath = process.env.PATH;
    process.env.PATH = `${FAKE_HERMES_BIN_DIR}${path.delimiter}${originalPath ?? ''}`;

    adapter = new HermesAdapter();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env.PATH = originalPath;
    delete process.env.FAKE_HERMES_LOG;
    delete process.env.FAKE_HERMES_ENABLE_EXIT_CODE;
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(homedir, { recursive: true, force: true });
  });

  it('detectInstalled is true when `hermes --version` succeeds', async () => {
    expect(await adapter.detectInstalled()).toBe(true);
  });

  it('is not installed before install()', async () => {
    expect(await adapter.isInstalled('user', cwd)).toBe(false);
  });

  it('isInstalled() is true once the plugin dir exists and config.yaml lists it enabled', async () => {
    const pluginDir = batonpassPluginInstallDir(homedir);
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, '__init__.py'), '');
    const configPath = hermesConfigYamlPath(homedir);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, 'plugins:\n  enabled:\n  - batonpass\n');

    expect(await adapter.isInstalled('user', cwd)).toBe(true);
  });

  it('isInstalled() is always false for project scope (Hermes has no project scope)', async () => {
    expect(await adapter.isInstalled('project', cwd)).toBe(false);
  });

  it('install() copies the plugin, enables it (shelling out with --no-allow-tool-override), and raises the compression threshold', async () => {
    const { backedUpFiles } = await adapter.install('user', cwd);
    expect(backedUpFiles).toEqual([]); // no pre-existing config.yaml to back up

    const pluginDir = batonpassPluginInstallDir(homedir);
    expect(await fs.stat(path.join(pluginDir, 'plugin.yaml'))).toBeTruthy();
    expect(await fs.stat(path.join(pluginDir, '__init__.py'))).toBeTruthy();

    const log = await fs.readFile(fakeHermesLog, 'utf8');
    expect(log).toContain('plugins enable batonpass --no-allow-tool-override');

    const configText = await fs.readFile(hermesConfigYamlPath(homedir), 'utf8');
    expect(configText).toContain('threshold: 0.9');
    expect(configText).toContain('batonpass: raised threshold');

    expect(await adapter.isInstalled('user', cwd)).toBe(false); // fake hermes doesn't actually register the plugin as enabled in config.yaml
  });

  it('install() backs up an existing config.yaml with a threshold below 0.9', async () => {
    const configPath = hermesConfigYamlPath(homedir);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, 'compression:\n  threshold: 0.5\n');

    const { backedUpFiles } = await adapter.install('user', cwd);
    expect(backedUpFiles.some((f) => f.includes('config.yaml.bak-'))).toBe(true);

    const configText = await fs.readFile(configPath, 'utf8');
    expect(configText).toContain('threshold: 0.9');
    expect(configText).toContain('(was 0.5)');
  });

  it('install() does not touch config.yaml when the threshold is already >= 0.9', async () => {
    const configPath = hermesConfigYamlPath(homedir);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, 'compression:\n  threshold: 0.95\n');

    const { backedUpFiles } = await adapter.install('user', cwd);
    expect(backedUpFiles).toEqual([]);
    const configText = await fs.readFile(configPath, 'utf8');
    expect(configText).toBe('compression:\n  threshold: 0.95\n');
  });

  it('install() throws a clear, actionable error when `hermes plugins enable` fails', async () => {
    process.env.FAKE_HERMES_ENABLE_EXIT_CODE = '1';
    await expect(adapter.install('user', cwd)).rejects.toThrow(/plugins enable batonpass/);
  });

  it("install() throws when scope is 'project' (Hermes has no project scope)", async () => {
    await expect(adapter.install('project', cwd)).rejects.toThrow(/project-scope/);
  });

  it('install() throws a clear error on win32 instead of silently no-oping', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    await expect(adapter.install('user', cwd)).rejects.toThrow(/Windows/);
  });

  it('uninstall() reverts the threshold override (marker present) and removes the plugin dir', async () => {
    await adapter.install('user', cwd);
    await adapter.uninstall('user', cwd);

    const configText = await fs.readFile(hermesConfigYamlPath(homedir), 'utf8');
    expect(configText).not.toContain('batonpass: raised threshold');
    await expect(fs.stat(batonpassPluginInstallDir(homedir))).rejects.toThrow();
  });

  it('uninstall() leaves a user-set threshold alone (no batonpass marker to find)', async () => {
    const configPath = hermesConfigYamlPath(homedir);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, 'compression:\n  threshold: 0.95\n'); // already high enough, install() won't touch it
    await adapter.install('user', cwd);
    await adapter.uninstall('user', cwd);

    const configText = await fs.readFile(configPath, 'utf8');
    expect(configText).toBe('compression:\n  threshold: 0.95\n');
  });

  it('spawnCommand returns bare `hermes`', () => {
    expect(adapter.spawnCommand({ cwd })).toEqual({ cmd: 'hermes', args: [] });
  });

  it('gracefulExitKeys returns /quit\\r', () => {
    expect(adapter.gracefulExitKeys()).toBe('/quit\r');
  });

  it('resumeInjection is pty-type', () => {
    expect(adapter.resumeInjection()).toBe('pty-type');
  });

  it('injectHandoffPrompt writes the handoff prompt then a carriage return', async () => {
    const written: string[] = [];
    await adapter.injectHandoffPrompt({ write: (d: string) => written.push(d) }, '/tmp/h.md');
    expect(written[0]).toContain('/tmp/h.md');
    expect(written[1]).toBe('\r');
  });

  it('isTurnIdle respects the `since` timestamp the same way the other adapters do', async () => {
    const sinceMs = Date.now();
    await fs.mkdir(path.join(cwd, '.batonpass'), { recursive: true });
    await fs.writeFile(
      path.join(cwd, '.batonpass', 'turn-idle'),
      JSON.stringify({ idleAt: new Date(sinceMs + 1000).toISOString() }),
    );
    expect(await adapter.isTurnIdle({ cwd, sessionId: 's1', sinceMs })).toBe(true);
    expect(await adapter.isTurnIdle({ cwd, sessionId: 's1', sinceMs: sinceMs + 5000 })).toBe(false);
  });

  it('usageSource reads .batonpass/usage.json and returns null when the context length is not yet cached', async () => {
    await fs.mkdir(path.join(cwd, '.batonpass'), { recursive: true });
    await fs.writeFile(
      path.join(cwd, '.batonpass', 'usage.json'),
      JSON.stringify({ pct: null, tokens: 500, max: null, source: 'hermes-post-api-request', updatedAt: new Date().toISOString() }),
    );
    const usage = adapter.usageSource({ cwd, sessionId: 's1', sinceMs: 0 });
    expect(await usage.getUsage()).toBeNull();
  });

  it('usageSource reads pct/tokens/max once the context length is cached', async () => {
    await fs.mkdir(path.join(cwd, '.batonpass'), { recursive: true });
    await fs.writeFile(
      path.join(cwd, '.batonpass', 'usage.json'),
      JSON.stringify({ pct: 0.25, tokens: 25000, max: 100000, source: 'hermes-post-api-request', updatedAt: new Date().toISOString() }),
    );
    const usage = adapter.usageSource({ cwd, sessionId: 's1', sinceMs: 0 });
    expect(await usage.getUsage()).toEqual({ pct: 0.25, tokens: 25000, max: 100000, source: 'hermes-post-api-request' });
  });
});
