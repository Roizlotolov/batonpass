import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(__dirname, '..', 'plugin', 'scripts');

function runHook(scriptName: string, stdin: unknown): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [path.join(SCRIPTS_DIR, scriptName)], {
    input: JSON.stringify(stdin),
    encoding: 'utf8',
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe('session-start.mjs', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-hooktest-'));
  });
  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('does nothing (exit 0, empty stdout) when there is no pendingHandoff', () => {
    const { stdout, status } = runHook('session-start.mjs', { cwd, session_id: 's1', source: 'startup' });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('injects additionalContext and clears pendingHandoff when one exists', async () => {
    const handoffDir = path.join(cwd, '.batonpass', 'handoffs', '1-2026-07-11T12-00-00-000Z');
    await fs.mkdir(handoffDir, { recursive: true });
    await fs.writeFile(
      path.join(handoffDir, 'handoff.md'),
      '# Handoff 1\n\n## Objective\n\nDo the thing.\n',
    );
    await fs.mkdir(path.join(cwd, '.batonpass'), { recursive: true });
    await fs.writeFile(
      path.join(cwd, '.batonpass', 'state.json'),
      JSON.stringify({ pendingHandoff: '1-2026-07-11T12-00-00-000Z' }),
    );

    const { stdout, status } = runHook('session-start.mjs', { cwd, session_id: 's2', source: 'startup' });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Do the thing.');
    expect(parsed.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(10_000);

    const state = JSON.parse(await fs.readFile(path.join(cwd, '.batonpass', 'state.json'), 'utf8'));
    expect(state.pendingHandoff).toBeNull();
  });

  it('truncates an oversized handoff to fit the 10,000-char additionalContext cap', async () => {
    const handoffDir = path.join(cwd, '.batonpass', 'handoffs', '1-x');
    await fs.mkdir(handoffDir, { recursive: true });
    const huge = '# Handoff 1\n\n## Objective\n\n' + 'x'.repeat(20_000);
    await fs.writeFile(path.join(handoffDir, 'handoff.md'), huge);
    await fs.mkdir(path.join(cwd, '.batonpass'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.batonpass', 'state.json'), JSON.stringify({ pendingHandoff: '1-x' }));

    const { stdout } = runHook('session-start.mjs', { cwd, session_id: 's2' });
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(10_000);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('truncated');
  });

  it('does not throw when the referenced handoff dir is missing', () => {
    // pendingHandoff points at a dir that was never created
    return fs
      .mkdir(path.join(cwd, '.batonpass'), { recursive: true })
      .then(() => fs.writeFile(path.join(cwd, '.batonpass', 'state.json'), JSON.stringify({ pendingHandoff: 'ghost' })))
      .then(() => {
        const { status, stdout } = runHook('session-start.mjs', { cwd, session_id: 's3' });
        expect(status).toBe(0);
        expect(stdout.trim()).toBe('');
      });
  });
});

describe('pre-compact.mjs', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-hooktest-'));
  });
  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('exits 0 for a manual trigger regardless of orchestrator state', () => {
    const { status } = runHook('pre-compact.mjs', { cwd, trigger: 'manual', session_id: 's1' });
    expect(status).toBe(0);
  });

  it('exits 0 for an auto trigger when no orchestrator is running', () => {
    const { status } = runHook('pre-compact.mjs', { cwd, trigger: 'auto', session_id: 's1' });
    expect(status).toBe(0);
  });

  it('exits 2 and writes compact-blocked marker for an auto trigger when the orchestrator PID is alive', async () => {
    await fs.mkdir(path.join(cwd, '.batonpass'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.batonpass', 'state.json'), JSON.stringify({ orchestratorPid: process.pid }));

    const { status } = runHook('pre-compact.mjs', { cwd, trigger: 'auto', session_id: 's1' });
    expect(status).toBe(2);

    const marker = JSON.parse(await fs.readFile(path.join(cwd, '.batonpass', 'compact-blocked'), 'utf8'));
    expect(marker.sessionId).toBe('s1');
  });

  it('exits 0 for an auto trigger when the recorded orchestrator PID is dead', async () => {
    await fs.mkdir(path.join(cwd, '.batonpass'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.batonpass', 'state.json'), JSON.stringify({ orchestratorPid: 999_999 }));

    const { status } = runHook('pre-compact.mjs', { cwd, trigger: 'auto', session_id: 's1' });
    expect(status).toBe(0);
  });
});

describe('stop.mjs', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-hooktest-'));
  });
  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('writes a turn-idle marker with a timestamp', async () => {
    const { status } = runHook('stop.mjs', { cwd, session_id: 's1' });
    expect(status).toBe(0);
    const marker = JSON.parse(await fs.readFile(path.join(cwd, '.batonpass', 'turn-idle'), 'utf8'));
    expect(marker.sessionId).toBe('s1');
    expect(new Date(marker.idleAt).getTime()).toBeGreaterThan(0);
  });
});

describe('session-end.mjs', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-hooktest-'));
  });
  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('removes an existing turn-idle marker', async () => {
    await fs.mkdir(path.join(cwd, '.batonpass'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.batonpass', 'turn-idle'), '{}');
    const { status } = runHook('session-end.mjs', { cwd, session_id: 's1' });
    expect(status).toBe(0);
    await expect(fs.stat(path.join(cwd, '.batonpass', 'turn-idle'))).rejects.toThrow();
  });

  it('does not throw when there is no marker to remove', () => {
    const { status } = runHook('session-end.mjs', { cwd, session_id: 's1' });
    expect(status).toBe(0);
  });
});

describe('statusline.mjs', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-hooktest-'));
  });
  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('writes usage.json from context_window fields and prints a statusline', async () => {
    const { stdout, status } = runHook('statusline.mjs', {
      cwd,
      model: { display_name: 'Claude Sonnet 5' },
      context_window: { used_percentage: 0.42, context_window_size: 200_000 },
    });
    expect(status).toBe(0);
    expect(stdout).toContain('Claude Sonnet 5');

    const usage = JSON.parse(await fs.readFile(path.join(cwd, '.batonpass', 'usage.json'), 'utf8'));
    expect(usage.max).toBe(200_000);
    expect(usage.pct).toBeCloseTo(0.42);
    expect(usage.tokens).toBe(84_000);
  });

  it('chains an existing statusline command via BATON_CHAIN_STATUSLINE_COMMAND', () => {
    const result = spawnSync('node', [path.join(SCRIPTS_DIR, 'statusline.mjs')], {
      input: JSON.stringify({ cwd, context_window: { used_percentage: 0.1, context_window_size: 100 } }),
      encoding: 'utf8',
      env: { ...process.env, BATON_CHAIN_STATUSLINE_COMMAND: 'echo chained-output' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('chained-output');
  });

  it('does not throw on malformed / missing context_window', () => {
    const { status } = runHook('statusline.mjs', { cwd });
    expect(status).toBe(0);
  });
});

describe('session-start.mjs security: unsafe pendingHandoff values', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'batonpass-hooktest-'));
  });
  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('refuses a path-traversal pendingHandoff value instead of reading outside .batonpass/handoffs', async () => {
    await fs.mkdir(path.join(cwd, '.batonpass'), { recursive: true });
    // Plant a secret file outside the handoffs dir that a traversal would reach.
    await fs.writeFile(path.join(cwd, 'secret.md'), 'TOP SECRET CONTENT');
    await fs.writeFile(
      path.join(cwd, '.batonpass', 'state.json'),
      JSON.stringify({ pendingHandoff: '../../secret' }),
    );

    const { stdout, status, stderr } = runHook('session-start.mjs', { cwd, session_id: 's1' });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
    expect(stderr).toContain('unsafe pendingHandoff');
  });
});
