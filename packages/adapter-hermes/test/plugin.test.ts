import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_INIT = path.join(__dirname, '..', 'plugin', '__init__.py');
const DRIVER = path.join(__dirname, 'plugin-driver.py');
const FIXTURES_AGENT_DIR = path.join(__dirname, 'fixtures'); // contains a fake agent/model_metadata.py

const PYTHON_AVAILABLE = spawnSync('python3', ['--version']).status === 0;

function runHook(action: string, kwargs: unknown, envOverrides: Record<string, string | undefined>) {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONPATH: '', ...envOverrides };
  const result = spawnSync('python3', [DRIVER, PLUGIN_INIT, action], {
    input: JSON.stringify(kwargs),
    encoding: 'utf8',
    env,
  });
  if (result.status !== 0) {
    throw new Error(`plugin-driver.py exited ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as { returned: unknown };
}

describe.skipIf(!PYTHON_AVAILABLE)('Hermes helper plugin (Python, real child process)', () => {
  let batonpassDir: string;

  beforeEach(async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-hermes-plugin-'));
    batonpassDir = path.join(cwd, '.batonpass');
    await fs.mkdir(batonpassDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(path.dirname(batonpassDir), { recursive: true, force: true });
  });

  it('post_api_request is inert when BATONPASS_DIR is unset', () => {
    runHook('post_api_request', { model: 'known-model', base_url: 'https://x', usage: { prompt_tokens: 500 } }, {
      BATONPASS_DIR: undefined,
    });
    return expect(fs.stat(path.join(batonpassDir, 'usage.json'))).rejects.toThrow();
  });

  it('post_api_request is inert when BATONPASS_DIR points at a nonexistent directory', () => {
    runHook('post_api_request', { model: 'known-model', usage: { prompt_tokens: 500 } }, {
      BATONPASS_DIR: path.join(batonpassDir, 'does-not-exist'),
    });
    return expect(fs.stat(path.join(batonpassDir, 'usage.json'))).rejects.toThrow();
  });

  it('post_api_request writes usage.json with pct=null when the context length is not cached', async () => {
    runHook('post_api_request', { model: 'unknown-model', base_url: 'https://x', usage: { prompt_tokens: 500 } }, {
      BATONPASS_DIR: batonpassDir,
    });
    const data = JSON.parse(await fs.readFile(path.join(batonpassDir, 'usage.json'), 'utf8'));
    expect(data).toMatchObject({ pct: null, tokens: 500, max: null, source: 'hermes-post-api-request' });
    expect(typeof data.updatedAt).toBe('string');
  });

  it('post_api_request computes pct = tokens/max when the context length is cached (agent.model_metadata reachable)', async () => {
    runHook('post_api_request', { model: 'known-model', base_url: 'https://x', usage: { prompt_tokens: 25000 } }, {
      BATONPASS_DIR: batonpassDir,
      PYTHONPATH: FIXTURES_AGENT_DIR,
    });
    const data = JSON.parse(await fs.readFile(path.join(batonpassDir, 'usage.json'), 'utf8'));
    expect(data).toMatchObject({ pct: 0.25, tokens: 25000, max: 100000 });
  });

  it('post_api_request does nothing (no throw, no file) when usage.prompt_tokens is absent', async () => {
    runHook('post_api_request', { model: 'known-model', usage: {} }, { BATONPASS_DIR: batonpassDir });
    await expect(fs.stat(path.join(batonpassDir, 'usage.json'))).rejects.toThrow();
  });

  it('post_llm_call writes a turn-idle marker with session/turn ids', async () => {
    runHook('post_llm_call', { session_id: 's1', turn_id: 't1' }, { BATONPASS_DIR: batonpassDir });
    const data = JSON.parse(await fs.readFile(path.join(batonpassDir, 'turn-idle'), 'utf8'));
    expect(data).toMatchObject({ sessionId: 's1', turnId: 't1' });
    expect(typeof data.idleAt).toBe('string');
  });

  it('on_session_start resets a stale usage.json left by a previous session', async () => {
    await fs.writeFile(
      path.join(batonpassDir, 'usage.json'),
      JSON.stringify({ pct: 0.9, tokens: 180000, max: 200000, source: 'stale', updatedAt: 'x' }),
    );
    runHook('on_session_start', { session_id: 's2', model: 'known-model', platform: 'cli' }, { BATONPASS_DIR: batonpassDir });
    const data = JSON.parse(await fs.readFile(path.join(batonpassDir, 'usage.json'), 'utf8'));
    expect(data).toMatchObject({ pct: null, tokens: 0, max: null, source: 'hermes-session-start-reset' });
  });

  it('/baton command writes a manual-handoff-requested marker and confirms', async () => {
    const { returned } = runHook('command:baton', { raw_args: '' }, { BATONPASS_DIR: batonpassDir });
    expect(returned).toBe('Batonpass: handoff requested.');
    await expect(fs.stat(path.join(batonpassDir, 'manual-handoff-requested'))).resolves.toBeTruthy();
  });

  it('/baton command reports inactivity without writing anything when BATONPASS_DIR is unset', () => {
    const { returned } = runHook('command:baton', { raw_args: '' }, { BATONPASS_DIR: undefined });
    expect(returned).toContain('not active');
  });
});
